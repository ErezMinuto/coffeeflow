// Resolve a loosely written product name to one catalog row.
//
// Why this exists: a bag_hero render looks the bag up by product name, and
// the strategist paraphrases names instead of copying them. 2026-11-15 it
// wrote "Minuto Velvet Star - קולומביה" for the catalog row
// "פולי קפה ספשלטי טרי 100% ערביקה קולומביה  - Minuto Velvet Star". Same
// words, different order, so a substring ILIKE missed, the render failed and
// the blog post went to WordPress with no featured image (posts 83160, 82965).
//
// Matching is by word, in any order. Generic words that appear in nearly
// every coffee name (פולי, קפה, Minuto, specialty...) carry no signal and are
// ignored on both sides. A row is returned only when it is the single best
// match; anything ambiguous returns null, because a wrong bag on a banner is
// worse than a failed render that a person can see and fix.

export interface ProductRow {
  woo_id: number
  name: string
  image_url: string
}

// Words that say "this is a Minuto coffee" without saying which one.
const GENERIC = new Set([
  'minuto', 'מינוטו',
  'פולי', 'פולים', 'קפה', 'coffee', 'bean', 'beans',
  'specialty', 'speciality', 'ספשלטי', 'ספיישלטי',
  'טרי', 'טריים', 'fresh',
  'ערביקה', 'arabica', '100',
  'חד', 'זני', 'single', 'origin',
  'the', 'of', 'and',
])

/** Lower-cased word tokens, punctuation and dashes stripped. */
export function tokenize(s: string): string[] {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(t => t.length >= 2)
}

/** The tokens that actually identify a product. */
export function distinctiveTokens(s: string): string[] {
  return [...new Set(tokenize(s).filter(t => !GENERIC.has(t)))]
}

/**
 * Pick the one row whose name best matches `needle`, or null.
 *
 * Score = how many of the needle's distinctive words the row's name contains.
 * Accepted only when:
 *   • the score covers at least half the needle's distinctive words, and is
 *     at least 2 (or 1 when the needle has a single distinctive word);
 *   • exactly one row holds the top score, or the tied rows are all variants
 *     of one base row (e.g. a light-roast edition of the same coffee), in
 *     which case the base row wins.
 */
export function pickProductByName<T extends { name: string }>(
  needle: string,
  rows: T[],
): T | null {
  const want = distinctiveTokens(needle)
  if (want.length === 0) return null
  const minScore = Math.min(2, want.length)

  let top: { row: T; score: number; have: Set<string> }[] = []
  for (const row of rows) {
    const have = new Set(distinctiveTokens(row.name))
    let score = 0
    for (const t of want) if (have.has(t)) score++
    if (score < minScore || score * 2 < want.length) continue
    if (top.length === 0 || score > top[0].score) top = [{ row, score, have }]
    else if (score === top[0].score) top.push({ row, score, have })
  }
  if (top.length === 0) return null
  if (top.length === 1) return top[0].row

  // Several rows tie on score. One may still be the base product the others
  // are variants of: its distinctive words are a strict subset of every other
  // tied row's. Two different products that merely share an origin word
  // (two Colombians) are not in that relation, so they stay ambiguous.
  top.sort((a, b) => a.have.size - b.have.size)
  const base = top[0]
  const isVariantOfBase = (o: typeof base) =>
    o.have.size > base.have.size && [...base.have].every(t => o.have.has(t))
  return top.slice(1).every(isVariantOfBase) ? base.row : null
}
