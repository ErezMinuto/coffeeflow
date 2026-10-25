// Runs the real migration in an in-memory Postgres (PGlite) — no database needed.
// deno test --no-config -A supabase/functions/woo-orders-sync/resolve_customers_test.ts
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
const MIG = await Deno.readTextFile(new URL("../../migrations/20261025_messaging_customers.sql", import.meta.url));

async function db() {
  const pg = new PGlite();
  await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;`);
  await pg.exec(MIG);
  await pg.exec(MIG); // idempotent
  return pg;
}
let nextId = 1;
const order = (o: Record<string, unknown>) => ({ woo_order_id: nextId++, status: "completed", date_created: "2026-01-01", delivery_method: "ship", phone_is_mobile: true, ...o });
async function insert(pg: PGlite, rows: Record<string, unknown>[]) {
  for (const r of rows) {
    const k = Object.keys(r);
    await pg.query(`INSERT INTO customer_orders (${k.join(",")}) VALUES (${k.map((_, i) => "$" + (i + 1)).join(",")})`, Object.values(r));
  }
}
const resolve = async (pg: PGlite) => (await pg.query<{ r: any }>(`SELECT messaging_resolve_customers() r`)).rows[0].r;
const live = async (pg: PGlite) => (await pg.query<any>(`SELECT * FROM customers WHERE merged_into IS NULL ORDER BY seq`)).rows;

Deno.test("guest + account orders by the same phone become one customer", async () => {
  const pg = await db();
  await insert(pg, [
    order({ phone_e164: "+972541111222", email_norm: "dana@a.com" }),
    order({ phone_e164: "+972541111222", email_norm: "dana.work@b.com", woo_customer_id: 77 }),
    order({ phone_e164: null, email_norm: "x@y.com", phone_is_mobile: false }),
  ]);
  const r = await resolve(pg);
  assertEquals([r.created, r.attached, r.merged, r.remaining], [2, 1, 0, 0]);
  const c = await live(pg);
  assertEquals(c.length, 2);
  assertEquals(c[0].emails.sort(), ["dana.work@b.com", "dana@a.com"]);
  assertEquals(c[0].woo_customer_ids, [77]);
  assertEquals((await resolve(pg)).attached, 0); // re-run is a no-op
});

Deno.test("an order that bridges two customers merges them; oldest survives", async () => {
  const pg = await db();
  await insert(pg, [
    order({ phone_e164: "+972541111333", email_norm: "a@a.com" }),
    order({ phone_e164: "+972549999999", email_norm: "b@b.com" }),
  ]);
  await resolve(pg);
  const [first] = await live(pg);
  await insert(pg, [order({ phone_e164: "+972549999999", email_norm: "a@a.com" })]); // bridge
  const r = await resolve(pg);
  assertEquals(r.merged, 1);
  const c = await live(pg);
  assertEquals(c.length, 1);
  assertEquals(c[0].id, first.id);
  assertEquals(c[0].phones.sort(), ["+972541111333", "+972549999999"]);
  assertEquals(c[0].phone_e164, "+972549999999"); // latest order's mobile
  const owners = (await pg.query<any>(`SELECT DISTINCT customer_id FROM customer_orders`)).rows;
  assertEquals(owners.map((o: any) => o.customer_id), [first.id]);
  const merged = (await pg.query<any>(`SELECT merged_into FROM customers WHERE merged_into IS NOT NULL`)).rows;
  assertEquals(merged.map((m: any) => m.merged_into), [first.id]);
});

Deno.test("blocklisted café number never joins strangers", async () => {
  const pg = await db();
  await insert(pg, [
    order({ phone_e164: "+972544490486", email_norm: "s1@a.com" }),
    order({ phone_e164: "+972544490486", email_norm: "s2@b.com" }),
  ]);
  await resolve(pg);
  const c = await live(pg);
  assertEquals(c.length, 2);
  assertEquals(c.every((x: any) => x.phones.length === 0 && x.phone_e164 === null), true);
});

Deno.test("an order with no identity is skipped once, not retried", async () => {
  const pg = await db();
  await insert(pg, [order({ phone_e164: null, email_norm: null, phone_is_mobile: false })]);
  const r = await resolve(pg);
  assertEquals([r.skipped, r.remaining], [1, 0]);
  assertEquals((await resolve(pg)).skipped, 0);
});

Deno.test("landline is kept as an identity but never as the preferred mobile", async () => {
  const pg = await db();
  await insert(pg, [order({ phone_e164: "+97289461234", phone_is_mobile: false, email_norm: "l@l.com" })]);
  await resolve(pg);
  const [c] = await live(pg);
  assertEquals([c.phones, c.phone_e164], [["+97289461234"], null]);
});
