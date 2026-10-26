// deno test supabase/functions/email-automation-scheduler/retention_data_test.ts
import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { findCheckinCandidates, findReminderCandidates, type RetentionData } from "./retention_data.ts";
import { DAY_MS, stopToken } from "./retention.ts";

const NOW = Date.parse("2026-10-25T07:00:00Z");
const ago = (d: number) => new Date(NOW - d * DAY_MS).toISOString();
let n = 1;
// deno-lint-ignore no-explicit-any
const o = (p: any) => ({
  woo_order_id: n++, customer_id: "c", status: "completed", date_created: ago(30), date_completed: ago(29),
  has_beans: true, email_norm: "a@b.com", first_name: "דנה", marketing_consent: null, consent_at: null,
  lines: [{ product_id: 7, is_bean: true, name: "Aristo" }], ...p,
});
function data(over: Partial<RetentionData> = {}): RetentionData {
  return {
    now: NOW, orders: new Map(), emails: new Map(), consent: new Map(), prefs: new Map(),
    lastSent: new Map(), sentKeys: new Set(), products: new Map([[7, { permalink: "https://www.minuto.co.il/p/aristo/", name: "Aristo", image_url: "https://img/aristo.png" }]]),
    ...over,
  };
}
const unsub = (e: string) => `https://u/?e=${e}`;
const CHECKIN = { delay_days: 9, max_lookback_days: 14, settings: { review_url: "https://g.page/r/x/review", review_link_enabled: false } };
const REM_OPTS = { stopBase: "https://f/sched", signingKey: "k", unsubscribeUrlFor: unsub };
const regular = () => [o({ date_created: ago(60) }), o({ date_created: ago(40) }), o({ date_created: ago(20) })]; // due ~day 17 → in window

Deno.test("checkin: one person with two emails is asked once", () => {
  const d = data({
    orders: new Map([["c1", [o({ date_completed: ago(10), email_norm: "new@x.com" })]]]),
    emails: new Map([["c1", ["old@x.com", "new@x.com"]]]),
    sentKeys: new Set(["coffee_checkin::old@x.com"]),          // asked before under the other address
  });
  assertEquals(findCheckinCandidates(d, CHECKIN, unsub).length, 0);
});

Deno.test("checkin: review block only when enabled; unsubscribed and 4-day rule skip", () => {
  const base = { orders: new Map([["c1", [o({ date_completed: ago(10) })]]]), emails: new Map([["c1", ["a@b.com"]]]) };
  const [c] = findCheckinCandidates(data(base), CHECKIN, unsub);
  assertEquals(c.extra_vars.review_block_html, "");
  const [c2] = findCheckinCandidates(data(base), { ...CHECKIN, settings: { ...CHECKIN.settings, review_link_enabled: true } }, unsub);
  assert(c2.extra_vars.review_block_html.includes("https://g.page/r/x/review"));
  assert(!/אם נהנית|אם אהבת/.test(c2.extra_vars.review_block_html)); // never conditional on liking it
  assertEquals(findCheckinCandidates(data({ ...base, consent: new Map([["c1", [{ at: ago(50), granted: true }, { at: ago(5), granted: false }]]]) }), CHECKIN, unsub).length, 0);
  assertEquals(findCheckinCandidates(data({ ...base, lastSent: new Map([["a@b.com", ago(2)]]) }), CHECKIN, unsub).length, 0);
});

Deno.test("reminder: consent required; stop wins; one per cycle", async () => {
  const base = { orders: new Map([["c1", regular()]]), emails: new Map([["c1", ["a@b.com"]]]) };
  assertEquals((await findReminderCandidates(data(base), {}, REM_OPTS)).length, 0);                 // no consent
  const consented = { ...base, consent: new Map([["c1", [{ at: ago(100), granted: true }]]]) };
  const [c] = await findReminderCandidates(data(consented), {}, REM_OPTS);
  assertEquals(c.woo_order_id, base.orders.get("c1")![2].woo_order_id);                             // keyed on the last bean order
  assertEquals(c.extra_vars.stop_reminders_url, `https://f/sched?action=stop_reminders&c=c1&t=${await stopToken("k", "c1")}`);
  assertEquals(c.list_unsubscribe_url, c.extra_vars.stop_reminders_url);
  assert(c.extra_vars.shop_url.startsWith("https://www.minuto.co.il/p/aristo/?utm_source=email"));
  const stopped = { ...consented, prefs: new Map([["c1", [{ at: ago(3), action: "stop" as const }]]]) };
  assertEquals((await findReminderCandidates(data(stopped), {}, REM_OPTS)).length, 0);
  const already = { ...consented, sentKeys: new Set([`refill_reminder::a@b.com::${c.woo_order_id}`]) };
  assertEquals((await findReminderCandidates(data(already), {}, REM_OPTS)).length, 0);
});

Deno.test("reminder: checkout consent counts; resold coffee links to the shop, not the product", async () => {
  const os = regular(); os[2].marketing_consent = true; os[2].consent_at = ago(20);
  os[2].lines = [{ product_id: 9, is_bean: true, name: "Veneto" }];
  const d = data({ orders: new Map([["c1", os]]), emails: new Map([["c1", ["a@b.com"]]]),
    consent: new Map([["c1", [{ at: ago(20), granted: true }]]]),
    products: new Map([[9, { permalink: "https://www.minuto.co.il/p/veneto/", name: "1 ק״ג פולי קפה Veneto Delux", image_url: "https://img/veneto.png" }]]) });
  const [c] = await findReminderCandidates(d, {}, REM_OPTS);
  assert(c.extra_vars.shop_url.startsWith("https://www.minuto.co.il/shop/?"));
});

Deno.test("product photo: every Minuto bag in the order, side by side, Veneto left out", () => {
  const lines = [
    { product_id: 7, is_bean: true, name: "Aristo" }, { product_id: 8, is_bean: true, name: "Fazenda" },
    { product_id: 7, is_bean: true, name: "Aristo" }, { product_id: 9, is_bean: true, name: "Veneto" },
  ]
  const d = data({ orders: new Map([["c1", [o({ date_completed: ago(10), lines })]]]), emails: new Map([["c1", ["a@b.com"]]]),
    products: new Map([
      [7, { permalink: "https://p/aristo/", name: "Aristo", image_url: "https://img/aristo.png" }],
      [8, { permalink: "https://p/fazenda/", name: "Fazenda Sertão", image_url: "https://img/fazenda.png" }],
      [9, { permalink: "https://p/veneto/", name: "1 ק״ג פולי קפה Veneto Delux", image_url: "https://img/veneto.png" }],
    ]) });
  const html = findCheckinCandidates(d, CHECKIN, unsub)[0].extra_vars.product_block_html;
  assert(html.includes('src="https://img/aristo.png"') && html.includes('src="https://img/fazenda.png"'));
  assert(!html.includes("veneto"));
  assertEquals(html.match(/<img /g)?.length, 2);
});

Deno.test("product photo: the coffee they bought; never Veneto in a reminder; none without an image", async () => {
  const base = { orders: new Map([["c1", [o({ date_completed: ago(10) })]]]), emails: new Map([["c1", ["a@b.com"]]]) };
  const [c] = findCheckinCandidates(data(base), CHECKIN, unsub);
  assert(c.extra_vars.product_block_html.includes('src="https://img/aristo.png"'));
  const noImg = data({ ...base, products: new Map([[7, { permalink: "https://p/", name: "Aristo", image_url: null }]]) });
  assertEquals(findCheckinCandidates(noImg, CHECKIN, unsub)[0].extra_vars.product_block_html, "");
  const veneto = data({ orders: new Map([["c1", [o({ date_completed: ago(10), lines: [{ product_id: 9, is_bean: true, name: "Veneto" }] })]]]), emails: new Map([["c1", ["a@b.com"]]]),
    products: new Map([[9, { permalink: "https://p/veneto/", name: "1 ק״ג פולי קפה Veneto Delux", image_url: "https://img/veneto.png" }]]) });
  assertEquals(findCheckinCandidates(veneto, CHECKIN, unsub)[0].extra_vars.product_block_html, "");   // still asked, never pictured
  const os = regular(); os[2].lines = [{ product_id: 9, is_bean: true, name: "Veneto" }];
  const d = data({ orders: new Map([["c1", os]]), emails: new Map([["c1", ["a@b.com"]]]), consent: new Map([["c1", [{ at: ago(90), granted: true }]]]),
    products: new Map([[9, { permalink: "https://p/veneto/", name: "Veneto Delux", image_url: "https://img/veneto.png" }]]) });
  assertEquals((await findReminderCandidates(d, {}, REM_OPTS))[0].extra_vars.product_block_html, "");
});
