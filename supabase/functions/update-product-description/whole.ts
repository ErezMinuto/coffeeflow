// When update-product-description may take a whole description instead of
// find/replace edits. Pure apart from the injected proposal lookup; tested in
// whole_test.ts.
import { sameValue, type ChangeContext, type ChangeRow } from "../_shared/site_change_log.ts";

/**
 * A whole description is accepted only
 *  - to undo a logged change (change.undo_of): it restores the exact text that change replaced;
 *  - to apply an approved proposal (change.change_id, the owner clicked approve in
 *    the dashboard): it must be exactly the text that pending proposal holds, so
 *    this path cannot write anything the owner did not see.
 * Returns the text to write, null when find/replace edits are expected, or an error.
 */
export async function wholeDescription(
  description: unknown,
  ctx: ChangeContext,
  productId: number,
  getChange: (id: string) => Promise<Pick<ChangeRow, "status" | "target_type" | "target_id" | "after"> | null>,
): Promise<{ text: string | null } | { error: string }> {
  if (typeof description !== "string") return { text: null };
  if (ctx.undo_of && ctx.change_id) return { error: "a change is either an undo or an approved proposal, not both" };
  if (ctx.undo_of) return { text: description };
  if (!ctx.change_id) return { text: null };
  const p = await getChange(ctx.change_id);
  if (!p || p.status !== "proposed" || p.target_type !== "product_description" || Number(p.target_id) !== productId || !sameValue(p.after, description)) {
    return { error: "description does not match a pending proposal for this product" };
  }
  return { text: description };
}
