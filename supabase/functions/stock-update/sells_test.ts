// Tests for stock-update's MFlow sells → packed_stock path.
//
//   deno run --allow-read supabase/functions/stock-update/sells_test.ts
//
// The fake rpc implements apply_mflow_sells the way the Postgres function does:
// claim each sell id once, apply only the claimed sells' deltas. Overlapping
// runs therefore interleave the way they do in production. The SQL side has its
// own check against real rows: scripts/ci/mflow_sells_apply_check.sql.
//
// The last checks read index.ts and fail if the handler goes back to moving
// stock and recording sells in separate requests.

import { applySells, channelOfSell, toEventRows, type SellToApply } from "./sells.ts";
import { buildUnloggedEmail } from "./alerts.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 10));

function fakeDb(opts: { failRpc?: boolean } = {}) {
  const packed: Record<number, number> = { 7: 20, 8: 1 };
  const recorded = new Set<number>();
  const calls: string[] = [];
  const client = {
    async rpc(fn: string, args: Record<string, any>) {
      calls.push(fn);
      await jitter();
      if (fn !== "apply_mflow_sells") return { data: null, error: { message: `unexpected rpc ${fn}` } };
      if (opts.failRpc) return { data: null, error: { message: "boom" } };
      const claimed: number[] = [];
      const net = new Map<number, number>();
      for (const row of args.p_sells) {
        if (recorded.has(row.mflow_sell_id)) continue;
        recorded.add(row.mflow_sell_id);
        claimed.push(row.mflow_sell_id);
        for (const [k, v] of Object.entries(row.coffee_delta)) net.set(Number(k), (net.get(Number(k)) ?? 0) + Number(v));
      }
      const adjustments = [];
      for (const [pid, dq] of net) {
        const before = packed[pid];
        packed[pid] = Math.max(0, before + dq);
        adjustments.push({ cf_product: pid, delta: dq, packed_before: before, packed_after: packed[pid], units_lost: packed[pid] - (before + dq) });
      }
      return { data: { claimed, already_recorded: args.p_sells.length - claimed.length, skipped_missing_product: [], failed_products: [], adjustments }, error: null };
    },
  };
  return { client, packed, recorded, calls };
}

const sell = (id: number, delta: Record<number, number>): SellToApply => ({
  id, type: "sell", status: "Completed", isReturn: false, source: "POS", channel: "store", date: "2026-10-24",
  delta: new Map(Object.entries(delta).map(([k, v]) => [Number(k), v])),
});

// Two overlapping syncs over the same window deduct each sale once.
{
  const db = fakeDb();
  const batch = [sell(1, { 7: -2 }), sell(2, { 7: -3, 8: -1 })];
  const [a, b] = await Promise.all([applySells(db.client, batch, "run a"), applySells(db.client, batch, "run b")]);
  check("overlapping runs: stock deducted once", db.packed[7] === 15 && db.packed[8] === 0, `p7=${db.packed[7]} p8=${db.packed[8]}`);
  check("overlapping runs: each sell claimed by exactly one run",
    a.claimed.length + b.claimed.length === 2 && a.alreadyRecorded + b.alreadyRecorded === 2);
  check("one rpc per run, nothing else", db.calls.length === 2 && db.calls.every((c) => c === "apply_mflow_sells"));
}

// A clamp is surfaced as a positive count.
{
  const db = fakeDb();
  const r = await applySells(db.client, [sell(3, { 8: -4 })], "clamp");
  check("clamp reported", r.clamped.length === 1 && r.clamped[0].units_lost === 3, JSON.stringify(r.clamped));
}

// An RPC failure is an error, not a silent "applied".
{
  const db = fakeDb({ failRpc: true });
  const r = await applySells(db.client, [sell(4, { 7: -1 })], "fail");
  check("rpc failure surfaces an error", r.error === "boom" && r.claimed.length === 0);
}

// Nothing to apply → no rpc.
{
  const db = fakeDb();
  const r = await applySells(db.client, [], "empty");
  check("empty batch makes no call", db.calls.length === 0 && r.error === null);
}

// Channel: website orders may back-order; everything else is a shelf sale.
{
  check("woo order id → web", channelOfSell({ sell_source: "POS", woocommerce_order_id: 123 }) === "web");
  check("EcoSite source → web", channelOfSell({ sell_source: "EcoSite - Minuto" }) === "web");
  check("POS → store", channelOfSell({ sell_source: "POS 1" }) === "store");
  check("back office → store", channelOfSell({ sell_source: "Back Office" }) === "store");
  check("unknown → store (alerting side)", channelOfSell({}) === "store");
  check("empty woo id ignored", channelOfSell({ sell_source: "POS", woocommerce_order_id: "" }) === "store");
  const rows = toEventRows([{ ...sell(9, { 7: -1 }), channel: "web" }]);
  check("channel sent to the rpc", rows[0].channel === "web");
}

// Store sales past the shelf come back as `unlogged`.
{
  const client = { async rpc() { return { data: { claimed: [5], unlogged: [{ cf_product: 8, mflow_sell_id: 5, units: 2, packed_before: 0, transaction_date: "2026-11-09T09:00:00Z" }], adjustments: [] }, error: null }; } };
  const r = await applySells(client, [sell(5, { 8: -2 })], "unlogged");
  check("unlogged parsed", r.unlogged.length === 1 && r.unlogged[0].units === 2 && r.unlogged[0].cf_product === 8);
}

// Owner email.
{
  const one = buildUnloggedEmail([{ id: 1, product_id: 8, alert_date: "2026-11-09", units_unlogged: 2, sell_ids: [5, 6],
    first_sell_at: "2026-11-09T07:00:00Z", last_sell_at: "2026-11-09T09:00:00Z", product_name: "<Brazil>", product_size: 330, packed_stock_now: 0 }]);
  check("email subject names coffee + bags", one.subject.includes("2 bags") && one.subject.includes("<Brazil>"), one.subject);
  check("email html escapes names", one.html.includes("&lt;Brazil&gt;") && !one.html.includes("<Brazil>"));
  check("email lists MFlow docs", one.html.includes("5, 6"));
  const two = buildUnloggedEmail([
    { id: 1, product_id: 8, alert_date: "d", units_unlogged: 1, sell_ids: [1], first_sell_at: null, last_sell_at: null, product_name: "A", product_size: null, packed_stock_now: 0 },
    { id: 2, product_id: 9, alert_date: "d", units_unlogged: 3, sell_ids: [2], first_sell_at: null, last_sell_at: null, product_name: "B", product_size: null, packed_stock_now: 0 },
  ]);
  check("multi-coffee subject", two.subject.includes("4 bags across 2 coffees"), two.subject);
}

// The handler must not split the claim from the stock move again.
{
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  check("index.ts does not call apply_packed_stock_delta directly", !src.includes('rpc("apply_packed_stock_delta"'));
  check("index.ts does not insert mflow_sell_events itself", !/from\("mflow_sell_events"\)\s*\.insert/.test(src));
  check("index.ts applies through applySells", src.includes("applySells("));
}

if (failures) { console.error(`\n${failures} check(s) failed`); Deno.exit(1); }
console.log("\nall checks passed");
