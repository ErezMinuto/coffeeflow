// Shared marketing-intelligence fetchers.
//
// One implementation, consumed by BOTH the paid advisor and the strategist
// brain. They had been drifting apart — the advisor could read Search Console
// and the brain could not; neither could read GA4 at all — and two copies of
// "what does the business look like" is how two agents end up giving
// contradictory advice from the same database.
//
// Every function is READ-ONLY and returns a compact, already-aggregated shape.
// The point is to hand a model conclusions it can reason about, not raw rows it
// has to re-aggregate in its head (and get wrong).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const clampDays = (d: unknown, def = 30, max = 365) =>
  Math.max(1, Math.min(max, Number(d) || def))
const since = (days: number) =>
  new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
const r2 = (n: number) => Math.round(n * 100) / 100

// ── GA4 ─────────────────────────────────────────────────────────────────────
// Channel-level behaviour plus the landing pages that carry it.
//
// NOTE ON COVERAGE: ga4-sync defaults to Organic Search only. Other channels
// exist in the table only if someone has run the sync with an explicit
// channel_group. If a channel is missing here it means nobody synced it — NOT
// that it had no traffic. The response says which channels it actually found so
// that distinction is never silently lost.
export async function getGa4Data(
  supabase: SupabaseClient,
  args: { window_days?: number; channel?: string; top_pages?: number } = {},
) {
  const days = clampDays(args.window_days, 30, 365)
  let q = supabase
    .from('ga4_pages_daily')
    .select('date, page_path, channel_group, sessions, engaged_sessions, screen_page_views, bounce_rate, avg_session_duration, conversions, conversion_value')
    .gte('date', since(days))
    .limit(5000)
  if (args.channel) q = q.eq('channel_group', args.channel)
  const { data, error } = await q
  if (error) throw new Error(`ga4 query failed: ${error.message}`)
  const rows = data ?? []

  const byChannel = new Map<string, { sessions: number; engaged: number; conv: number; value: number; bounceW: number; durW: number }>()
  const byPage = new Map<string, { sessions: number; conv: number; value: number; channel: string }>()
  for (const r of rows as any[]) {
    const ch = r.channel_group ?? '(unset)'
    const s = Number(r.sessions ?? 0)
    const c = byChannel.get(ch) ?? { sessions: 0, engaged: 0, conv: 0, value: 0, bounceW: 0, durW: 0 }
    c.sessions += s
    c.engaged  += Number(r.engaged_sessions ?? 0)
    c.conv     += Number(r.conversions ?? 0)
    c.value    += Number(r.conversion_value ?? 0)
    // Session-weighted, so a one-session page can't swing the channel average.
    c.bounceW  += Number(r.bounce_rate ?? 0) * s
    c.durW     += Number(r.avg_session_duration ?? 0) * s
    byChannel.set(ch, c)

    const p = byPage.get(r.page_path) ?? { sessions: 0, conv: 0, value: 0, channel: ch }
    p.sessions += s; p.conv += Number(r.conversions ?? 0); p.value += Number(r.conversion_value ?? 0)
    byPage.set(r.page_path, p)
  }

  return {
    window_days: days,
    channels_present: [...byChannel.keys()],
    note: 'A channel absent here means nobody ran ga4-sync for it, not that it had no traffic.',
    by_channel: [...byChannel.entries()]
      .map(([channel, v]) => ({
        channel,
        sessions: v.sessions,
        conversions: v.conv,
        conversion_value: r2(v.value),
        // Value per session is the number that actually ranks channels.
        value_per_session: v.sessions ? r2(v.value / v.sessions) : 0,
        bounce_rate: v.sessions ? r2(v.bounceW / v.sessions) : null,
        avg_session_seconds: v.sessions ? Math.round(v.durW / v.sessions) : null,
        engagement_rate: v.sessions ? r2(v.engaged / v.sessions) : null,
      }))
      .sort((a, b) => b.sessions - a.sessions),
    top_landing_pages: [...byPage.entries()]
      .map(([page_path, v]) => ({ page_path, channel: v.channel, sessions: v.sessions, conversions: v.conv, conversion_value: r2(v.value) }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, Math.max(1, Math.min(50, Number(args.top_pages) || 15))),
  }
}

// ── Search Console ──────────────────────────────────────────────────────────
export async function getSearchConsoleData(
  supabase: SupabaseClient,
  args: { window_days?: number; limit?: number; min_impressions?: number } = {},
) {
  const days = clampDays(args.window_days, 30, 180)
  const { data, error } = await supabase
    .from('google_search_console')
    .select('keyword, clicks, impressions, position, date')
    .neq('keyword', '__page__')          // the sync stores page rows under this sentinel
    .gte('date', since(days))
    .limit(5000)
  if (error) throw new Error(`search console query failed: ${error.message}`)

  const agg = new Map<string, { clicks: number; impr: number; posW: number }>()
  for (const r of (data ?? []) as any[]) {
    const k = r.keyword
    const a = agg.get(k) ?? { clicks: 0, impr: 0, posW: 0 }
    const im = Number(r.impressions ?? 0)
    a.clicks += Number(r.clicks ?? 0); a.impr += im
    a.posW += Number(r.position ?? 0) * im   // impression-weighted average position
    agg.set(k, a)
  }
  const minImpr = Number(args.min_impressions) || 0
  const rows = [...agg.entries()]
    .filter(([, v]) => v.impr >= minImpr)
    .map(([keyword, v]) => ({
      keyword, clicks: v.clicks, impressions: v.impr,
      ctr: v.impr ? r2(v.clicks / v.impr) : 0,
      avg_position: v.impr ? r2(v.posW / v.impr) : null,
    }))

  return {
    window_days: days,
    total_keywords: rows.length,
    top_by_clicks: [...rows].sort((a, b) => b.clicks - a.clicks).slice(0, Math.max(1, Math.min(100, Number(args.limit) || 25))),
    // Where rank is already good but nobody clicks — usually a title/snippet
    // problem, which is cheap to fix and invisible in a clicks-sorted list.
    high_impressions_low_ctr: rows
      .filter(r => r.impressions >= Math.max(50, minImpr) && r.ctr < 0.02 && (r.avg_position ?? 99) <= 20)
      .sort((a, b) => b.impressions - a.impressions).slice(0, 15),
  }
}

// ── WooCommerce / real sales ────────────────────────────────────────────────
// Reads mflow_sell_lines, NOT woo_orders. MFlow is a superset: it carries POS,
// back-office AND the web orders (channel 'ecosite', with woocommerce_order_id
// on the row). Measured 2026-08: the web is ~7.6% of revenue and the counter is
// ~69%, so a Woo-only view sees under a tenth of the business.
export async function getWooCommerceData(
  supabase: SupabaseClient,
  args: { window_days?: number; channel?: string; top_products?: number } = {},
) {
  const days = clampDays(args.window_days, 30, 400)
  let q = supabase
    .from('mflow_sell_lines')
    .select('mflow_sell_id, transaction_date, channel, sku, product_name, cf_product_id, quantity, line_revenue_exc_tax, status_class')
    .gte('transaction_date', since(days))
    .neq('status_class', 'excluded')      // drops quotes, drafts, cancellations
    .limit(50000)
  if (args.channel) q = q.eq('channel', args.channel)
  const { data, error } = await q
  if (error) throw new Error(`sales query failed: ${error.message}`)
  const rows = (data ?? []) as any[]

  const orders = new Map<number, number>()
  const byChannel = new Map<string, { revenue: number; orders: Set<number> }>()
  const byProduct = new Map<string, { name: string; units: number; revenue: number; is_bean: boolean }>()
  let paidUnits = 0, freeUnits = 0

  for (const r of rows) {
    const rev = Number(r.line_revenue_exc_tax ?? 0)
    orders.set(r.mflow_sell_id, (orders.get(r.mflow_sell_id) ?? 0) + rev)
    const c = byChannel.get(r.channel) ?? { revenue: 0, orders: new Set<number>() }
    c.revenue += rev; c.orders.add(r.mflow_sell_id); byChannel.set(r.channel, c)
    const key = r.sku ?? r.product_name ?? 'unknown'
    const p = byProduct.get(key) ?? { name: r.product_name ?? key, units: 0, revenue: 0, is_bean: r.cf_product_id != null }
    p.units += Number(r.quantity ?? 0); p.revenue += rev; byProduct.set(key, p)
    if (r.cf_product_id != null) { if (rev > 0) paidUnits += Number(r.quantity ?? 0); else freeUnits += Number(r.quantity ?? 0) }
  }

  const orderVals = [...orders.values()].sort((a, b) => a - b)
  const median = orderVals.length ? orderVals[Math.floor(orderVals.length / 2)] : 0
  const total = orderVals.reduce((s, v) => s + v, 0)

  return {
    window_days: days,
    currency: 'ILS, EXCLUDING VAT',
    orders: orderVals.length,
    revenue_ex_vat: r2(total),
    aov_mean: orderVals.length ? r2(total / orderVals.length) : 0,
    // Median resists a single machine sale dragging the mean; quote both.
    aov_median: r2(median),
    by_channel: [...byChannel.entries()]
      .map(([channel, v]) => ({ channel, orders: v.orders.size, revenue_ex_vat: r2(v.revenue) }))
      .sort((a, b) => b.revenue_ex_vat - a.revenue_ex_vat),
    // Bean units given away at ₪0 — between 9% and 32% of monthly volume.
    // Either bundle components whose price sits on a parent line, or genuine
    // giveaways. They need OPPOSITE treatment, so they are never folded into
    // revenue-per-unit here.
    bean_units_paid: paidUnits,
    bean_units_at_zero: freeUnits,
    top_products: [...byProduct.entries()]
      .map(([sku, v]) => ({ sku, name: v.name, is_bean: v.is_bean, units: Math.round(v.units), revenue_ex_vat: r2(v.revenue) }))
      .sort((a, b) => b.revenue_ex_vat - a.revenue_ex_vat)
      .slice(0, Math.max(1, Math.min(50, Number(args.top_products) || 15))),
  }
}

// ── Meta Ad Library — competitor creative ───────────────────────────────────
// Meta publishes no performance for anyone else's ads. HOW LONG AN AD HAS BEEN
// RUNNING is the proxy: advertisers kill losers within days and let winners run
// for months. So days_running is the signal here, not a timestamp.
//
// That only works with repeated snapshots. With a single snapshot every ad
// looks equally new, which is exactly the state this data was left in — one
// collection in April 2026 and nothing since.
export async function getCompetitorAds(
  supabase: SupabaseClient,
  args: { window_days?: number; limit?: number } = {},
) {
  const days = clampDays(args.window_days, 90, 365)
  const { data, error } = await supabase
    .from('market_research')
    .select('source, research_date, raw_data')
    .like('source', 'meta_ads_%')
    .gte('research_date', since(days))
    .order('research_date', { ascending: false })
    .limit(200)
  if (error) throw new Error(`competitor ads query failed: ${error.message}`)

  const today = new Date()
  const ads: any[] = []
  const snapshots = new Set<string>()
  for (const row of (data ?? []) as any[]) {
    snapshots.add(row.research_date)
    for (const a of (row.raw_data?.ads ?? [])) {
      const started = a.started ? new Date(a.started) : null
      const stopped = a.stopped ? new Date(a.stopped) : null
      // A stopped ad's run is start→stop. A live one is start→now, and is still
      // accruing — so the two are labelled differently rather than blended: a
      // 60-day ad that ENDED is proven, a 60-day ad still running is stronger.
      const end = stopped ?? today
      ads.push({
        page_name: a.page_name ?? null,
        body: (a.bodies ?? [])[0] ?? null,
        headline: (a.link_titles ?? [])[0] ?? null,
        platforms: a.platforms ?? [],
        started: a.started ?? null,
        stopped: a.stopped ?? null,
        still_running: !stopped,
        days_running: started ? Math.max(0, Math.round((+end - +started) / 86400000)) : null,
        seen_on: row.research_date,
      })
    }
  }
  ads.sort((a, b) => (b.days_running ?? -1) - (a.days_running ?? -1))

  return {
    window_days: days,
    snapshot_dates: [...snapshots].sort(),
    ads_found: ads.length,
    // Longevity only becomes meaningful across repeated collections.
    signal_quality: snapshots.size <= 1
      ? 'WEAK — only one snapshot, so days_running cannot distinguish a winner from an ad launched yesterday. Collect weekly before trusting this.'
      : `ok — ${snapshots.size} snapshots`,
    longest_running: ads.slice(0, Math.max(1, Math.min(50, Number(args.limit) || 20))),
  }
}
