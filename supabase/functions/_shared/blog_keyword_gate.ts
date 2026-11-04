// Blog keyword gate: a content_blog recommendation must target a keyword
// that is IN our Google research, and must not cannibalize an existing post.
// Pure, so both gates are unit-tested; callers fetch the data.
//
// Research sources (both real Google data, both synced twice daily):
//   • search_console  — google_search_console: queries people searched that
//                       showed minuto.co.il (impressions, clicks, position,
//                       and the page that ranked).
//   • google_ads      — keyword_ideas: the Google Ads keywords we bid on and
//                       their ad impressions (filled by google-sync; despite
//                       the column name avg_monthly_searches, it is ad
//                       impressions over the sync window, NOT Keyword Planner).
//
// Strict cannibalization: any conflicting post blocks, and a check that could
// not run (WordPress unreachable) also blocks. Never silently write a second
// post on the same keyword; refreshing the existing post is proposed as advice.

import { normalizeForMatch, type CannibalizationResult } from '../seo-agent/cannibalizationCheck.ts'

export type ResearchSource = 'search_console' | 'google_ads'

export interface ResearchKeyword {
  source:       ResearchSource
  keyword:      string
  impressions:  number          // GSC impressions, or Google Ads impressions
  clicks?:      number
  position?:    number | null   // GSC average position
  ranking_page?: string | null  // GSC page that ranked for it (an existing post covering it)
}

export interface BlogResearchEvidence { source: ResearchSource; keyword: string }

/** Same normalisation the cannibalization gate uses (case, niqqud, punctuation). */
export const normKeyword = (s: string) => normalizeForMatch(String(s ?? ''))

/** Index research rows by source + normalised keyword. */
export function indexResearch(rows: ResearchKeyword[]): Map<string, ResearchKeyword> {
  const m = new Map<string, ResearchKeyword>()
  for (const r of rows) {
    const k = normKeyword(r.keyword)
    if (!k) continue
    const key = `${r.source}|${k}`
    const prev = m.get(key)
    if (!prev || r.impressions > prev.impressions) m.set(key, r)
  }
  return m
}

/** Problems with a content_blog rec's research evidence; [] when it is grounded.
 *  The rec's keyword must EQUAL (normalised) a keyword in the named source. */
export function blogResearchProblems(
  params: Record<string, unknown> | undefined,
  index: Map<string, ResearchKeyword>,
): string[] {
  const p = params ?? {}
  const keyword = typeof p.keyword === 'string' ? p.keyword : ''
  const research = (p.research && typeof p.research === 'object') ? p.research as Record<string, unknown> : null
  if (!normKeyword(keyword)) return ['action_params.keyword is required (the exact research keyword)']
  if (!research) return ['action_params.research {source, keyword} is required: pick the keyword from get_keyword_research']
  const source = research.source
  if (source !== 'search_console' && source !== 'google_ads') return ['action_params.research.source must be "search_console" or "google_ads"']
  const rk = typeof research.keyword === 'string' ? research.keyword : ''
  if (normKeyword(rk) !== normKeyword(keyword)) return [`action_params.keyword "${keyword}" must equal action_params.research.keyword "${rk}"`]
  if (!index.has(`${source}|${normKeyword(rk)}`)) {
    return [`keyword "${keyword}" is not in the ${source} research data; choose a keyword returned by get_keyword_research`]
  }
  return []
}

export interface CannibalVerdict { block: boolean; reason: string; conflicts: Array<{ title: string; link: string; status: string }> }

/** Strict reading of a cannibalization check: a conflict blocks, and so does a
 *  check that could not run. Also blocks when Search Console shows one of our
 *  pages already ranking for the keyword (an existing post covers it). */
export function cannibalVerdict(result: CannibalizationResult, rankingPage?: string | null): CannibalVerdict {
  if (!result.checked) {
    return { block: true, conflicts: [], reason: `could not verify cannibalization (${result.reason ?? 'check did not run'}); refusing rather than risking a duplicate post` }
  }
  const conflicts = result.conflicts.map(c => ({ title: c.title, link: c.link, status: c.status }))
  if (conflicts.length > 0) {
    return { block: true, conflicts, reason: `existing post(s) already cover this keyword: ${conflicts.map(c => `"${c.title}" (${c.status}) ${c.link}`).join('; ')}. Propose refreshing that post as advice (action_type "none") instead` }
  }
  // Minuto blog posts live at /blog/<slug>/ (product and category pages are not posts).
  if (rankingPage && /\/blog\/[^/?#]+/.test(rankingPage)) {
    return { block: true, conflicts: [], reason: `Search Console shows our post ${rankingPage} already ranking for this keyword. Propose refreshing it as advice (action_type "none") instead` }
  }
  return { block: false, conflicts: [], reason: '' }
}
