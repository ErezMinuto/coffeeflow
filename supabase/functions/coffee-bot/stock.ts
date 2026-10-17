// Stock writes for coffee-bot, done in the database so concurrent reports for
// the same origin/profile/product cannot overwrite each other.
//
// Both helpers call an RPC that re-reads the value under a row lock and writes
// it in the same transaction (migrations 20260816_apply_packed_stock_delta and
// 20261017c_atomic_stock_and_campaign_counters). The bot used to read the stock,
// compute the new value in JS and write it back, which lost one of two
// overlapping deductions.

// deno-lint-ignore no-explicit-any
type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: any }> };

export type SourceType = "origin" | "profile";

export interface RoastedResult { before: number; after: number; applied: boolean }
export interface PackedResult  { before: number; after: number }

// Subtract kg from a source's roasted_stock.
// requireSufficient=false: always applies, floored at 0 (packing).
// requireSufficient=true:  writes nothing when the stock is short (shop use).
// Returns null with an error when the call failed or the source is gone.
export async function deductRoasted(
  supabase: Rpc, sourceType: SourceType, sourceId: number, kg: number, requireSufficient = false,
): Promise<{ result: RoastedResult | null; error: unknown }> {
  const { data, error } = await supabase.rpc("apply_roasted_stock_delta", {
    p_source_type:        sourceType,
    p_source_id:          sourceId,
    p_delta_kg:           -kg,
    p_require_sufficient: requireSufficient,
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) return { result: null, error: error ?? new Error(`${sourceType} #${sourceId} not found`) };
  return {
    result: { before: Number(row.stock_before), after: Number(row.stock_after), applied: row.applied === true },
    error: null,
  };
}

// Add bags to a product's packed_stock.
export async function addPacked(
  supabase: Rpc, productId: number, bags: number,
): Promise<{ result: PackedResult | null; error: unknown }> {
  const { data, error } = await supabase.rpc("apply_packed_stock_delta", {
    p_product_id: productId,
    p_delta:      bags,
  });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) return { result: null, error: error ?? new Error(`product #${productId} not found`) };
  return { result: { before: Number(row.packed_before), after: Number(row.packed_after) }, error: null };
}
