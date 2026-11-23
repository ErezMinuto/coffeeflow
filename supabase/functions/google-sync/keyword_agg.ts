// Per-keyword totals for the legacy keyword_ideas table. Google Ads returns
// int64 metrics (impressions, clicks, costMicros) as JSON strings, so they
// must be converted before adding: `0 + "16" + "27"` is the string "01627",
// which is how keyword_ideas came to hold values like 4,044,146,101,862,256,405.
// Pure — no database.

export interface KeywordTotals { impressions: number; clicks: number; cost: number; matchType: string; impShare: number; impShareN: number }

/** A Google Ads metric as a number: strings parsed, missing or unreadable → 0. */
export function metric(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function addKeywordRow(agg: Map<string, KeywordTotals>, kw: string, matchType: string, m: Record<string, unknown> | undefined): void {
  const a = agg.get(kw) ?? { impressions: 0, clicks: 0, cost: 0, matchType, impShare: 0, impShareN: 0 }
  a.impressions += metric(m?.impressions)
  a.clicks += metric(m?.clicks)
  a.cost += metric(m?.costMicros) / 1_000_000
  const share = metric(m?.searchImpressionShare)
  if (share) { a.impShare += share; a.impShareN += 1 }
  agg.set(kw, a)
}
