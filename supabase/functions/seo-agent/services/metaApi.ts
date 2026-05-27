// Minuto SEO Agent — Meta (FB + IG) reader.
//
// Reads from tables populated by the existing `meta-sync` edge function.
// We don't call Meta Graph here — `meta-sync` owns that. We just consume
// the synced snapshot so the strategist can factor in:
//   1. Which organic IG/FB posts resonate (informs SEO topic picks)
//   2. Which paid ad themes convert (informs SEO topic picks too)
//
// Both feed the same use-case: "social signal → blog content seed".

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export interface OrganicPostSignal {
  post_id:    string
  post_type:  string | null
  message:    string | null
  created_at: string
  reach:      number
  impressions: number
  likes:      number
  comments:   number
  shares:     number
  saves:      number
  // Cheap engagement composite — higher = more engagement per impression.
  // Used to rank "what's actually working" beyond raw vanity counts.
  engagement_rate: number
}

export async function fetchTopOrganicPosts(
  supabase: SupabaseClient,
  lookbackDays = 30,
  limit = 10,
): Promise<OrganicPostSignal[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString()
  const { data, error } = await supabase
    .from('meta_organic_posts')
    .select('post_id, post_type, message, created_at, reach, impressions, likes, comments, shares, saves')
    .gte('created_at', since)
    .order('impressions', { ascending: false })
    .limit(limit * 3)  // pull extra so engagement_rate ranking can re-rank
  if (error) throw new Error(`fetchTopOrganicPosts failed: ${error.message}`)

  const rows = (data ?? []) as Array<{
    post_id: string
    post_type: string | null
    message: string | null
    created_at: string
    reach: number | null
    impressions: number | null
    likes: number | null
    comments: number | null
    shares: number | null
    saves: number | null
  }>

  const enriched: OrganicPostSignal[] = rows.map(r => {
    const imp = r.impressions ?? 0
    const engagementCount = (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0) + (r.saves ?? 0)
    return {
      post_id:         r.post_id,
      post_type:       r.post_type,
      message:         r.message,
      created_at:      r.created_at,
      reach:           r.reach ?? 0,
      impressions:     imp,
      likes:           r.likes ?? 0,
      comments:        r.comments ?? 0,
      shares:          r.shares ?? 0,
      saves:           r.saves ?? 0,
      engagement_rate: imp > 0 ? engagementCount / imp : 0,
    }
  })

  // Re-rank by engagement rate (not raw impressions) so a small high-engagement
  // post outranks a viral low-engagement one — the former signals topic resonance
  // more cleanly. Tie-break on impressions.
  return enriched
    .sort((a, b) => (b.engagement_rate - a.engagement_rate) || (b.impressions - a.impressions))
    .slice(0, limit)
}

// ── Meta Ads aggregated insights ─────────────────────────────────────────
// meta_ad_daily has one row per ad per day. We aggregate to ad-level
// totals so the strategist sees "which ads converted recently" without
// drowning in daily rows. Joining to meta_ads/campaigns for names would
// be nice but adds round-trips; for v1 we just surface ad_id + metrics.

export interface AdInsightSignal {
  ad_id:           string
  campaign_id:     string | null
  impressions:     number
  clicks:          number
  spend_ils:       number
  conversions:     number
  ctr:             number
  cost_per_conv:   number | null
}

export async function fetchTopConvertingAds(
  supabase: SupabaseClient,
  lookbackDays = 30,
  limit = 10,
): Promise<AdInsightSignal[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000)
    .toISOString().split('T')[0]
  const { data, error } = await supabase
    .from('meta_ad_daily')
    .select('ad_id, campaign_id, impressions, clicks, spend, conversions')
    .gte('date', since)
    .limit(2000)
  if (error) throw new Error(`fetchTopConvertingAds failed: ${error.message}`)

  const agg = new Map<string, AdInsightSignal>()
  for (const r of (data ?? []) as Array<{
    ad_id: string | null
    campaign_id: string | null
    impressions: number | null
    clicks: number | null
    spend: number | null
    conversions: number | null
  }>) {
    const k = r.ad_id ?? ''
    if (!k) continue
    const prev = agg.get(k)
    const imp  = r.impressions ?? 0
    const clk  = r.clicks ?? 0
    const sp   = Number(r.spend ?? 0)
    const conv = Number(r.conversions ?? 0)
    if (!prev) {
      agg.set(k, {
        ad_id:         k,
        campaign_id:   r.campaign_id,
        impressions:   imp,
        clicks:        clk,
        spend_ils:     sp,
        conversions:   conv,
        ctr:           imp > 0 ? clk / imp : 0,
        cost_per_conv: conv > 0 ? sp / conv : null,
      })
    } else {
      prev.impressions += imp
      prev.clicks      += clk
      prev.spend_ils   += sp
      prev.conversions += conv
      prev.ctr          = prev.impressions > 0 ? prev.clicks / prev.impressions : 0
      prev.cost_per_conv = prev.conversions > 0 ? prev.spend_ils / prev.conversions : null
    }
  }

  return Array.from(agg.values())
    .filter(r => r.conversions > 0 || r.clicks >= 5)
    .sort((a, b) => (b.conversions - a.conversions) || (b.spend_ils - a.spend_ils))
    .slice(0, limit)
}
