// Minuto SEO Agent — Google Search Console reader.
//
// Reads from the existing `google_search_console` table (populated by a
// daily sync job that lives outside this module). We don't call the
// GSC API directly here — that's the sync job's responsibility — we
// just read the synced snapshot for orchestrator consumption.
//
// If/when we want fresh-from-Google data without waiting for the daily
// sync, this is where we'd add a live API call (using the existing
// google-search-sync function as a template).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export interface GscKeywordRow {
  keyword: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

// Returns top N keywords by impressions over the lookback window. Excludes
// the synthetic '__page__' aggregate row (it's a page-level summary, not
// a keyword).
export async function fetchTopKeywords(
  supabase: SupabaseClient,
  lookbackDays = 30,
  limit = 30,
): Promise<GscKeywordRow[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000)
    .toISOString().split('T')[0]
  const { data, error } = await supabase
    .from('google_search_console')
    .select('keyword, clicks, impressions, ctr, position')
    .neq('keyword', '__page__')
    .gte('date', since)
    .order('impressions', { ascending: false })
    .limit(limit * 3) // pull extra so we can aggregate across multiple dates
  if (error) throw new Error(`fetchTopKeywords failed: ${error.message}`)

  // Aggregate across dates — one keyword may appear on many rows. Sum
  // clicks/impressions, average position weighted by impressions.
  const byKeyword = new Map<string, GscKeywordRow & { _impSum: number }>()
  for (const r of (data ?? []) as Array<{
    keyword: string
    clicks: number
    impressions: number
    ctr: number
    position: number
  }>) {
    const k = r.keyword
    const prev = byKeyword.get(k)
    const imp = r.impressions ?? 0
    if (!prev) {
      byKeyword.set(k, {
        keyword:     k,
        clicks:      r.clicks ?? 0,
        impressions: imp,
        ctr:         r.ctr ?? 0,
        position:    r.position ?? 0,
        _impSum:     imp,
      })
    } else {
      prev.clicks      += r.clicks ?? 0
      prev.impressions += imp
      prev.position     = (prev.position * prev._impSum + (r.position ?? 0) * imp) / (prev._impSum + imp || 1)
      prev._impSum     += imp
      prev.ctr          = prev.impressions > 0 ? prev.clicks / prev.impressions : 0
    }
  }

  return Array.from(byKeyword.values())
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
    .map(({ _impSum: _, ...rest }) => rest)
}

// Position deltas vs a prior snapshot. Used by the orchestrator to spot
// "kapsulot moved from #15 to #8" trends.
export function computePositionDeltas(
  current: GscKeywordRow[],
  prior: GscKeywordRow[] | null,
): Array<{ keyword: string; prev_position: number | null; new_position: number; delta: number }> {
  const priorMap = new Map<string, number>()
  for (const r of prior ?? []) priorMap.set(r.keyword, r.position)
  return current.map(c => {
    const prev = priorMap.has(c.keyword) ? priorMap.get(c.keyword)! : null
    const delta = prev == null ? 0 : (c.position - prev)
    return { keyword: c.keyword, prev_position: prev, new_position: c.position, delta }
  })
}
