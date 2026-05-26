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

// ── Google Ads — aggregated views the orchestrator uses for paid-intent signals
// google-sync populates google_keywords_daily + google_search_terms daily.
// We aggregate across the lookback window so the strategist sees consolidated
// totals, not per-day rows. Used as input to "which paid keywords convert →
// seed organic content for them".
// ──

export interface PaidKeywordSignal {
  keyword:       string
  match_type:    string | null
  impressions:   number
  clicks:        number
  cost_ils:      number      // converted from cost_micros for readability
  conversions:   number
  conv_value:    number
  ctr:           number
  cost_per_conv: number | null
}

export async function fetchTopConvertingPaidKeywords(
  supabase: SupabaseClient,
  lookbackDays = 30,
  limit = 20,
): Promise<PaidKeywordSignal[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000)
    .toISOString().split('T')[0]
  const { data, error } = await supabase
    .from('google_keywords_daily')
    .select('keyword_text, match_type, impressions, clicks, cost_micros, conversions, conversion_value, ctr')
    .gte('date', since)
    .limit(2000)
  if (error) throw new Error(`fetchTopConvertingPaidKeywords failed: ${error.message}`)

  const agg = new Map<string, PaidKeywordSignal>()
  for (const r of (data ?? []) as Array<{
    keyword_text: string | null
    match_type:   string | null
    impressions:  number | null
    clicks:       number | null
    cost_micros:  number | null
    conversions:  number | null
    conversion_value: number | null
    ctr:          number | null
  }>) {
    const k = (r.keyword_text ?? '').trim()
    if (!k) continue
    const key = `${k}|${r.match_type ?? ''}`
    const prev = agg.get(key)
    const imp   = r.impressions ?? 0
    const clk   = r.clicks ?? 0
    const costI = (r.cost_micros ?? 0) / 1_000_000
    const conv  = Number(r.conversions ?? 0)
    const convV = Number(r.conversion_value ?? 0)
    if (!prev) {
      agg.set(key, {
        keyword:       k,
        match_type:    r.match_type,
        impressions:   imp,
        clicks:        clk,
        cost_ils:      costI,
        conversions:   conv,
        conv_value:    convV,
        ctr:           imp > 0 ? clk / imp : 0,
        cost_per_conv: conv > 0 ? costI / conv : null,
      })
    } else {
      prev.impressions += imp
      prev.clicks      += clk
      prev.cost_ils    += costI
      prev.conversions += conv
      prev.conv_value  += convV
      prev.ctr          = prev.impressions > 0 ? prev.clicks / prev.impressions : 0
      prev.cost_per_conv = prev.conversions > 0 ? prev.cost_ils / prev.conversions : null
    }
  }

  // Rank by conversions DESC then conv_value DESC — converting keywords
  // are the organic-content seed signal we care about. Impression-only
  // paid keywords (no conversions) are noise for SEO planning.
  return Array.from(agg.values())
    .filter(r => r.conversions > 0 || r.clicks >= 5)  // drop zero-signal rows
    .sort((a, b) => (b.conversions - a.conversions) || (b.conv_value - a.conv_value))
    .slice(0, limit)
}

export interface SearchTermSignal {
  search_term:         string
  triggering_keyword:  string | null
  impressions:         number
  clicks:              number
  conversions:         number
  cost_ils:            number
}

export async function fetchTopConvertingSearchTerms(
  supabase: SupabaseClient,
  lookbackDays = 30,
  limit = 20,
): Promise<SearchTermSignal[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000)
    .toISOString().split('T')[0]
  const { data, error } = await supabase
    .from('google_search_terms')
    .select('search_term, triggering_keyword, impressions, clicks, conversions, cost_micros')
    .gte('date', since)
    .limit(2000)
  if (error) throw new Error(`fetchTopConvertingSearchTerms failed: ${error.message}`)

  const agg = new Map<string, SearchTermSignal>()
  for (const r of (data ?? []) as Array<{
    search_term: string | null
    triggering_keyword: string | null
    impressions: number | null
    clicks: number | null
    conversions: number | null
    cost_micros: number | null
  }>) {
    const t = (r.search_term ?? '').trim()
    if (!t) continue
    const prev = agg.get(t)
    const imp = r.impressions ?? 0
    const clk = r.clicks ?? 0
    const conv = Number(r.conversions ?? 0)
    const cost = (r.cost_micros ?? 0) / 1_000_000
    if (!prev) {
      agg.set(t, {
        search_term:         t,
        triggering_keyword:  r.triggering_keyword,
        impressions:         imp,
        clicks:              clk,
        conversions:         conv,
        cost_ils:            cost,
      })
    } else {
      prev.impressions += imp
      prev.clicks      += clk
      prev.conversions += conv
      prev.cost_ils    += cost
    }
  }

  return Array.from(agg.values())
    .filter(r => r.conversions > 0 || r.clicks >= 3)
    .sort((a, b) => (b.conversions - a.conversions) || (b.clicks - a.clicks))
    .slice(0, limit)
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
