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

import { applySells, type SellToApply } from "./sells.ts";

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
  id, type: "sell", status: "Completed", isReturn: false, source: "POS", date: "2026-10-24",
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

// The handler must not split the claim from the stock move again.
{
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  check("index.ts does not call apply_packed_stock_delta directly", !src.includes('rpc("apply_packed_stock_delta"'));
  check("index.ts does not insert mflow_sell_events itself", !/from\("mflow_sell_events"\)\s*\.insert/.test(src));
  check("index.ts applies through applySells", src.includes("applySells("));
}

if (failures) { console.error(`\n${failures} check(s) failed`); Deno.exit(1); }
console.log("\nall checks passed");
