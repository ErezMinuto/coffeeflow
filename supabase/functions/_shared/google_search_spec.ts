// Google SEARCH campaign spec for the strategist loop: the prompt that asks the
// model for one, and the local check of Google's hard limits (run before the
// free validate_only call, so an over-long headline costs nothing).
// Contract = google-ads-draft's create spec (see marketing-advisor's
// draft_google_campaign tool for the full field list). Search only.

export interface GoogleSearchSpec {
  campaign_name:      string
  campaign_type:      'search'
  daily_budget_ils:   number
  duration_days:      number
  keywords:           string[]
  match_type:         'EXACT' | 'PHRASE'
  negative_keywords:  string[]
  creative:           { headlines: string[]; descriptions: string[]; path1?: string; path2?: string }
  landing_page_url:   string
}

export const GOOGLE_SEARCH_SPEC_SYSTEM = `You build ONE Google Ads SEARCH campaign spec for Minuto Coffee (מינוטו קפה בית קלייה ספיישלטי), an Israeli specialty roaster that roasts weekly and sells roasted beans online at minuto.co.il.
Hebrew ad copy: natural, specific, gender-inclusive (no masculine-only verbs), no em-dashes, never mention or compare with competitors or supermarket coffee, never invent product facts, no discounts unless the brief asks. Retail bag is 330g. Say "בית קלייה", never "מקלה".
Google COUNTS CHARACTERS and rejects anything over the limit. Count every headline before you write it.
Return JSON only:
{"campaign_name": string, "campaign_type": "search", "daily_budget_ils": number, "duration_days": number,
 "keywords": [string] (use the brief's keywords; you may drop poor ones, do not invent new search demand),
 "match_type": "PHRASE" | "EXACT" (never BROAD on a small budget),
 "negative_keywords": [string] (include unwanted intents such as free, recipe-only, jobs, green/unroasted beans, Veneto),
 "creative": {"headlines": [3-15 strings, each <= 30 characters], "descriptions": [2-4 strings, each <= 90 characters], "path1": "<= 15 chars", "path2": "<= 15 chars"},
 "landing_page_url": "https://www.minuto.co.il/..." (use the landing URL given)}`

const len = (s: string) => Array.from(s).length   // code points, not UTF-16 units

/** Every problem with a spec, or [] when it is within Google's limits and our rules. */
export function googleSearchSpecProblems(spec: unknown, maxDailyIls = 100): string[] {
  const p: string[] = []
  if (!spec || typeof spec !== 'object') return ['spec is not an object']
  const s = spec as Record<string, any>
  if (s.campaign_type !== 'search') p.push('campaign_type must be "search"')
  if (typeof s.campaign_name !== 'string' || !s.campaign_name.trim()) p.push('campaign_name missing')
  const daily = Number(s.daily_budget_ils)
  if (typeof s.daily_budget_ils !== 'number' || !(daily > 0) || daily > maxDailyIls) p.push(`daily_budget_ils must be a number in (0, ${maxDailyIls}]`)
  if (typeof s.duration_days !== 'number' || !(s.duration_days >= 1) || s.duration_days > 90) p.push('duration_days must be 1-90')
  if (!Array.isArray(s.keywords) || s.keywords.length === 0 || s.keywords.some((k: unknown) => typeof k !== 'string' || !k.trim())) p.push('keywords must be a non-empty list of strings')
  if (s.match_type !== 'EXACT' && s.match_type !== 'PHRASE') p.push('match_type must be EXACT or PHRASE')
  if (!Array.isArray(s.negative_keywords) || s.negative_keywords.some((k: unknown) => typeof k !== 'string')) p.push('negative_keywords must be a list of strings')
  const c = s.creative ?? {}
  const h = Array.isArray(c.headlines) ? c.headlines : null
  const d = Array.isArray(c.descriptions) ? c.descriptions : null
  if (!h || h.length < 3 || h.length > 15) p.push('creative.headlines must have 3-15 items')
  else h.forEach((x: unknown, i: number) => { if (typeof x !== 'string' || !x.trim() || len(x) > 30) p.push(`headline ${i + 1} must be 1-30 characters (got ${typeof x === 'string' ? len(x) : typeof x})`) })
  if (!d || d.length < 2 || d.length > 4) p.push('creative.descriptions must have 2-4 items')
  else d.forEach((x: unknown, i: number) => { if (typeof x !== 'string' || !x.trim() || len(x) > 90) p.push(`description ${i + 1} must be 1-90 characters (got ${typeof x === 'string' ? len(x) : typeof x})`) })
  for (const k of ['path1', 'path2']) if (c[k] != null && (typeof c[k] !== 'string' || len(c[k]) > 15)) p.push(`${k} must be <= 15 characters`)
  let url: URL | null = null
  try { url = new URL(String(s.landing_page_url)) } catch { /* reported below */ }
  if (!url || url.protocol !== 'https:' || !/(^|\.)minuto\.co\.il$/.test(url.hostname)) p.push('landing_page_url must be an https URL on minuto.co.il')
  return p
}
