// Tests for coffee-bot's stock writes.
//
//   deno run --allow-read supabase/functions/coffee-bot/stock_test.ts
//
// The fake rpc applies each delta in one step after a random delay, the way the
// Postgres functions do under their row lock, so overlapping calls interleave.
// The last check reads index.ts and fails if any handler goes back to writing
// roasted_stock / packed_stock as an absolute value computed in JS.

import { addPacked, deductRoasted } from "./stock.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const jitter = () => new Promise(r => setTimeout(r, Math.random() * 10));

function fakeDb() {
  const roasted: Record<string, number> = { "origin:1": 10, "profile:2": 0.5 };
  const packed: Record<number, number> = { 7: 3 };
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    async rpc(fn: string, args: Record<string, any>) {
      calls.push({ fn, args });
      await jitter();
      if (fn === "apply_roasted_stock_delta") {
        const key = `${args.p_source_type}:${args.p_source_id}`;
        if (!(key in roasted)) return { data: [], error: null };
        const before = roasted[key];
        if (args.p_require_sufficient && before + args.p_delta_kg < 0) {
          return { data: [{ stock_before: before, stock_after: before, applied: false }], error: null };
        }
        roasted[key] = round3(Math.max(0, before + args.p_delta_kg));
        return { data: [{ stock_before: before, stock_after: roasted[key], applied: true }], error: null };
      }
      if (fn === "apply_packed_stock_delta") {
        if (!(args.p_product_id in packed)) return { data: [], error: null };
        const before = packed[args.p_product_id];
        packed[args.p_product_id] = Math.max(0, before + args.p_delta);
        return { data: [{ packed_before: before, packed_after: packed[args.p_product_id], units_lost: 0 }], error: null };
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
  };
  return { client, roasted, packed, calls };
}

// Concurrent packing reports against one origin and one product all count.
{
  const db = fakeDb();
  const results = await Promise.all(Array.from({ length: 20 }, () => deductRoasted(db.client, "origin", 1, 0.33)));
  check("20 overlapping deductions all applied", results.every(r => r.result?.applied), "");
  check("origin stock reflects every deduction", db.roasted["origin:1"] === round3(10 - 20 * 0.33),
    `stock=${db.roasted["origin:1"]}`);
  check("delta is sent negative, not as an absolute value",
    db.calls.every(c => c.args.p_delta_kg === -0.33 && !("roasted_stock" in c.args)));

  await Promise.all(Array.from({ length: 12 }, () => addPacked(db.client, 7, 2)));
  check("packed_stock reflects every packing", db.packed[7] === 3 + 24, `packed=${db.packed[7]}`);
}

// Packing floors at 0; shop consumption refuses instead.
{
  const db = fakeDb();
  const pack = await deductRoasted(db.client, "profile", 2, 2);
  check("packing shortage floors at 0", pack.result?.after === 0 && pack.result?.before === 0.5,
    JSON.stringify(pack.result));

  const db2 = fakeDb();
  const shop = await deductRoasted(db2.client, "profile", 2, 2, true);
  check("shop shortage is refused, stock untouched",
    shop.result?.applied === false && db2.roasted["profile:2"] === 0.5, JSON.stringify(shop.result));

  // Two shop takes that each fit alone but not together: exactly one wins.
  const db3 = fakeDb();
  const both = await Promise.all([
    deductRoasted(db3.client, "profile", 2, 0.3, true),
    deductRoasted(db3.client, "profile", 2, 0.3, true),
  ]);
  check("overlapping shop takes cannot overdraw",
    both.filter(r => r.result?.applied).length === 1 && db3.roasted["profile:2"] === 0.2,
    `stock=${db3.roasted["profile:2"]}`);
}

// Missing rows and RPC errors surface as errors, not as success.
{
  const db = fakeDb();
  const gone = await deductRoasted(db.client, "origin", 999, 1);
  check("missing source is an error", gone.result === null && gone.error !== null);
  const noProduct = await addPacked(db.client, 999, 1);
  check("missing product is an error", noProduct.result === null && noProduct.error !== null);
  const failing = { rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }) };
  const err = await deductRoasted(failing, "origin", 1, 1);
  check("rpc error is passed through", err.result === null && (err.error as any)?.message === "boom");
}

// index.ts must not write stock columns directly any more.
{
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const direct = src.match(/\.update\(\s*\{\s*(roasted_stock|packed_stock)\s*:/g) ?? [];
  check("index.ts has no absolute stock writes", direct.length === 0, direct.join(", "));
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
Deno.exit(failures === 0 ? 0 : 1);
