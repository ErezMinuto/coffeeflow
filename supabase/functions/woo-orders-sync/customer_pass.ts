/**
 * Customer pass of woo-orders-sync: Woo orders → customer_orders → customers.
 *
 * Two modes:
 *   incremental  every run, after the woo_orders sync. Re-reads every web
 *                order Woo modified since the newest date_modified already
 *                stored (minus a 2 h safety margin), so a later refund or
 *                cancellation lands too. Skipped until a backfill has run.
 *   backfill     {"customer_backfill": {"start_page": 1, "pages": 10}}.
 *                Walks ALL orders by id, every status, `pages` pages at a
 *                time; call again with the returned next_page until done.
 *
 * Both finish by calling messaging_resolve_customers(). Neither can break the
 * woo_orders sync: errors are logged and returned, never thrown.
 */
import type { Logger } from "../_shared/logger.ts";
import {
  buildCustomerOrderRow, CUSTOMER_ORDER_FIELDS, gramsFromProductAttributes,
  isMflowOrder, productIdsNeedingGrams, type WooOrderFull,
} from "./customer_orders.ts";

const PER_PAGE = 100;
const TIME_BUDGET_MS = 100_000;   // edge functions are killed at 150 s

export interface CustomerPassOpts {
  wooUrl: string;
  wooAuth: string;                 // base64 "key:secret"
  backfill?: { start_page?: number; pages?: number };
}

async function woo(opts: CustomerPassOpts, path: string): Promise<any> {
  const res = await fetch(`${opts.wooUrl}/wp-json/wc/v3/${path}`, {
    headers: { Authorization: `Basic ${opts.wooAuth}` },
  });
  if (!res.ok) throw new Error(`WooCommerce ${res.status} on ${path.split("?")[0]}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// deno-lint-ignore no-explicit-any
export async function syncCustomerOrders(supabase: any, log: Logger, opts: CustomerPassOpts) {
  const t0 = Date.now();
  const mode = opts.backfill ? "backfill" : "incremental";
  try {
    let modifiedAfter: string | null = null;
    if (!opts.backfill) {
      const { data, error } = await supabase
        .from("customer_orders").select("date_modified")
        .order("date_modified", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
      if (error) throw error;
      if (!data?.date_modified) {
        log.warn("customers.not_backfilled", "customer_orders is empty; run a customer_backfill first");
        return { mode, skipped: "not_backfilled" };
      }
      modifiedAfter = new Date(new Date(data.date_modified).getTime() - 2 * 3600_000).toISOString();
    }

    const productGrams = new Map<number, number | null>();
    let page = opts.backfill?.start_page ?? 1;
    const lastPage = opts.backfill ? page + (opts.backfill.pages ?? 10) - 1 : Infinity;
    let upserted = 0, skippedMflow = 0, done = false;

    while (page <= lastPage) {
      if (Date.now() - t0 > TIME_BUDGET_MS) break;
      const params = new URLSearchParams({
        per_page: String(PER_PAGE), page: String(page), status: "any",
        // Incremental walks by modified date so a run cut short by the time
        // budget never moves the watermark past orders it did not read.
        orderby: modifiedAfter ? "modified" : "id", order: "asc", _fields: CUSTOMER_ORDER_FIELDS,
      });
      if (modifiedAfter) { params.set("modified_after", modifiedAfter); params.set("dates_are_gmt", "true"); }
      const orders: WooOrderFull[] = await woo(opts, `orders?${params}`);

      const web = orders.filter(o => {
        if (isMflowOrder(o.meta_data)) { skippedMflow++; return false; }
        return true;
      });

      // Simple products keep their bag size on the product, not the line.
      const need = [...new Set(web.flatMap(productIdsNeedingGrams))].filter(id => !productGrams.has(id));
      for (let i = 0; i < need.length; i += 100) {
        const ids = need.slice(i, i + 100);
        const products = await woo(opts, `products?per_page=100&include=${ids.join(",")}&_fields=id,attributes`);
        for (const id of ids) productGrams.set(id, null);
        for (const p of products) productGrams.set(p.id, gramsFromProductAttributes(p.attributes));
      }

      const rows = web.filter(o => o.date_created_gmt).map(o => buildCustomerOrderRow(o, productGrams));
      if (rows.length) {
        const { error } = await supabase.from("customer_orders").upsert(rows, { onConflict: "woo_order_id" });
        if (error) throw error;
        upserted += rows.length;
      }
      if (orders.length < PER_PAGE) { done = true; break; }
      page++;
    }

    // Attach new orders to customers, in chunks so one call stays short.
    const resolved = { created: 0, attached: 0, merged: 0, skipped: 0, remaining: 0 };
    while (Date.now() - t0 < TIME_BUDGET_MS + 25_000) {
      const { data, error } = await supabase.rpc("messaging_resolve_customers", { p_limit: 2000 });
      if (error) throw error;
      for (const k of ["created", "attached", "merged", "skipped"] as const) resolved[k] += data[k];
      resolved.remaining = data.remaining;
      if (!data.remaining) break;
    }

    const summary = {
      mode, upserted, skipped_mflow: skippedMflow, modified_after: modifiedAfter,
      done,
      next_page: done ? null : page,   // backfill: pass as start_page on the next call
      resolved,
    };
    log.info("customers.done", `${mode}: ${upserted} orders, ${resolved.created} new customers, ${resolved.merged} merged`, summary);
    return summary;
  } catch (err) {
    log.error("customers.fail", `customer pass (${mode}) failed`, undefined, err);
    return { mode, error: err instanceof Error ? err.message : String((err as any)?.message ?? err) };
  }
}
