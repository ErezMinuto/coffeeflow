// Concurrency test for resend-webhook's campaign counters, run against a fake
// PostgREST that answers slowly enough for overlapping webhooks to interleave.
//
//   deno run --allow-net --allow-env supabase/functions/resend-webhook/index_test.ts
//
// The handler used to read open_count, add 1 in JS and write it back, so two
// opens arriving together counted once. It now calls increment_campaign_stat,
// which the fake applies atomically, as Postgres does. The fake also records any
// direct write to campaigns, which must no longer happen.

const PORT_DB = 8793;
const PORT_FN = 8000;   // std@0.168.0 serve() default
const SECRET_BYTES = new TextEncoder().encode("resend-webhook-test-secret");
const SECRET = "whsec_" + btoa(String.fromCharCode(...SECRET_BYTES));

Deno.env.set("SUPABASE_URL", `http://localhost:${PORT_DB}`);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role");
Deno.env.set("RESEND_WEBHOOK_SECRET", SECRET);

// ── the fake backend ────────────────────────────────────────────────────────

const CAMPAIGN_ID = 42;
let campaign = { id: CAMPAIGN_ID, open_count: 0, click_count: 0, bounce_count: 0 } as Record<string, number>;
let events: Array<Record<string, unknown>> = [];
let rpcCalls: string[] = [];
let campaignWrites = 0;

function reset() {
  campaign = { id: CAMPAIGN_ID, open_count: 0, click_count: 0, bounce_count: 0 };
  events = [];
  rpcCalls = [];
  campaignWrites = 0;
}

const jitter = () => new Promise(r => setTimeout(r, Math.random() * 15));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve({ port: PORT_DB, onListen() {} }, async (req) => {
  const url = new URL(req.url);
  const p = url.searchParams;
  await jitter();

  if (url.pathname === "/rest/v1/campaign_events" && req.method === "GET") {
    const id = (p.get("resend_email_id") ?? "").replace(/^eq\./, "");
    const type = (p.get("event_type") ?? "").replace(/^eq\./, "");
    if (type === "sent") {
      const row = id.startsWith("sent-") ? { campaign_id: CAMPAIGN_ID, user_id: "u1" } : null;
      return row ? json(row) : json({ code: "PGRST116", message: "no rows" }, 406);
    }
    return json(events.filter(e => e.resend_email_id === id && e.event_type === type).map(() => ({ id: 1 })));
  }
  if (url.pathname === "/rest/v1/campaign_events" && req.method === "POST") {
    events.push(await req.json());
    return new Response(null, { status: 201 });
  }
  if (url.pathname === "/rest/v1/rpc/increment_campaign_stat" && req.method === "POST") {
    const { p_campaign_id, p_column } = await req.json();
    rpcCalls.push(p_column);
    if (!["open_count", "click_count", "bounce_count"].includes(p_column)) {
      return json({ code: "22023", message: "column not allowed" }, 400);
    }
    if (p_campaign_id !== CAMPAIGN_ID) return json(null);
    campaign[p_column] += 1;   // single step, like UPDATE … SET c = c + 1
    return json(campaign[p_column]);
  }
  if (url.pathname === "/rest/v1/campaigns") {
    if (req.method === "PATCH") {
      // The old code path: write back whatever JS computed from its earlier read.
      campaignWrites++;
      Object.assign(campaign, await req.json());
    }
    return json(req.headers.get("accept")?.includes("object") ? campaign : [campaign]);
  }
  if (url.pathname === "/rest/v1/marketing_contacts") return json([]);
  return json({ message: `unexpected ${req.method} ${url.pathname}` }, 404);
});

await import("./index.ts");

// ── helpers ─────────────────────────────────────────────────────────────────

async function sign(id: string, ts: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", SECRET_BYTES, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  return "v1," + btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function webhook(type: string, emailId: string): Promise<number> {
  const body = JSON.stringify({ type, data: { email_id: emailId, to: ["a@example.com"] } });
  const id = crypto.randomUUID();
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`http://localhost:${PORT_FN}/`, {
    method: "POST",
    body,
    headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": await sign(id, ts, body) },
  });
  await res.body?.cancel();
  return res.status;
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ── tests ───────────────────────────────────────────────────────────────────

{
  reset();
  const N = 25;
  const statuses = await Promise.all(
    Array.from({ length: N }, (_, i) => webhook(i % 5 === 0 ? "email.clicked" : "email.opened", `sent-${i}`)),
  );
  check("all concurrent webhooks answered 200", statuses.every(s => s === 200), statuses.join(","));
  check("every open counted", campaign.open_count === 20, `open_count=${campaign.open_count}`);
  check("every click counted", campaign.click_count === 5, `click_count=${campaign.click_count}`);
  check("no read-then-write on campaigns", campaignWrites === 0, `PATCH count=${campaignWrites}`);
}

{
  reset();
  const statuses = await Promise.all([
    webhook("email.delivered", "sent-1"),   // not a counted event
    webhook("email.opened", "orphan-1"),    // no campaign behind it
  ]);
  check("uncounted events still answered 200", statuses.every(s => s === 200), statuses.join(","));
  check("no counter call without a counted event + campaign", rpcCalls.length === 0, rpcCalls.join(","));
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
Deno.exit(failures === 0 ? 0 : 1);
