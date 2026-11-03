// deno test supabase/functions/email-automation-scheduler/retention_test.ts
import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  checkinOrder, type CustomerOrder, DAY_MS, emailedRecently, hasMarketingConsent, hasUnsubscribed,
  inSendWindow, median, reminderDue, remindersStopped, stopToken,
} from "./retention.ts";

const NOW = Date.parse("2026-10-25T07:00:00Z");
const ago = (d: number) => new Date(NOW - d * DAY_MS).toISOString();
let id = 1;
const order = (p: Partial<CustomerOrder>): CustomerOrder => ({
  woo_order_id: id++, status: "completed", date_created: ago(30), date_completed: ago(29),
  has_beans: true, email_norm: "a@b.com", first_name: "דנה", marketing_consent: null, ...p,
});
const CHECKIN = { delay_days: 9, window_days: 5 };
const RULE = { min_orders: 3, cadence_factor: 0.85, min_cadence_days: 7, max_cadence_days: 120, grace_days: 7 };

Deno.test("median", () => {
  assertEquals(median([]), null);
  assertEquals(median([5]), 5);
  assertEquals(median([30, 10, 20]), 20);
  assertEquals(median([10, 20, 30, 100]), 25);   // one long gap doesn't skew it
});

Deno.test("checkin: exactly one paid order, 9–14 days after completion", () => {
  assertEquals(checkinOrder([order({ date_completed: ago(9) })], NOW, CHECKIN)?.status, "completed");
  assertEquals(checkinOrder([order({ date_completed: ago(14) })], NOW, CHECKIN) !== null, true);
  assertEquals(checkinOrder([order({ date_completed: ago(8) })], NOW, CHECKIN), null);   // too early
  assertEquals(checkinOrder([order({ date_completed: ago(15) })], NOW, CHECKIN), null);  // backlog: never
  assertEquals(checkinOrder([order({ date_completed: null, status: "processing" })], NOW, CHECKIN), null);
  assertEquals(checkinOrder([order({ date_completed: ago(10), has_beans: false })], NOW, CHECKIN), null); // equipment only
});

Deno.test("checkin: a second order, refunds and cancellations", () => {
  const first = order({ date_completed: ago(10) });
  assertEquals(checkinOrder([first, order({ date_created: ago(2) })], NOW, CHECKIN), null); // now 2 orders
  // a cancelled/refunded extra order doesn't count, so it's still a first-timer
  assert(checkinOrder([first, order({ status: "cancelled" }), order({ status: "refunded" })], NOW, CHECKIN));
  // only a refunded order: not a buyer
  assertEquals(checkinOrder([order({ status: "refunded", date_completed: ago(10) })], NOW, CHECKIN), null);
});

Deno.test("reminder: needs 3+ paid orders and 2+ bean orders", () => {
  const two = [order({ date_created: ago(40) }), order({ date_created: ago(20) })];
  assertEquals(reminderDue(two, RULE), null);
  const threeOneBean = [order({ date_created: ago(60), has_beans: false }), order({ date_created: ago(40), has_beans: false }), order({ date_created: ago(20) })];
  assertEquals(reminderDue(threeOneBean, RULE), null);
});

Deno.test("reminder: median gap × 0.85 from the last bean order", () => {
  const os = [order({ date_created: ago(60) }), order({ date_created: ago(40) }), order({ date_created: ago(20) })];
  const r = reminderDue(os, RULE)!;
  assertEquals(Math.round(r.cadence_days), 17);                  // 20 × 0.85
  assertEquals(r.last_bean_order.woo_order_id, os[2].woo_order_id);
  assert(inSendWindow(NOW + 0 * DAY_MS + (r.due_at - NOW), r.due_at, 7));
  assert(!inSendWindow(r.due_at - DAY_MS, r.due_at, 7));         // not yet
  assert(!inSendWindow(r.due_at + 8 * DAY_MS, r.due_at, 7));     // missed: no late nag
});

Deno.test("reminder: ordering first moves the cycle", () => {
  const os = [order({ date_created: ago(60) }), order({ date_created: ago(40) }), order({ date_created: ago(20) })];
  const before = reminderDue(os, RULE)!;
  const after = reminderDue([...os, order({ date_created: ago(1) })], RULE)!;
  assert(after.due_at > before.due_at);
  assert(!inSendWindow(NOW, after.due_at, 7));
});

Deno.test("reminder: same-day split orders and out-of-range rhythms", () => {
  const split = [order({ date_created: ago(40) }), order({ date_created: ago(40) }), order({ date_created: ago(20) })];
  assertEquals(Math.round(reminderDue(split, RULE)!.cadence_days), 17);   // the 0-day gap is ignored
  const tooFast = [order({ date_created: ago(6) }), order({ date_created: ago(4) }), order({ date_created: ago(2) })];
  assertEquals(reminderDue(tooFast, RULE), null);
  const tooSlow = [order({ date_created: ago(600) }), order({ date_created: ago(400) }), order({ date_created: ago(200) })];
  assertEquals(reminderDue(tooSlow, RULE), null);
});

Deno.test("consent: latest event wins; an unticked box is not a withdrawal", () => {
  assertEquals(hasMarketingConsent([]), false);
  assertEquals(hasMarketingConsent([{ at: ago(30), granted: true }]), true);
  assertEquals(hasMarketingConsent([{ at: ago(30), granted: true }, { at: ago(5), granted: false }]), false);
  assertEquals(hasMarketingConsent([{ at: ago(30), granted: false }, { at: ago(5), granted: true }]), true); // re-opted at checkout
  assertEquals(hasUnsubscribed([{ at: ago(30), granted: true }, { at: ago(5), granted: false }]), true);
  assertEquals(hasUnsubscribed([]), false);
});

Deno.test("stop reminders: latest action wins", () => {
  assertEquals(remindersStopped([]), false);
  assertEquals(remindersStopped([{ at: ago(3), action: "stop" }]), true);
  assertEquals(remindersStopped([{ at: ago(3), action: "stop" }, { at: ago(1), action: "resume" }]), false);
});

Deno.test("4-day rule", () => {
  assertEquals(emailedRecently(ago(3.9), NOW), true);
  assertEquals(emailedRecently(ago(4.1), NOW), false);
  assertEquals(emailedRecently(null, NOW), false);
});

Deno.test("stop token: stable per customer, differs by customer and key", async () => {
  const a = await stopToken("k1", "c-1");
  assertEquals(a, await stopToken("k1", "c-1"));
  assert(a !== await stopToken("k1", "c-2"));
  assert(a !== await stopToken("k2", "c-1"));
  assert(/^[A-Za-z0-9_-]+$/.test(a));    // URL-safe
});
