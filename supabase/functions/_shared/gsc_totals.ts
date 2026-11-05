// Per-keyword Search Console totals, summed in the database by the
// gsc_keyword_totals(p_since, p_until) SQL function (migration 20261105b).
// The table holds one row per keyword per day (~80k rows for 90 days), so the
// readers ask for totals instead of fetching and summing daily rows.
//
// PostgREST caps an RPC response at max-rows (1,000), so `top` asks for the N
// best by impressions in one request; without it every keyword is read, paged
// by keyword (unique per result row).

import { selectAll } from './select_all.ts'

export interface GscKeywordTotal {
  keyword:     string
  clicks:      number
  impressions: number
  ctr:         number
  position:    number
  days:        number
  last_date:   string
}

// deno-lint-ignore no-explicit-any
type Db = { rpc(fn: string, args: Record<string, unknown>): any }

export async function fetchGscKeywordTotals(supabase: Db, since: string, opts: { top?: number } = {}): Promise<GscKeywordTotal[]> {
  const call = () => supabase.rpc('gsc_keyword_totals', { p_since: since })
  // deno-lint-ignore no-explicit-any
  const norm = (r: any): GscKeywordTotal => ({
    keyword:     String(r.keyword),
    clicks:      Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
    ctr:         Number(r.ctr) || 0,
    position:    Number(r.position) || 0,
    days:        Number(r.days) || 0,
    last_date:   String(r.last_date ?? ''),
  })
  if (opts.top != null) {
    const n = Math.max(1, Math.min(1000, Math.floor(opts.top)))
    const { data, error } = await call().order('impressions', { ascending: false }).order('keyword').limit(n)
    if (error) throw new Error(`gsc_keyword_totals failed: ${error.message}`)
    return (data ?? []).map(norm)
  }
  const rows = await selectAll((from, to) => call().order('keyword').range(from, to), { label: 'gsc_keyword_totals' })
  return rows.map(norm)
}
