/* Feedwork Studio worker.
   Static assets are served by the ASSETS binding. Two routes are handled here:
     POST /api/lead   a project request from the form in #start
     GET  /leads      the inbox for those requests, behind basic auth
   Every request is written to KV once, before anything else happens, and only then
   sent to Telegram and mail, so an outage on either never loses a lead. A KV key is
   written at most once per request: KV allows one write per key per second. */

const MAX = { name: 120, company: 160, email: 160, phone: 40, product: 200, website: 200, location: 120, need: 40, notes: 4000 };
const OREN_TZ = "America/Los_Angeles";

/* a real IANA zone name from the visitor's browser, or nothing */
function zone(value) {
  const z = typeof value === "string" ? value.trim().slice(0, 60) : "";
  if (!/^[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(z)) return "";
  try { new Intl.DateTimeFormat("en-US", { timeZone: z }); return z; } catch { return ""; }
}

/* "Oct 29, 2026, 4:18 PM PDT": Oren reads every time in Pacific, the client's own time sits beside it */
function at(iso, tz = OREN_TZ) {
  return new Date(iso).toLocaleString("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }) + " " +
    (new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName")?.value || "");
}
function theirTime(lead) {
  return lead.timezone && lead.timezone !== OREN_TZ ? `, ${at(lead.at, lead.timezone)} for them` : "";
}
const RATE = { max: 10, windowSeconds: 3600 };
const MAX_BODY = 32 * 1024;
const ORIGINS = ["https://feedworkstudio.com", "https://www.feedworkstudio.com"];
const EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/* Worker responses get the same protections _headers gives the static pages */
const SECURITY = {
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/* line breaks and direction overrides let a visitor fake extra lines in the alert */
const BREAKS = /[\r\n\u2028\u2029\u0085]+/g;
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function clean(value, limit) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(BIDI, "").trim().slice(0, limit);
}

/* every field except the notes is one line */
function line(value, limit) {
  return clean(typeof value === "string" ? value.replace(BREAKS, " ") : value, limit);
}

/* visitor notes, quoted line by line so they can never pass for the alert's own lines */
function quoted(notes) {
  return notes.split("\n").map((l) => `> ${l}`).join("\n");
}

/* IPv6 visitors can rotate within their /64, so they are counted by it */
function clientKey(ip) {
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function rateLimited(env, ip) {
  if (!ip) return false;
  /* the binding counts atomically, so parallel requests cannot all slip under it;
     the KV count below stays as the hourly ceiling */
  if (env.LEAD_LIMITER) {
    const { success } = await env.LEAD_LIMITER.limit({ key: `lead:${ip}` });
    if (!success) return true;
  }
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
    `Needs:    ${lead.need || "-"}`,
    `Website:  ${lead.website || "-"}`,
    `Based in: ${lead.location || "-"}${lead.timezone ? ` (${lead.timezone})` : ""}`,
    "",
    lead.notes ? `Notes, as typed by the visitor:\n${quoted(lead.notes)}` : "(no notes)",
    "",
    `Received: ${at(lead.at)}${theirTime(lead)}`,
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

/* plain text, no parse_mode, so nothing a visitor types can break the message */
function telegramText(lead) {
  const who = [lead.name, lead.company].filter(Boolean).join(" at ");
  const lines = [
    "New project request",
    "Inbox: https://feedworkstudio.com/leads",
    "",
    "Typed by the visitor:",
    `Who: ${who}`,
    `Wants: ${lead.need || "not said"}`,
  ];
  if (lead.product) lines.push(`Product: ${lead.product}`);
  if (lead.website) lines.push(`Their site: ${lead.website}`);
  if (lead.location) lines.push(`Based in: ${lead.location}`);
  lines.push("");
  if (lead.email) lines.push(`Email: ${lead.email}`);
  if (lead.phone) lines.push(`Phone: ${lead.phone}`);
  if (lead.notes) lines.push("", "Notes:", quoted(lead.notes.length > 2500 ? `${lead.notes.slice(0, 2500)}...` : lead.notes));
  lines.push("", `${at(lead.at)}${theirTime(lead)}${lead.country ? `, ${lead.country}` : ""}`);
  if (lead.page) lines.push(`Sent from: ${lead.page}`);
  if (lead.prospectToken) lines.push(`Cold-email token: ${lead.prospectToken}`);
  return lines.join("\n");
}

async function telegram(env, lead) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return "not configured";
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT, text: telegramText(lead), disable_web_page_preview: true }),
    });
    return res.ok ? "sent" : `failed ${res.status}`;
  } catch (err) {
    return `failed ${err && err.message ? err.message : "fetch error"}`;
  }
}

async function postLead(request, env) {
  const ip = clientKey(request.headers.get("cf-connecting-ip") || "");

  /* the form sends JSON from this site; a JSON content type also makes browsers on
     other sites ask permission first, which this Worker never grants */
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return json({ ok: false, error: "Bad request." }, 415);
  const origin = request.headers.get("origin");
  const host = new URL(request.url).hostname;
  if (origin && !ORIGINS.includes(origin) && !["127.0.0.1", "localhost"].includes(host)) return json({ ok: false, error: "Not allowed." }, 403);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ ok: false, error: "That is too long. Email it instead." }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "Bad request." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "Bad request." }, 400);

  /* a bot that fills the hidden field gets a success it cannot tell from the real one */
  if (clean(body.fax, 40)) return json({ ok: true });

  const lead = {
    company: line(body.company, MAX.company),
    name: line(body.name, MAX.name),
    email: line(body.email, MAX.email),
    phone: line(body.phone, MAX.phone),
    product: line(body.product, MAX.product),
    need: line(body.need, MAX.need),
    website: line(body.website, MAX.website),
    location: line(body.location, MAX.location),
    timezone: zone(body.timezone),
    notes: clean(body.notes, MAX.notes),
    prospectToken: /^[a-z0-9]{6,12}$/.test(String(body.prospectToken || "")) ? String(body.prospectToken) : "",
    page: line(body.page, 200),
    at: new Date().toISOString(),
    ip,
    country: request.headers.get("cf-ipcountry") || "",
  };

  if (!lead.company) return json({ ok: false, error: "Tell me the business name." }, 422);
  if (!lead.email && !lead.phone) return json({ ok: false, error: "Leave an email or a phone number." }, 422);
  if (lead.email && !EMAIL.test(lead.email)) return json({ ok: false, error: "That email doesn't look right." }, 422);

  /* counted only once the request is real, so a visitor fumbling their own email
     never burns the allowance */
  if (await rateLimited(env, ip)) {
    return json({ ok: false, error: "That is a lot of requests from one place. Call instead." }, 429);
  }

  /* a retry of the same form fill (same submission id) is answered without a second
     lead or a second ping */
  const submission = /^[A-Za-z0-9-]{8,64}$/.test(String(body.submissionId || "")) ? String(body.submissionId) : "";
  if (submission && (await env.LEADS.get(`sub:${submission}`))) return json({ ok: true });

  const key = `lead:${lead.at}:${crypto.randomUUID().slice(0, 8)}`;
  await env.LEADS.put(key, JSON.stringify(lead));
  if (submission) await env.LEADS.put(`sub:${submission}`, key, { expirationTtl: 86400 });

  /* the lead is saved; from here on a failure is recorded on its own key and never
     turns into an error for the visitor */
  try {
    const [telegrammed, mailed] = await Promise.all([telegram(env, lead), mail(env, lead)]);
    if (telegrammed !== "sent" || (mailed !== "sent" && mailed !== "not configured")) {
      await env.LEADS.put(`delivery:${key}`, JSON.stringify({ telegrammed, mailed }));
    }
  } catch (err) {
    console.error("lead delivery bookkeeping failed", err && err.message);
  }

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
  /* every attempt that carries a password is counted, so guessing is slow */
  if (env.LOGIN_LIMITER && request.headers.get("authorization")) {
    const ip = clientKey(request.headers.get("cf-connecting-ip") || "");
    const { success } = await env.LOGIN_LIMITER.limit({ key: `login:${ip}` });
    if (!success) return new Response("Too many tries. Wait a minute.", { status: 429, headers: { "retry-after": "60" } });
  }
  if (!authorized(request, env)) return unauthorized();

  /* KV lists oldest first, so walk every page and keep the newest 200 */
  const names = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const list = await env.LEADS.list({ prefix: "lead:", cursor });
    names.push(...list.keys.map((k) => k.name));
    if (list.list_complete) break;
    cursor = list.cursor;
  }
  const keys = names.sort().reverse().slice(0, 200);
  /* a key can outlive its value for a moment after a delete, so drop the blanks
     before anything counts them */
  const leads = (
    await Promise.all(
      keys.map(async (k) => {
        const [l, delivery] = await Promise.all([env.LEADS.get(k, "json"), env.LEADS.get(`delivery:${k}`, "json")]);
        return l && { ...l, ...(delivery || {}) };
      }),
    )
  ).filter(Boolean);

  const rows = leads
    .map((l) => {
      const who = escapeHtml(l.company || l.name || "no name given");
      const when = escapeHtml(at(l.at) + theirTime(l));
      const reach = [
        l.email ? `<a href="mailto:${escapeHtml(encodeURIComponent(l.email))}">${escapeHtml(l.email)}</a>` : "",
        l.phone ? `<a href="tel:${escapeHtml(l.phone.replace(/[^+\d]/g, ""))}">${escapeHtml(l.phone)}</a>` : "",
        l.website ? `<a href="${escapeHtml(l.website.startsWith("http") ? l.website : "https://" + l.website)}" rel="noopener nofollow">site</a>` : "",
      ].filter(Boolean).join(" &nbsp;·&nbsp; ");
      return `<article>
  <h2>${who}</h2>
  <p class="meta">${when}${l.prospectToken ? ` &nbsp;·&nbsp; token ${escapeHtml(l.prospectToken)}` : ""}${l.telegrammed && l.telegrammed !== "sent" ? ` &nbsp;·&nbsp; telegram ${escapeHtml(l.telegrammed)}` : ""}${l.mailed && l.mailed !== "sent" ? ` &nbsp;·&nbsp; mail ${escapeHtml(l.mailed)}` : ""}</p>
  <p class="reach">${reach || "no contact given"}</p>
  ${l.name ? `<p><b>Contact</b> ${escapeHtml(l.name)}</p>` : ""}
  ${l.product ? `<p><b>Product</b> ${escapeHtml(l.product)}</p>` : ""}
  ${l.location ? `<p><b>Based in</b> ${escapeHtml(l.location)}</p>` : ""}
  ${l.need ? `<p><b>Needs</b> ${escapeHtml(l.need)}</p>` : ""}
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
<p class="count">${names.length} total${names.length > leads.length ? `, showing the newest ${leads.length}` : ""}</p>
${rows || "<article><p>Nothing yet.</p></article>"}
</div></body></html>`;

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
}

function secured(response) {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/lead") {
      if (request.method !== "POST") return secured(json({ ok: false, error: "Use POST." }, 405));
      try {
        return secured(await postLead(request, env));
      } catch (err) {
        console.error("lead failed", err && err.message);
        return secured(json({ ok: false, error: "Your request could not be sent." }, 500));
      }
    }

    if (url.pathname === "/leads" || url.pathname === "/leads/") return secured(await leadsPage(request, env));

    return env.ASSETS.fetch(request);
  },
};
