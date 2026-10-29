/* Feedwork Studio worker.
   Static assets are served by the ASSETS binding. Two routes are handled here:
     POST /api/lead   a project request from the form in #start
     GET  /leads      the inbox for those requests, behind basic auth
   Every request is written to KV first and only then mailed, so a mail outage
   never loses a lead. */

const MAX = { name: 120, company: 160, email: 160, phone: 40, product: 200, website: 200, notes: 4000 };
const RATE = { max: 10, windowSeconds: 3600 };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function clean(value, limit) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, limit);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function rateLimited(env, ip) {
  if (!ip) return false;
  const key = `rate:${ip}`;
  const current = Number((await env.LEADS.get(key)) || 0);
  if (current >= RATE.max) return true;
  await env.LEADS.put(key, String(current + 1), { expirationTtl: RATE.windowSeconds });
  return false;
}

function leadText(lead) {
  const lines = [
    `Company:  ${lead.company || "-"}`,
    `Name:     ${lead.name || "-"}`,
    `Email:    ${lead.email || "-"}`,
    `Phone:    ${lead.phone || "-"}`,
    `Product:  ${lead.product || "-"}`,
    `Website:  ${lead.website || "-"}`,
    "",
    lead.notes || "(no notes)",
    "",
    `Received: ${lead.at}`,
    `Page:     ${lead.page || "-"}`,
  ];
  if (lead.prospectToken) lines.push(`Cold-email token: ${lead.prospectToken}`);
  return lines.join("\n");
}

async function mail(env, lead) {
  if (!env.RESEND_API_KEY || !env.LEAD_TO) return "not configured";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.LEAD_FROM || "Feedwork Studio <leads@feedworkstudio.com>",
        to: [env.LEAD_TO],
        reply_to: lead.email || undefined,
        subject: `Project request: ${lead.company || lead.name || "no name given"}`,
        text: leadText(lead),
      }),
    });
    return res.ok ? "sent" : `failed ${res.status}`;
  } catch (err) {
    return `failed ${err && err.message ? err.message : "fetch error"}`;
  }
}

async function postLead(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "";

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Bad request." }, 400);
  }

  /* a bot that fills the hidden field gets a success it cannot tell from the real one */
  if (clean(body.fax, 40)) return json({ ok: true });

  const lead = {
    company: clean(body.company, MAX.company),
    name: clean(body.name, MAX.name),
    email: clean(body.email, MAX.email),
    phone: clean(body.phone, MAX.phone),
    product: clean(body.product, MAX.product),
    website: clean(body.website, MAX.website),
    notes: clean(body.notes, MAX.notes),
    prospectToken: /^[a-z0-9]{6,12}$/.test(String(body.prospectToken || "")) ? String(body.prospectToken) : "",
    page: clean(body.page, 200),
    at: new Date().toISOString(),
    ip,
    country: request.headers.get("cf-ipcountry") || "",
  };

  if (!lead.company) return json({ ok: false, error: "Tell me the business name." }, 422);
  if (!lead.email && !lead.phone) return json({ ok: false, error: "Leave an email or a phone number." }, 422);
  if (lead.email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(lead.email)) return json({ ok: false, error: "That email doesn't look right." }, 422);

  /* counted only once the request is real, so a visitor fumbling their own email
     never burns the allowance */
  if (await rateLimited(env, ip)) {
    return json({ ok: false, error: "That is a lot of requests from one place. Call instead." }, 429);
  }

  const key = `lead:${lead.at}:${crypto.randomUUID().slice(0, 8)}`;
  await env.LEADS.put(key, JSON.stringify(lead));
  const mailed = await mail(env, lead);
  await env.LEADS.put(key, JSON.stringify({ ...lead, mailed }));

  return json({ ok: true });
}

function unauthorized() {
  return new Response("Authentication required.", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Feedwork leads", charset="UTF-8"' },
  });
}

function authorized(request, env) {
  if (!env.LEADS_USER || !env.LEADS_PASS) return false;
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const at = decoded.indexOf(":");
  if (at < 0) return false;
  return decoded.slice(0, at) === env.LEADS_USER && decoded.slice(at + 1) === env.LEADS_PASS;
}

async function leadsPage(request, env) {
  if (!authorized(request, env)) return unauthorized();

  const list = await env.LEADS.list({ prefix: "lead:", limit: 200 });
  const keys = list.keys.map((k) => k.name).sort().reverse();
  /* a key can outlive its value for a moment after a delete, so drop the blanks
     before anything counts them */
  const leads = (await Promise.all(keys.map((k) => env.LEADS.get(k, "json")))).filter(Boolean);

  const rows = leads
    .map((l) => {
      const who = escapeHtml(l.company || l.name || "no name given");
      const when = escapeHtml(new Date(l.at).toLocaleString("en-US", { timeZone: "America/Chicago" }));
      const reach = [
        l.email ? `<a href="mailto:${escapeHtml(l.email)}">${escapeHtml(l.email)}</a>` : "",
        l.phone ? `<a href="tel:${escapeHtml(l.phone.replace(/[^+\d]/g, ""))}">${escapeHtml(l.phone)}</a>` : "",
        l.website ? `<a href="${escapeHtml(l.website.startsWith("http") ? l.website : "https://" + l.website)}" rel="noopener nofollow">site</a>` : "",
      ].filter(Boolean).join(" &nbsp;·&nbsp; ");
      return `<article>
  <h2>${who}</h2>
  <p class="meta">${when} CT${l.prospectToken ? ` &nbsp;·&nbsp; token ${escapeHtml(l.prospectToken)}` : ""}${l.mailed && l.mailed !== "sent" ? ` &nbsp;·&nbsp; mail ${escapeHtml(l.mailed)}` : ""}</p>
  <p class="reach">${reach || "no contact given"}</p>
  ${l.name ? `<p><b>Contact</b> ${escapeHtml(l.name)}</p>` : ""}
  ${l.product ? `<p><b>Product</b> ${escapeHtml(l.product)}</p>` : ""}
  ${l.notes ? `<p class="notes">${escapeHtml(l.notes)}</p>` : ""}
</article>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Leads · Feedwork</title>
<style>
body{background:#F4F0E6;color:#151310;font:16px/1.5 system-ui,sans-serif;margin:0;padding:28px 18px 60px}
.wrap{max-width:760px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
.count{color:#6B655A;font-size:14px;margin:0 0 24px}
article{background:#fff;border:1px solid rgba(21,19,16,.18);padding:18px 20px;margin-bottom:14px}
h2{font-size:19px;margin:0 0 4px}
.meta{color:#6B655A;font-size:13px;margin:0 0 10px}
.reach{margin:0 0 10px;font-weight:600}
p{margin:0 0 7px}
b{color:#6B655A;font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:.08em;margin-right:6px}
.notes{white-space:pre-wrap;border-left:3px solid #1B48C9;padding-left:12px;margin-top:12px}
a{color:#1B48C9}
</style></head><body><div class="wrap">
<h1>Project requests</h1>
<p class="count">${leads.length} total${list.list_complete ? "" : ", showing the newest 200"}</p>
${rows || "<article><p>Nothing yet.</p></article>"}
</div></body></html>`;

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/lead") {
      if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
      return postLead(request, env);
    }

    if (url.pathname === "/leads" || url.pathname === "/leads/") return leadsPage(request, env);

    return env.ASSETS.fetch(request);
  },
};
