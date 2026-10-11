// Reads the metrics layer (supabase/migrations/20261010_metrics_layer.sql).
// Every page that shows revenue, real orders or ROAS goes through here, so the
// dashboard and the agents always show the same numbers.
//
// Definitions: revenue = MFlow, ex-VAT. A real order = a web sale in MFlow,
// attributed to a campaign by gclid, then utm_campaign (id or name).
import { supabase } from './supabase'
import { DateRange } from './types'

export interface PaidCampaignRow {
  platform: 'google' | 'meta'
  campaign_id: string | null      // null = paid orders no campaign could claim
  name: string
  spend: number
  clicks: number
  impressions: number
  platform_purchases: number | null  // what the ad platform itself reports; diagnostic
  orders: number                  // real attributed web orders
  revenue_ex_vat: number          // real attributed revenue, ex-VAT
  real_roas: number | null
  real_cpa: number | null
}

const iso = (d: Date) => d.toISOString().split('T')[0]

export function rangeToDays(range: DateRange): { days: number; end: string } {
  const ms = new Date(iso(range.to)).getTime() - new Date(iso(range.from)).getTime()
  return { days: Math.max(1, Math.round(ms / 86_400_000) + 1), end: iso(range.to) }
}

export async function fetchPaidSummary(
  range: DateRange,
  platform?: 'google' | 'meta',
): Promise<{ rows: PaidCampaignRow[]; error: string | null }> {
  const { days, end } = rangeToDays(range)
  const { data, error } = await supabase.rpc('mx_paid_summary', { p_days: days, p_end: end })
  if (error) return { rows: [], error: error.message }
  const rows = ((data ?? []) as any[])
    .map(r => ({
      platform: r.platform,
      campaign_id: r.campaign_id,
      name: r.name ?? r.campaign_id ?? '(unattributed)',
      spend: Number(r.spend ?? 0),
      clicks: Number(r.clicks ?? 0),
      impressions: Number(r.impressions ?? 0),
      platform_purchases: r.platform_purchases == null ? null : Number(r.platform_purchases),
      orders: Number(r.orders ?? 0),
      revenue_ex_vat: Number(r.revenue_ex_vat ?? 0),
      real_roas: r.real_roas == null ? null : Number(r.real_roas),
      real_cpa: r.real_cpa == null ? null : Number(r.real_cpa),
    }) as PaidCampaignRow)
    .filter(r => !platform || r.platform === platform)
  return { rows, error: null }
}
