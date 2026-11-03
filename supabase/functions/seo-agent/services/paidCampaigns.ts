// Running paid campaigns, for the strategist's business snapshot and the draft
// critic (so a new ad is planned and judged around what is already live).
//
// Read-only, from the synced tables (meta-sync / google-sync). Budgets for the
// HARD guard come live from the platforms in meta-ads-draft / google-ads-draft;
// this view is for planning and overlap checks, so it states how fresh it is
// rather than pretending to be live.

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any }

export interface ActivePaidCampaign {
  platform:          'meta' | 'google'
  campaign_id:       string
  name:              string
  objective:         string | null     // Meta objective / Google channel type
  daily_budget_ils:  number | null     // Google only (settings sync); Meta: null, see note
  spend_ils:         number            // last `days` days
  clicks:            number
  purchases:         number
  purchase_value_ils: number
  last_data_date:    string
}

export interface ActivePaidCampaigns {
  window_days:          number
  campaigns:            ActivePaidCampaign[]
  meta_data_as_of:      string | null
  google_data_as_of:    string | null
  google_budgets_as_of: string | null
  note:                 string
}

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
const r2 = (v: number) => Math.round(v * 100) / 100

interface DailyRow { campaign_id: unknown; date: string; name?: string | null; status?: string | null; objective?: string | null }

/** Pure: roll daily rows up per campaign, keep the ones whose LATEST row is
 *  active and recent. `activeStatus` = 'ACTIVE' (Meta) / 'ENABLED' (Google). */
export function rollUpActive<T extends DailyRow>(
  rows: T[],
  activeStatus: string,
  freshSince: string,
  metrics: (r: T) => { spend: number; clicks: number; purchases: number; value: number },
): Array<Omit<ActivePaidCampaign, 'platform' | 'daily_budget_ils'>> {
  const by = new Map<string, { latest: T; spend: number; clicks: number; purchases: number; value: number }>()
  for (const r of rows) {
    const id = String(r.campaign_id ?? '')
    if (!id || !r.date) continue
    const m = metrics(r)
    const cur = by.get(id)
    if (!cur) { by.set(id, { latest: r, spend: m.spend, clicks: m.clicks, purchases: m.purchases, value: m.value }); continue }
    if (r.date > cur.latest.date) cur.latest = r
    cur.spend += m.spend; cur.clicks += m.clicks; cur.purchases += m.purchases; cur.value += m.value
  }
  return [...by.entries()]
    .filter(([, c]) => c.latest.status === activeStatus && c.latest.date >= freshSince)
    .map(([id, c]) => ({
      campaign_id: id, name: c.latest.name ?? id, objective: c.latest.objective ?? null,
      spend_ils: r2(c.spend), clicks: Math.round(c.clicks), purchases: r2(c.purchases),
      purchase_value_ils: r2(c.value), last_data_date: c.latest.date,
    }))
    .sort((a, b) => b.spend_ils - a.spend_ils)
}

function isoDaysAgo(days: number, now = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
}

export async function fetchActivePaidCampaigns(supabase: Db, days = 30, now = new Date()): Promise<ActivePaidCampaigns> {
  const since = isoDaysAgo(days, now)
  const freshSince = isoDaysAgo(3, now)   // "still running" = active in the last 3 days of data
  const [meta, google, settings] = await Promise.all([
    supabase.from('meta_ad_campaigns')
      .select('campaign_id, date, name, status, objective, spend, clicks, purchases, purchase_value')
      .gte('date', since).order('date', { ascending: false }).limit(10_000),
    supabase.from('google_campaigns')
      .select('campaign_id, date, name, status, cost, clicks, conversions, conversion_value')
      .gte('date', since).order('date', { ascending: false }).limit(10_000),
    supabase.from('google_campaign_settings')
      .select('campaign_id, advertising_channel_type, daily_budget_micros, synced_at').eq('status', 'ENABLED').limit(1000),
  ])
  for (const [label, res] of [['meta_ad_campaigns', meta], ['google_campaigns', google], ['google_campaign_settings', settings]] as const) {
    if (res.error) throw new Error(`${label} read failed: ${res.error.message}`)
  }
  const metaRows = (meta.data ?? []) as Array<DailyRow & Record<string, unknown>>
  const googleRows = (google.data ?? []) as Array<DailyRow & Record<string, unknown>>
  const settingsRows = (settings.data ?? []) as Array<Record<string, any>>
  const budgetById = new Map(settingsRows.map(s => [String(s.campaign_id), s]))

  const metaActive = rollUpActive(metaRows, 'ACTIVE', freshSince,
    r => ({ spend: n(r.spend), clicks: n(r.clicks), purchases: n(r.purchases), value: n(r.purchase_value) }))
    .map(c => ({ ...c, platform: 'meta' as const, daily_budget_ils: null }))
  const googleActive = rollUpActive(googleRows, 'ENABLED', freshSince,
    r => ({ spend: n(r.cost), clicks: n(r.clicks), purchases: n(r.conversions), value: n(r.conversion_value) }))
    .map(c => {
      const s = budgetById.get(c.campaign_id)
      const micros = s?.daily_budget_micros
      return {
        ...c, platform: 'google' as const,
        objective: s?.advertising_channel_type ?? c.objective,
        daily_budget_ils: micros == null || micros === '' ? null : r2(Number(micros) / 1_000_000),
      }
    })

  const maxDate = (rows: DailyRow[]) => rows.reduce<string | null>((m, r) => (r.date && (!m || r.date > m) ? r.date : m), null)
  const settingsAsOf = settingsRows.reduce<string | null>((m, s) => (s.synced_at && (!m || s.synced_at > m) ? s.synced_at : m), null)
  return {
    window_days: days,
    campaigns: [...metaActive, ...googleActive],
    meta_data_as_of: maxDate(metaRows),
    google_data_as_of: maxDate(googleRows),
    google_budgets_as_of: settingsAsOf,
    note: 'Synced data, not live. Meta budgets are not synced (null); the draft functions check live budgets before creating anything.',
  }
}
