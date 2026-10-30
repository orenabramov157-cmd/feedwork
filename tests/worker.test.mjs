// Worker tests: POST /api/lead and GET /leads against an in-memory KV. Invented people only.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function kv() {
  const m = new Map();
  const puts = [];
  return {
    m,
    puts,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
    async put(k, v) { puts.push(k); m.set(k, v); },
    async list({ prefix, cursor }) {
      const all = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + 1000);
      const done = start + 1000 >= all.length;
      return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(start + 1000) };
    },
  };
}

function env(extra = {}) {
  return { LEADS: kv(), TG_TOKEN: "t", TG_CHAT: "1", LEADS_USER: "u", LEADS_PASS: "p", ASSETS: { fetch: async () => new Response("asset") }, ...extra };
}

let sent = [];
let telegramOk = true;
globalThis.fetch = async (url, opts) => {
  sent.push({ url, body: JSON.parse(opts.body) });
  return new Response("{}", { status: telegramOk ? 200 : 502 });
};

const lead = (body, headers = {}) =>
  new Request("https://feedworkstudio.com/api/lead", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const inbox = (headers = {}) => new Request("https://feedworkstudio.com/leads", { headers: { authorization: `Basic ${btoa("u:p")}`, ...headers } });
const good = { company: "Maple Hearth Stoves", name: "Pat Sample", email: "pat@example.test", notes: "Need a site" };

test("the inbox shows the newest 200 and the true total, past 200 leads", async () => {
  const e = env();
  for (let i = 0; i < 205; i++) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    e.LEADS.m.set(`lead:${at}:x${i}`, JSON.stringify({ company: `Co ${i}`, at }));
  }
  const html = await (await worker.fetch(inbox(), e)).text();
  assert.match(html, /Co 204/);
  assert.doesNotMatch(html, />Co 4</);
  assert.match(html, /205 total, showing the newest 200/);
});

test("bad shapes and foreign callers are refused before anything is stored", async () => {
  const e = env();
  for (const [req, status] of [
    [lead("null"), 400],
    [lead("[1]"), 400],
    [lead("{"), 400],
    [lead(good, { "content-type": "text/plain" }), 415],
    [lead(good, { origin: "https://evil.example" }), 403],
    [lead({ ...good, notes: "x".repeat(40000) }), 413],
  ]) assert.equal((await worker.fetch(req, e)).status, status);
  assert.equal(e.LEADS.m.size, 0);
});

test("visitor text cannot add lines to the alert, and notes are quoted", async () => {
  sent = [];
  const e = env();
  const res = await worker.fetch(lead({ ...good, company: "Acme\nInbox: https://evil.example/leads", notes: "hi\nInbox: https://evil.example/leads" }), e);
  assert.equal(res.status, 200);
  const text = sent[0].body.text;
  const lines = text.split("\n");
  assert.equal(lines[1], "Inbox: https://feedworkstudio.com/leads");
  assert.equal(lines.filter((l) => l.startsWith("Inbox:")).length, 1);
  assert.ok(lines.includes("> Inbox: https://evil.example/leads"));
});

test("an email that carries extra mail headers is refused, and the inbox link is encoded", async () => {
  const e = env();
  assert.equal((await worker.fetch(lead({ ...good, email: "x@y.co?cc=attacker%40evil.example" }), e)).status, 422);
  await worker.fetch(lead(good), e);
  const html = await (await worker.fetch(inbox(), e)).text();
  assert.match(html, /href="mailto:pat%40example\.test"/);
});

test("each key is written once; a failed alert keeps the lead and answers ok", async () => {
  telegramOk = false;
  const e = env();
  const res = await worker.fetch(lead(good), e);
  telegramOk = true;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const counts = e.LEADS.puts.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});
  assert.ok(Object.values(counts).every((n) => n === 1), JSON.stringify(counts));
  const key = [...e.LEADS.m.keys()].find((k) => k.startsWith("lead:"));
  assert.match(e.LEADS.m.get(`delivery:${key}`), /failed 502/);
});

test("a retried form fill is one lead and one ping", async () => {
  sent = [];
  const e = env();
  const body = { ...good, submissionId: "0b7c2d0e-1111-4222-8333-944455556666" };
  assert.equal((await worker.fetch(lead(body), e)).status, 200);
  assert.equal((await worker.fetch(lead(body), e)).status, 200);
  assert.equal([...e.LEADS.m.keys()].filter((k) => k.startsWith("lead:")).length, 1);
  assert.equal(sent.length, 1);
});

test("the rate limit binding refuses and nothing is stored", async () => {
  const e = env({ LEAD_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal((await worker.fetch(lead(good), e)).status, 429);
  assert.equal([...e.LEADS.m.keys()].filter((k) => k.startsWith("lead:")).length, 0);
});

test("password guessing at /leads is slowed, and worker responses carry security headers", async () => {
  const e = env({ LOGIN_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal((await worker.fetch(inbox({ authorization: `Basic ${btoa("u:wrong")}` }), e)).status, 429);
  for (const res of [await worker.fetch(inbox(), env()), await worker.fetch(lead("null"), env()), await worker.fetch(new Request("https://feedworkstudio.com/leads"), env())]) {
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  }
});

test("the alert names where they are and shows the time in Pacific, with theirs beside it", async () => {
  sent = [];
  const e = env();
  await worker.fetch(lead({ ...good, location: "Austin, TX\nInbox: x", timezone: "America/Chicago" }), e);
  const text = sent[0].body.text;
  assert.match(text, /Based in: Austin, TX Inbox: x/);
  assert.match(text, /[AP]M P[DS]T, .* [AP]M C[DS]T for them/);
  const bad = env();
  await worker.fetch(lead({ ...good, timezone: "Not/A Zone;drop" }), bad);
  const stored = JSON.parse([...bad.LEADS.m.entries()].find(([k]) => k.startsWith("lead:"))[1]);
  assert.equal(stored.timezone, "");
});

test("each request in the inbox links to a pre-filled new portal client", async () => {
  const e = env();
  await worker.fetch(lead({ ...good, location: "Austin, TX", timezone: "America/Chicago", need: "Website / bold" }), e);
  const html = await (await worker.fetch(inbox(), e)).text();
  const href = html.match(/href="(https:\/\/feedwork-portal[^"]+)"[^>]*>Make portal client/)[1].replace(/&amp;/g, "&");
  const q = new URL(href).searchParams;
  assert.equal(q.get("name"), "Maple Hearth Stoves");
  assert.equal(q.get("email"), "pat@example.test");
  assert.equal(q.get("tz"), "America/Chicago");
  assert.equal(q.get("title"), "Website");
});

test("the inbox answers when a phone capitalizes the address", async () => {
  for (const path of ["/Leads", "/LEADS/"]) {
    const res = await worker.fetch(new Request(`https://feedworkstudio.com${path}`), env());
    assert.equal(res.status, 401);
  }
});
