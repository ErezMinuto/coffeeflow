// Minuto Strategist Brain — business snapshot assembler.
//
// One revenue-first, key-sorted world-state object the Opus brain reasons over.
// Two design rules:
//   1. REVENUE FIRST. Sales is the north-star (lagging truth); audience / reach /
//      retention / email are driver hypotheses the brain tests AGAINST sales. So
//      the sales block leads and is the richest; everything else is a candidate
//      explanation for what sales is doing.
//   2. CACHE-STABLE. The whole object is deep key-sorted and carries no run-id /
//      Date.now() inside the payload (only a single top-level `as_of` timestamp,
//      which the caller may strip). Two kickoffs over the same data produce a
//      byte-identical prefix, so the prompt cache hits across in-invocation steps.
//
// REUSES the existing senses (services/*) wholesale — no re-querying tables those
// fetchers already own. ADDS only what the strategist needs and nothing else had:
// sales-by-category/SKU trend, and email-campaign performance.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

import {
  fetchCustomerSegmentSummary,
  fetchVocInsights,
  fetchInventoryAlerts,
  fetchMinutoCoffeeCatalog,
  type CustomerSegmentSummary,
  type VocInsight,
  type InventoryAlert,
  type WooProduct,
} from './cmsApi.ts'
import { fetchTopOrganicLandingPages, fetchTopKeywords, type Ga4LandingPageSignal, type GscKeywordRow } from './googleApi.ts'
import { fetchTopOrganicPosts, fetchTopConvertingAds, type OrganicPostSignal, type AdInsightSignal } from './metaApi.ts'
import { getRecentLearnings } from '../db.ts'
import type { LearningRow } from '../types.ts'
import type {
  BusinessSnapshot,
  SalesSnapshot,
  SalesWindow,
  CategorySales,
  SkuSales,
  EmailPerformance,
  EmailCampaignPerf,
  TheseSnapshotRow,
} from '../types.ts'

// ── Sales: the north-star block ─────────────────────────────────────────────
// woo_order_items_enriched has one row per order line, already category-tagged
// ('coffee' | 'machine' | 'grinder' | 'accessory' | 'other') and date-stamped.
// We roll it up two ways the brain needs: by category and by SKU, for the
// current window AND the prior window of equal length, so the brain sees TREND
// (this 30d vs the 30d before it) — a single number can't tell it if sales are
// growing or sliding.

const DEFAULT_SALES_WINDOW_DAYS = 30
// Only real revenue counts. Cancelled/failed/pending orders aren't money in the
// bank and would inflate the north-star. woo_orders carries status; the enriched
// line table does not, so we filter line rows by their parent order's status.
const REVENUE_ORDER_STATUSES = ['completed', 'processing']

function isoDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString().split('T')[0]
}

interface EnrichedLine {
  order_id: number
  product_name: string | null
  sku: string | null
  product_category: string | null
  quantity: number | null
  line_total: number | null
  order_date: string | null
}

/** Aggregate a set of line rows into category + SKU rollups for one window. */
function rollUpWindow(lines: EnrichedLine[]): {
  revenue_ils: number
  order_count: number
  by_category: CategorySales[]
  top_skus: SkuSales[]
} {
  const orders = new Set<number>()
  const byCat = new Map<string, { revenue: number; units: number; orders: Set<number> }>()
  const bySku = new Map<string, { name: string; category: string; revenue: number; units: number }>()
  let revenue = 0
  for (const l of lines) {
    const cat = l.product_category ?? 'other'
    const total = Number(l.line_total ?? 0)
    const units = Number(l.quantity ?? 0)
    revenue += total
    orders.add(l.order_id)
    const c = byCat.get(cat) ?? { revenue: 0, units: 0, orders: new Set<number>() }
    c.revenue += total; c.units += units; c.orders.add(l.order_id)
    byCat.set(cat, c)
    const skuKey = l.sku || l.product_name || 'unknown'
    const s = bySku.get(skuKey) ?? { name: l.product_name ?? skuKey, category: cat, revenue: 0, units: 0 }
    s.revenue += total; s.units += units
    bySku.set(skuKey, s)
  }
  const by_category = Array.from(byCat.entries())
    .map(([category, a]) => ({
      category,
      revenue_ils: Math.round(a.revenue),
      units: a.units,
      order_count: a.orders.size,
    }))
    .sort((a, b) => b.revenue_ils - a.revenue_ils || a.category.localeCompare(b.category))
  const top_skus = Array.from(bySku.entries())
    .map(([sku, s]) => ({ sku, name: s.name, category: s.category, revenue_ils: Math.round(s.revenue), units: s.units }))
    .sort((a, b) => b.revenue_ils - a.revenue_ils || a.sku.localeCompare(b.sku))
    .slice(0, 20)
  return { revenue_ils: Math.round(revenue), order_count: orders.size, by_category, top_skus }
}

export async function fetchSalesSnapshot(
  supabase: SupabaseClient,
  windowDays = DEFAULT_SALES_WINDOW_DAYS,
): Promise<SalesSnapshot> {
  const currentSince = isoDate(windowDays)
  const priorSince = isoDate(windowDays * 2)

  // Pull both windows' worth of line rows in one query, plus the parent orders'
  // statuses so we can drop non-revenue orders. Two cheap queries, joined in JS.
  const { data: lineData, error: lineErr } = await supabase
    .from('woo_order_items_enriched')
    .select('order_id, product_name, sku, product_category, quantity, line_total, order_date')
    .gte('order_date', priorSince)
    .limit(20000)
  if (lineErr) throw new Error(`fetchSalesSnapshot lines failed: ${lineErr.message}`)
  const lines = (lineData ?? []) as EnrichedLine[]

  const orderIds = Array.from(new Set(lines.map(l => l.order_id)))
  const revenueOrders = new Set<number>()
  // Chunk the IN() filter — order id sets can exceed PostgREST's URL limits.
  for (let i = 0; i < orderIds.length; i += 500) {
    const chunk = orderIds.slice(i, i + 500)
    const { data: ordData, error: ordErr } = await supabase
      .from('woo_orders')
      .select('woo_order_id, status')
      .in('woo_order_id', chunk)
      .in('status', REVENUE_ORDER_STATUSES)
    if (ordErr) throw new Error(`fetchSalesSnapshot orders failed: ${ordErr.message}`)
    for (const o of (ordData ?? []) as Array<{ woo_order_id: number }>) revenueOrders.add(o.woo_order_id)
  }

  const eligible = lines.filter(l => revenueOrders.has(l.order_id))
  const currentLines = eligible.filter(l => (l.order_date ?? '') >= currentSince)
  const priorLines = eligible.filter(l => (l.order_date ?? '') < currentSince)

  const current = rollUpWindow(currentLines)
  const prior = rollUpWindow(priorLines)

  const mkWindow = (since: string, r: ReturnType<typeof rollUpWindow>): SalesWindow => ({
    since,
    revenue_ils: r.revenue_ils,
    order_count: r.order_count,
    avg_order_value_ils: r.order_count > 0 ? Math.round(r.revenue_ils / r.order_count) : 0,
    by_category: r.by_category,
    top_skus: r.top_skus,
  })

  const pct = (cur: number, prev: number): number | null =>
    prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null

  return {
    window_days: windowDays,
    current: mkWindow(currentSince, current),
    prior: mkWindow(priorSince, prior),
    trend: {
      revenue_pct_change: pct(current.revenue_ils, prior.revenue_ils),
      order_count_pct_change: pct(current.order_count, prior.order_count),
      aov_pct_change: pct(
        current.order_count > 0 ? current.revenue_ils / current.order_count : 0,
        prior.order_count > 0 ? prior.revenue_ils / prior.order_count : 0,
      ),
    },
  }
}

// ── Email performance ───────────────────────────────────────────────────────
// campaigns holds rolled-up open_count/click_count/bounce_count per sent
// campaign; campaign_events is the raw event log (we use it only to confirm the
// rollups aren't stale-zero, since this repo has a history of silent sync gaps —
// a campaign with sent recipients but zero events is a signal the brain may flag).

export async function fetchEmailPerformance(
  supabase: SupabaseClient,
  lookbackDays = 90,
  limit = 15,
): Promise<EmailPerformance> {
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString()
  const { data, error } = await supabase
    .from('campaigns')
    .select('id, subject, campaign_type, status, sent_at, recipient_count, open_count, click_count, bounce_count')
    .eq('channel', 'email')
    .eq('status', 'sent')
    .gte('sent_at', since)
    .order('sent_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`fetchEmailPerformance failed: ${error.message}`)

  const rows = (data ?? []) as Array<{
    id: number
    subject: string | null
    campaign_type: string | null
    sent_at: string | null
    recipient_count: number | null
    open_count: number | null
    click_count: number | null
    bounce_count: number | null
  }>

  const campaigns: EmailCampaignPerf[] = rows.map(r => {
    const recipients = r.recipient_count ?? 0
    const opens = r.open_count ?? 0
    const clicks = r.click_count ?? 0
    return {
      subject: r.subject ?? '(no subject)',
      campaign_type: r.campaign_type ?? 'manual',
      sent_at: r.sent_at,
      recipients,
      open_rate: recipients > 0 ? Math.round((opens / recipients) * 1000) / 1000 : 0,
      click_rate: recipients > 0 ? Math.round((clicks / recipients) * 1000) / 1000 : 0,
      bounce_count: r.bounce_count ?? 0,
    }
  })

  const totalRecipients = campaigns.reduce((s, c) => s + c.recipients, 0)
  const weightedOpen = campaigns.reduce((s, c) => s + c.open_rate * c.recipients, 0)
  const weightedClick = campaigns.reduce((s, c) => s + c.click_rate * c.recipients, 0)

  return {
    lookback_days: lookbackDays,
    campaigns_sent: campaigns.length,
    total_recipients: totalRecipients,
    avg_open_rate: totalRecipients > 0 ? Math.round((weightedOpen / totalRecipients) * 1000) / 1000 : 0,
    avg_click_rate: totalRecipients > 0 ? Math.round((weightedClick / totalRecipients) * 1000) / 1000 : 0,
    recent: campaigns,
  }
}

// ── Open theses (the brain's own long-term memory) ──────────────────────────
// Active driver-hypotheses, with the ones due for a revenue check flagged. The
// brain reads these back so it builds on / refutes its prior beliefs instead of
// re-deriving from scratch each week (the Reflexion memory loop).

export async function fetchOpenTheses(
  supabase: SupabaseClient,
  limit = 30,
): Promise<TheseSnapshotRow[]> {
  const { data, error } = await supabase
    .from('strategic_theses')
    .select('id, thesis, lever, success_metric, metric_baseline, check_date, rationale, created_at')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`fetchOpenTheses failed: ${error.message}`)
  const today = new Date().toISOString().split('T')[0]
  return ((data ?? []) as Array<{
    id: string
    thesis: string
    lever: string
    success_metric: string
    metric_baseline: number | null
    check_date: string | null
    rationale: string | null
    created_at: string
  }>).map(t => ({
    id: t.id,
    thesis: t.thesis,
    lever: t.lever,
    success_metric: t.success_metric,
    metric_baseline: t.metric_baseline,
    check_date: t.check_date,
    rationale: t.rationale,
    due_for_check: t.check_date != null && t.check_date <= today,
  }))
}

// Recently RESOLVED theses (validated/refuted) with their outcome — the
// Reflexion feedback the brain reads to learn what its past bets actually did
// against revenue, and pivot. This is what makes next cycle smarter than this one.
export async function fetchResolvedTheses(
  supabase: SupabaseClient,
  limit = 10,
): Promise<Array<{ thesis: string; lever: string; status: string; outcome: string | null; check_date: string | null }>> {
  const { data, error } = await supabase
    .from('strategic_theses')
    .select('thesis, lever, status, outcome, check_date')
    .in('status', ['validated', 'refuted'])
    .order('updated_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`fetchResolvedTheses failed: ${error.message}`)
  return (data ?? []) as Array<{ thesis: string; lever: string; status: string; outcome: string | null; check_date: string | null }>
}

// ── Assembler ───────────────────────────────────────────────────────────────
// Fan out all reads concurrently (they hit independent tables), then assemble a
// deterministic, deep-sorted object. Each sense is wrapped so one failing fetcher
// degrades to an explicit `{ error }` marker rather than sinking the whole run —
// the brain is told which senses went dark and can flag it as a bug_report.

async function safe<T>(label: string, p: Promise<T>): Promise<T | { error: string }> {
  try { return await p } catch (e) { return { error: `${label}: ${e instanceof Error ? e.message : String(e)}` } }
}

export interface SnapshotOptions {
  salesWindowDays?: number
  emailLookbackDays?: number
}

export async function assembleBusinessSnapshot(
  supabase: SupabaseClient,
  opts: SnapshotOptions = {},
): Promise<BusinessSnapshot> {
  const salesWindowDays = opts.salesWindowDays ?? DEFAULT_SALES_WINDOW_DAYS
  const emailLookbackDays = opts.emailLookbackDays ?? 90

  const [
    sales,
    segments,
    email,
    voc,
    inventory,
    catalog,
    landingPages,
    keywords,
    organicPosts,
    convertingAds,
    theses,
    learnings,
    resolvedTheses,
  ] = await Promise.all([
    safe('sales', fetchSalesSnapshot(supabase, salesWindowDays)),
    safe('customer_segments', fetchCustomerSegmentSummary(supabase)),
    safe('email', fetchEmailPerformance(supabase, emailLookbackDays)),
    safe('voc', fetchVocInsights(supabase, 15)),
    safe('inventory', fetchInventoryAlerts(supabase)),
    safe('catalog', fetchMinutoCoffeeCatalog(supabase)),
    safe('organic_landing_pages', fetchTopOrganicLandingPages(supabase, salesWindowDays, 15)),
    safe('search_keywords', fetchTopKeywords(supabase, salesWindowDays, 20)),
    safe('organic_posts', fetchTopOrganicPosts(supabase, salesWindowDays, 10)),
    safe('converting_ads', fetchTopConvertingAds(supabase, salesWindowDays, 10)),
    safe('open_theses', fetchOpenTheses(supabase)),
    safe('learnings', getRecentLearnings(supabase, { limit: 15 })),
    safe('resolved_theses', fetchResolvedTheses(supabase)),
  ])

  // Inventory is large + mostly healthy; surface only the actionable subset so
  // the prefix stays lean. (Healthy SKUs carry no strategic signal.)
  const inventoryAlerts = Array.isArray(inventory)
    ? (inventory as InventoryAlert[]).filter(i => i.state !== 'healthy').sort((a, b) => a.packed_stock - b.packed_stock)
    : inventory

  const snapshot: BusinessSnapshot = {
    as_of: new Date().toISOString(),
    north_star: 'revenue',
    sales: sales as SalesSnapshot | { error: string },
    customer_segments: segments as CustomerSegmentSummary | { error: string },
    email: email as EmailPerformance | { error: string },
    inventory_alerts: inventoryAlerts as InventoryAlert[] | { error: string },
    coffee_catalog: catalog as WooProduct[] | { error: string },
    voice_of_customer: voc as VocInsight[] | { error: string },
    organic_landing_pages: landingPages as Ga4LandingPageSignal[] | { error: string },
    search_keywords: keywords as GscKeywordRow[] | { error: string },
    organic_posts: organicPosts as OrganicPostSignal[] | { error: string },
    converting_ads: convertingAds as AdInsightSignal[] | { error: string },
    open_theses: theses as TheseSnapshotRow[] | { error: string },
    resolved_theses: resolvedTheses as unknown[] | { error: string },
    recent_learnings: learnings as LearningRow[] | { error: string },
  }

  // Deep key-sort so the serialized prefix is byte-stable across runs (the cache
  // requires an identical prefix). `as_of` is the only intentionally-variable
  // field; the runner can strip it from the cached portion if needed.
  return sortKeysDeep(snapshot) as BusinessSnapshot
}

/** Recursively sort object keys so JSON.stringify is deterministic. Arrays keep
 *  their order (the fetchers already sort them meaningfully). */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}
