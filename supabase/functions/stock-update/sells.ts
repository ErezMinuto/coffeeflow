// Applying MFlow sells to packed_stock.
//
// Website sales may take packed_stock negative (bags owed, packed after the
// sale). Store sales never go below LEAST(before, 0); what that floor swallows
// comes back in `unlogged` and is emailed (migration 20261109120000).
//
// One RPC, one transaction: apply_mflow_sells claims each sell in
// mflow_sell_events (ON CONFLICT DO NOTHING) and applies the packed_stock delta
// of ONLY the sells it claimed, writing the inventory_adjustments audit rows in
// the same transaction. Two overlapping syncs can therefore never deduct the
// same sale twice, and a sale is never recorded without its stock movement (or
// moved without being recorded). See migration 20261024_apply_mflow_sells.
//
// The previous version applied the deltas first and inserted the dedupe rows in
// a later request whose failure was only console-logged while the response
// still said applied.

export interface SellToApply {
  id: number;
  type: string;
  status: string;
  isReturn: boolean;
  source: string;
  // 'web' = EcoSite/WooCommerce order: may back-order (stock goes negative).
  // 'store' = POS / back office: must come off the shelf, or it is an alert.
  channel: SellChannel;
  date: unknown;
  delta: Map<number, number>;
}

export type SellChannel = "web" | "store";

// A sell is a website order when MFlow ties it to a WooCommerce order or says
// it came from EcoSite. Everything else (POS, back-office invoices, unknown)
// is a physical sale that must come off the shelf: when in doubt the sale is
// treated as store, the side that raises an alert rather than hides one.
export function channelOfSell(s: { sell_source?: unknown; woocommerce_order_id?: unknown }): SellChannel {
  if (s.woocommerce_order_id != null && String(s.woocommerce_order_id) !== "") return "web";
  return String(s.sell_source ?? "").trim().toLowerCase().startsWith("ecosite") ? "web" : "store";
}

// A store sale of a bag the system did not have: someone packed and did not log it.
export interface UnloggedSale { cf_product: number; mflow_sell_id: number; units: number; packed_before: number; transaction_date: unknown }

export interface ApplySellsResult {
  // null when the RPC succeeded; the message otherwise (nothing was applied or recorded).
  error: string | null;
  claimed: number[];
  alreadyRecorded: number;
  skippedMissingProduct: number[];
  failedProducts: number[];
  clamped: { cf_product: number; units_lost: number }[];
  unlogged: UnloggedSale[];
  adjustments: { cf_product: number; delta: number; web_delta?: number; store_delta?: number; packed_before: number; packed_after: number; units_lost: number }[];
}

type RpcClient = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: { message: string } | null }> };

export function toEventRows(sells: SellToApply[]) {
  return sells.map((t) => ({
    mflow_sell_id: t.id, type: t.type, status: t.status, is_return: t.isReturn, source: t.source,
    channel: t.channel, transaction_date: t.date ?? null, coffee_delta: Object.fromEntries(t.delta),
  }));
}

export async function applySells(supabase: RpcClient, sells: SellToApply[], note: string): Promise<ApplySellsResult> {
  const empty: ApplySellsResult = {
    error: null, claimed: [], alreadyRecorded: 0, skippedMissingProduct: [], failedProducts: [], clamped: [], unlogged: [], adjustments: [],
  };
  if (!sells.length) return empty;
  const { data, error } = await supabase.rpc("apply_mflow_sells", { p_sells: toEventRows(sells), p_note: note });
  if (error || !data || typeof data !== "object") {
    return { ...empty, error: error?.message ?? "apply_mflow_sells returned nothing" };
  }
  const adjustments = Array.isArray(data.adjustments) ? data.adjustments : [];
  return {
    error: null,
    claimed: (data.claimed ?? []).map(Number),
    alreadyRecorded: Number(data.already_recorded ?? 0),
    skippedMissingProduct: (data.skipped_missing_product ?? []).map(Number),
    failedProducts: (data.failed_products ?? []).map(Number),
    clamped: adjustments
      .filter((a: any) => Number(a.units_lost) > 0)
      .map((a: any) => ({ cf_product: Number(a.cf_product), units_lost: Number(a.units_lost) })),
    unlogged: (Array.isArray(data.unlogged) ? data.unlogged : []).map((u: any) => ({
      cf_product: Number(u.cf_product), mflow_sell_id: Number(u.mflow_sell_id), units: Number(u.units),
      packed_before: Number(u.packed_before), transaction_date: u.transaction_date ?? null,
    })),
    adjustments,
  };
}
