// Catalog check for blog recommendations from the strategist Brain.
//
// The Organic writer links every name in products_to_mention to its WooCommerce
// page, and products_to_mention[0] becomes the banner's hero bag, so each name
// must be an EXACT Minuto coffee lineup name (fetchMinutoCoffeeCatalog). The
// Brain's content_blog action_params had no products field at all, so its blog
// drafts reached the writer with none. conclude_brief now refuses a blog
// recommendation without valid products (the Brain sees the lineup in the
// error and corrects itself), and the executor checks again before drafting in
// case the catalog changed in between.

const norm = (s: string) => s.trim().replace(/\s+/g, ' ')

/** Returns the products as exact catalog names, or why they can't be used. */
export function checkBlogProducts(
  products: unknown,
  lineupNames: string[],
): { ok: true; products: string[] } | { ok: false; error: string } {
  if (!Array.isArray(products) || products.length === 0) {
    return { ok: false, error: 'products[] is required: at least one EXACT name from the Minuto coffee lineup' }
  }
  const byNorm = new Map(lineupNames.map(n => [norm(n), n]))
  const exact: string[] = []
  const unknown: string[] = []
  for (const p of products) {
    const hit = typeof p === 'string' ? byNorm.get(norm(p)) : undefined
    if (hit) { if (!exact.includes(hit)) exact.push(hit) } else unknown.push(String(p))
  }
  if (unknown.length) {
    return { ok: false, error: `not in the Minuto coffee lineup: ${unknown.map(u => `"${u}"`).join(', ')}` }
  }
  return { ok: true, products: exact }
}
