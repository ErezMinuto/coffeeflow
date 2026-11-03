// conclude_brief gate for paid-ad recommendations (ad_meta / ad_google), the
// same way blog recommendations must name real products: a bad one is refused
// with the reason so the brain fixes it and re-calls conclude_brief.
// The executor checks again at draft time (catalog / stock can change).

export const MAX_AD_RECS_PER_BRIEF = 2
const MAX_DAILY_ILS = 100

interface RecLike { title?: string; action_type?: string; action_params?: Record<string, unknown> }

function okUrl(u: unknown): boolean {
  try { const x = new URL(String(u)); return x.protocol === 'https:' && /(^|\.)minuto\.co\.il$/.test(x.hostname) } catch { return false }
}

/** Problems with the brief's ad recommendations; [] when they are acceptable. */
export function adRecommendationProblems(recs: RecLike[], lineup: string[]): string[] {
  const problems: string[] = []
  const names = new Set(lineup)
  const ads = recs.map((r, i) => ({ r, i })).filter(({ r }) => r.action_type === 'ad_meta' || r.action_type === 'ad_google')
  if (ads.length > MAX_AD_RECS_PER_BRIEF) problems.push(`at most ${MAX_AD_RECS_PER_BRIEF} paid-ad recommendations per brief (got ${ads.length}); keep the strongest`)
  for (const { r, i } of ads) {
    const p = (r.action_params ?? {}) as Record<string, unknown>
    const at = `recommendations[${i}] "${r.title ?? ''}"`
    const product = typeof p.product === 'string' ? p.product.trim() : ''
    if (product && !names.has(product)) problems.push(`${at}: product "${product}" is not an exact Minuto coffee lineup name`)
    if (p.daily_budget_ils != null && !(typeof p.daily_budget_ils === 'number' && p.daily_budget_ils > 0 && p.daily_budget_ils <= MAX_DAILY_ILS)) {
      problems.push(`${at}: daily_budget_ils must be a number in (0, ${MAX_DAILY_ILS}]`)
    }
    if (p.duration_days != null && !(typeof p.duration_days === 'number' && Number.isInteger(p.duration_days) && p.duration_days >= 1 && p.duration_days <= 90)) {
      problems.push(`${at}: duration_days must be a whole number 1-90`)
    }
    // Any landing_url given must be ours, whatever else is set.
    if (p.landing_url != null && !okUrl(p.landing_url)) problems.push(`${at}: landing_url must be an https URL on minuto.co.il`)
    if (r.action_type === 'ad_meta') {
      if (!product) problems.push(`${at}: ad_meta needs action_params.product (exact lineup name; its real bag photo is the ad image)`)
    } else {
      const kw = p.keywords
      if (!Array.isArray(kw) || kw.length === 0 || kw.length > 50 || kw.some(k => typeof k !== 'string' || !k.trim())) {
        problems.push(`${at}: ad_google needs action_params.keywords, 1-50 non-empty strings grounded in search terms / Search Console`)
      }
      if (!product && p.landing_url == null) problems.push(`${at}: ad_google needs a lineup product or an https landing_url on minuto.co.il`)
    }
  }
  return problems
}
