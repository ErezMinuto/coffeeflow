// Minuto SEO Agent — brand guard.
//
// WHY THIS EXISTS AS CODE AND NOT AS PROMPT TEXT
// ----------------------------------------------
// "Never feature Veneto / green coffee" has been a standing instruction since
// 2026-05-29 (seo_learnings) and a hard rule in the Writer system prompt. It
// was violated repeatedly anyway:
//   • 2026-09-09 / 09-13 / 09-16 / 09-23 — visual_generation with
//     product_name "1 ק״ג פולי קפה Veneto Delux"/"Veneto Premium",
//     render_mode bag_hero (a RESELLER bag rendered as a white Minuto bag).
//   • 2026-09-20 — text_generation shipped with two GREEN coffee SKUs in
//     products_to_mention, four months after the rule was recorded.
//   • 2026-09-22 — a brief carrying Veneto Delux, queued 18 minutes after the
//     admin re-recorded the green-coffee rule in chat.
// The root cause was never the model's willingness: the orchestrator handed
// the strategist the FULL woo_products catalog and told it to pick exact
// names from it, so the banned SKUs were in the candidate set every cycle.
// A rule the planner can restate and still walk past is not a rule. This
// module is the gate that a brief has to physically pass.
//
// THE THREE CLASSES
// -----------------
//   banned_green            — unroasted/green beans. You cannot brew them;
//                             featuring them as a purchasable hero is
//                             off-brand. Educational MENTIONS are fine (see
//                             the 2026-05-29 learning) — this module only
//                             gates products_to_mention / product_name, never
//                             prose.
//   banned_reseller_coffee  — Veneto. Third-party roasted beans Minuto
//                             resells. It competes with our own roast and has
//                             been rendered dressed up as a Minuto bag.
//   paired_equipment        — Toddy. BREWING GEAR, not coffee: all 5 Toddy
//                             SKUs are systems, kits and filter bags, zero
//                             beans. Per the admin (2026-09-23) this is
//                             allowed as a scene and a topic, on one
//                             condition — it has to be connected to Minuto
//                             coffee ("recommended coffee for your Toddy").
//                             So it may ride along with a Minuto roast, and
//                             may never be the hero on its own.
//   minuto_roast            — our own roasted line. Always allowed.
//   neutral                 — grinders, machines, cups, scales. Untouched;
//                             these are legitimate things to link from a blog
//                             post and nothing here should narrow the catalog
//                             to coffee only.
//
// NOTE ON TOPIC FREEDOM: this module gates PRODUCTS, never SUBJECTS. Cold
// brew, V60, Clever, French press, espresso and anything seasonal remain
// entirely open as things to write about. Blocking a Toddy product spotlight
// is not the same as blocking cold brew content, and conflating the two was
// an explicit correction from the admin on 2026-09-23.

// Type-only: erased at runtime, so this module stays importable by unit tests
// that have no Supabase env.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export type BrandVerdict =
  | 'minuto_roast'
  | 'banned_green'
  | 'banned_reseller_coffee'
  | 'paired_equipment'
  | 'neutral'

// ── Category-first classification ────────────────────────────────────────
// WooCommerce categories are the reliable signal — each of these classes has
// its own dedicated category, verified against live woo_products on
// 2026-09-23. Names drift (SKUs get renamed, sizes get added); categories
// don't. Regex below is the fallback for a bare name with no catalog row.

const CATS_MINUTO_ROAST = [
  'פולי קפה טרי - קפה ספשלטי specialty coffee',
  'תערובות קפה מינוטו',
]
const CATS_GREEN = [
  'פולי קפה ירוק',
  'פולי קפה ירוק - Specialty Coffee',
]
const CATS_RESELLER_COFFEE = [
  'פולי קפה ונטו Veneto',
]
const CATS_PAIRED = [
  'Toddy Cold brew',
]

// ── Name-based fallback ──────────────────────────────────────────────────
// Deliberately NARROW. An earlier filter in cmsApi.ts matches a bare /ירוק/,
// which is safe there only because it runs inside the two coffee categories.
// Applied catalog-wide it would strip a dozen GREEN-COLOURED items that are
// perfectly fine to feature — a green Bialetti moka pot, the Fellow Stagg in
// smoke green, green Loveramics cups, a green Comandante jar. So green coffee
// is matched as the PHRASE "קפה ירוק" (coffee-green, adjacent), never the
// colour word alone. Verified: matches all 4 green SKUs, none of the 12
// green-coloured equipment SKUs, and not חליטת תה ירוק (green tea).
const RE_GREEN    = /קפה\s+ירוק|פולים\s+ירוקים|green\s+coffee|unroasted|raw\s+coffee/i
const RE_RESELLER = /veneto|ונטו/i
const RE_PAIRED   = /toddy|טודי/i

export function classifyByName(name: string): BrandVerdict {
  const n = String(name ?? '')
  if (RE_GREEN.test(n))    return 'banned_green'
  if (RE_RESELLER.test(n)) return 'banned_reseller_coffee'
  if (RE_PAIRED.test(n))   return 'paired_equipment'
  return 'neutral'
}

export interface BrandIndexEntry { name: string; categories: string[] | null }

// A classifier bound to the live catalog. Build once per run and reuse — it
// is a pure lookup, no I/O.
export interface BrandIndex {
  classify(name: string): BrandVerdict
  isBanned(name: string): boolean
  /** Every Minuto roasted-coffee name in the catalog, for pairing checks. */
  minutoRoastNames(): string[]
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

export function buildBrandIndex(products: BrandIndexEntry[]): BrandIndex {
  const byName = new Map<string, BrandVerdict>()
  const roasts: string[] = []

  const hasCat = (cats: string[] | null, want: string[]) =>
    (cats ?? []).some(c => want.some(w => norm(c) === norm(w)))

  for (const p of products ?? []) {
    const cats = p.categories ?? null
    let verdict: BrandVerdict
    // Order matters: a green or Veneto SKU also sits in the generic
    // 'פולי קפה' bucket, so the specific categories are tested first.
    if      (hasCat(cats, CATS_GREEN))           verdict = 'banned_green'
    else if (hasCat(cats, CATS_RESELLER_COFFEE)) verdict = 'banned_reseller_coffee'
    else if (hasCat(cats, CATS_PAIRED))          verdict = 'paired_equipment'
    else if (hasCat(cats, CATS_MINUTO_ROAST))    verdict = 'minuto_roast'
    // No decisive category → fall back to the name. Belt and braces: a SKU
    // mis-categorised in Woo still gets caught if it is named plainly.
    else                                         verdict = classifyByName(p.name)

    // A category says "Minuto roast" but the NAME says Veneto/green → trust
    // the ban. We would rather drop a legitimate product than feature a
    // banned one; this asymmetry is the whole point of the guard.
    if (verdict === 'minuto_roast') {
      const byname = classifyByName(p.name)
      if (byname === 'banned_green' || byname === 'banned_reseller_coffee') verdict = byname
    }

    byName.set(norm(p.name), verdict)
    if (verdict === 'minuto_roast') roasts.push(p.name)
  }

  const classify = (name: string): BrandVerdict =>
    byName.get(norm(name)) ?? classifyByName(name)

  return {
    classify,
    isBanned: (name) => {
      const v = classify(name)
      return v === 'banned_green' || v === 'banned_reseller_coffee'
    },
    minutoRoastNames: () => roasts.slice(),
  }
}

// Build an index straight from woo_products. Two columns only, so it is cheap
// next to what any caller is about to do. PAGINATED: PostgREST caps a plain
// select at 1000 rows and the catalogue is larger, and an unpaginated read
// would leave the tail of the catalogue unclassified — precisely the silent
// gap this guard exists to close.
//
// On a total fetch failure the caller gets a regex-only index. That still
// catches every known banned SKU; what it loses is the ability to recognise a
// Minuto roast, so Toddy pairing fails closed and Toddy is dropped. Failing
// toward "drop" rather than "feature" is the correct direction.
export async function fetchBrandIndex(supabase: SupabaseClient): Promise<BrandIndex> {
  const rows: BrandIndexEntry[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('woo_products')
      .select('name, categories')
      .range(from, from + PAGE - 1)
    if (error) {
      console.warn(`[brandGuard] woo_products lookup failed (regex-only fallback): ${error.message}`)
      break
    }
    const page = data ?? []
    for (const r of page) {
      rows.push({ name: String(r.name ?? ''), categories: (r.categories ?? null) as string[] | null })
    }
    if (page.length < PAGE) break
  }
  return buildBrandIndex(rows)
}

// ── Brief screening ──────────────────────────────────────────────────────

export interface ProductScreenResult {
  /** products_to_mention with banned + unpaired items removed. */
  kept: string[]
  /** What was removed and why — for logging and for the task rationale. */
  dropped: Array<{ name: string; verdict: BrandVerdict; why: string }>
}

// Screen a products_to_mention list.
//
// Entries arrive as either bare strings or { name, url } objects — the
// orchestrator has emitted both shapes historically (see normalizeProductItems
// in seo-worker-writer), so both are accepted and the NAME is what is judged.
export function screenProductList(
  items: unknown,
  index: BrandIndex,
): ProductScreenResult {
  const names: string[] = (Array.isArray(items) ? items : [])
    .map((it) => {
      if (typeof it === 'string') return it
      if (it && typeof it === 'object') return String((it as Record<string, unknown>).name ?? '')
      return ''
    })
    .filter(Boolean)

  const dropped: ProductScreenResult['dropped'] = []
  const survivors: string[] = []

  for (const name of names) {
    const verdict = index.classify(name)
    if (verdict === 'banned_green') {
      dropped.push({ name, verdict, why: 'green/unroasted coffee is never a featured or linked product' })
    } else if (verdict === 'banned_reseller_coffee') {
      dropped.push({ name, verdict, why: 'Veneto is resold third-party coffee, never featured as ours' })
    } else {
      survivors.push(name)
    }
  }

  // Toddy pairing: allowed only in the company of at least one Minuto roast.
  // "Recommended coffee for your Toddy" passes; a standalone Toddy spotlight
  // does not. Checked AFTER the bans so a Veneto bean can never satisfy the
  // pairing requirement on Toddy's behalf.
  const hasMinutoRoast = survivors.some(n => index.classify(n) === 'minuto_roast')
  const kept: string[] = []
  for (const name of survivors) {
    if (index.classify(name) === 'paired_equipment' && !hasMinutoRoast) {
      dropped.push({
        name,
        verdict: 'paired_equipment',
        why: 'Toddy needs a Minuto roast alongside it — it may never be the sole product',
      })
      continue
    }
    kept.push(name)
  }

  return { kept, dropped }
}

// The hero slot on a bag_hero render composites a real white Minuto bag, so
// the product named there must BE one of our bags. Anything else — a reseller
// bean, a green 1kg sack, a cold-brew rig — produces a visual that lies about
// what Minuto sells. This is the check that would have stopped every one of
// the four Veneto renders.
export function screenHeroProduct(
  productName: unknown,
  index: BrandIndex,
): { ok: true } | { ok: false; verdict: BrandVerdict; why: string } {
  const name = String(productName ?? '').trim()
  if (!name) return { ok: true }        // absence is handled by the worker's own validation
  const verdict = index.classify(name)
  switch (verdict) {
    case 'banned_green':
      return { ok: false, verdict, why: `"${name}" is green/unroasted coffee and must never be a bag_hero product` }
    case 'banned_reseller_coffee':
      return { ok: false, verdict, why: `"${name}" is resold third-party coffee (Veneto) and must never be rendered as a Minuto bag` }
    case 'paired_equipment':
      return { ok: false, verdict, why: `"${name}" is brewing equipment, not a Minuto bag — bag_hero requires one of our roasts` }
    default:
      return { ok: true }
  }
}
