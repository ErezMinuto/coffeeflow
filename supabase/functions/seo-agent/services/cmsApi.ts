// Minuto SEO Agent — CMS / catalog reader.
//
// Reads from the existing tables maintained by other sync jobs:
//   minuto_blog_posts — populated by an RSS sync of minuto.co.il/blog
//   woo_products      — populated by the WooCommerce sync job
//   origins / products — internal coffee inventory tables
//
// We never write to these tables from the SEO Agent. The Writer Worker
// will push new drafts to WordPress via the existing blog-publish edge
// function — that's a separate concern handled there, not here.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Published blog posts (avoid duplicate recommendations) ───────────────

export interface PublishedBlogPost {
  title: string
  url: string
  published_at: string | null
}

export async function fetchRecentBlogPosts(
  supabase: SupabaseClient,
  sinceIsoDate: string,
  limit = 100,
): Promise<PublishedBlogPost[]> {
  const { data, error } = await supabase
    .from('minuto_blog_posts')
    .select('title, url, published_at')
    .gte('published_at', sinceIsoDate)
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(limit)
  if (error) throw new Error(`fetchRecentBlogPosts failed: ${error.message}`)
  return (data ?? []) as PublishedBlogPost[]
}

// ── Product catalog (so the orchestrator can pick relevant SKUs) ─────────

export interface WooProduct {
  name: string
  price: number | null
  permalink: string | null
  image_url: string | null
  // woo_products tracks WooCommerce status as text ('instock' | 'outofstock' |
  // 'onbackorder'), NOT a numeric count. For numeric stock levels, see
  // fetchInventoryAlerts which reads the internal `products` table.
  stock_status: string | null
}

export async function fetchActiveCatalog(supabase: SupabaseClient): Promise<WooProduct[]> {
  const { data, error } = await supabase
    .from('woo_products')
    .select('name, price, permalink, image_url, stock_status')
    .not('image_url', 'is', null)
    .order('name')
  if (error) throw new Error(`fetchActiveCatalog failed: ${error.message}`)
  return (data ?? []) as WooProduct[]
}

// ── Inventory health (low-stock signals into orchestrator's planning) ────

export interface InventoryAlert {
  name: string
  packed_stock: number
  min_packed_stock: number | null
  state: 'low' | 'critical' | 'healthy'
}

export async function fetchInventoryAlerts(
  supabase: SupabaseClient,
): Promise<InventoryAlert[]> {
  const { data, error } = await supabase
    .from('products')
    .select('name, packed_stock, min_packed_stock')
  if (error) throw new Error(`fetchInventoryAlerts failed: ${error.message}`)

  return (data ?? []).map((p: { name: string; packed_stock: number; min_packed_stock: number | null }) => {
    const min = p.min_packed_stock ?? 0
    const state =
      p.packed_stock <= 0       ? 'critical'
      : p.packed_stock <= min   ? 'low'
      :                            'healthy'
    return { ...p, state }
  })
}

// ── Customer-research signals ─────────────────────────────────────────────
// voc_insights = patterns mined from IG DMs / support / customer interactions
// by the marketing-advisor's VoC miner. real_meaning + example_phrases capture
// what customers actually say in their own words → high-quality SEO topic seeds.
//
// keyword_ideas = Google Keyword Planner output (synced periodically). Lower
// avg_monthly_searches with low competition_index = "untapped" SEO opportunities.
//
// market_research = Meta Ad Library competitor scans (per memory note
// meta_ad_library_research.md), summarized weekly by marketing-advisor. The
// `summary` field is the strategist-ready compressed version.

export interface VocInsight {
  pattern:           string
  real_meaning:      string | null
  suggested_response: string | null
  customer_stage:    string | null
  product_context:   string | null
  frequency:         number
  confidence:        string | null
  example_phrases:   unknown    // jsonb — usually a string[] of customer quotes
}

export async function fetchVocInsights(
  supabase: SupabaseClient,
  limit = 20,
): Promise<VocInsight[]> {
  const { data, error } = await supabase
    .from('voc_insights')
    .select('pattern, real_meaning, suggested_response, customer_stage, product_context, frequency, confidence, example_phrases')
    .order('frequency', { ascending: false })
    .order('last_mined_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`fetchVocInsights failed: ${error.message}`)
  return (data ?? []) as VocInsight[]
}

export interface KeywordOpportunity {
  keyword:               string
  avg_monthly_searches:  number | null
  competition:           string | null
  competition_index:     number | null
}

// Untapped: low competition + decent search volume. Sort by a leverage
// score = searches / max(competition_index, 0.1) — favors high-volume +
// low-competition keywords. Caps at `limit` of the best opportunities.
export async function fetchKeywordOpportunities(
  supabase: SupabaseClient,
  limit = 20,
): Promise<KeywordOpportunity[]> {
  const { data, error } = await supabase
    .from('keyword_ideas')
    .select('keyword, avg_monthly_searches, competition, competition_index')
    .not('avg_monthly_searches', 'is', null)
    .limit(500)
  if (error) throw new Error(`fetchKeywordOpportunities failed: ${error.message}`)

  return (data ?? [] as Array<KeywordOpportunity>)
    .filter(r => (r.avg_monthly_searches ?? 0) >= 50)  // floor for noise
    .sort((a, b) => {
      const scoreA = (a.avg_monthly_searches ?? 0) / Math.max(a.competition_index ?? 1, 0.1)
      const scoreB = (b.avg_monthly_searches ?? 0) / Math.max(b.competition_index ?? 1, 0.1)
      return scoreB - scoreA
    })
    .slice(0, limit)
}

export interface MarketResearchSummary {
  research_date: string
  source:        string
  summary:       string | null
}

export async function fetchRecentMarketResearch(
  supabase: SupabaseClient,
  lookbackDays = 30,
  limit = 5,
): Promise<MarketResearchSummary[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000)
    .toISOString().split('T')[0]
  const { data, error } = await supabase
    .from('market_research')
    .select('research_date, source, summary')
    .gte('research_date', since)
    .not('summary', 'is', null)
    .order('research_date', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`fetchRecentMarketResearch failed: ${error.message}`)
  return (data ?? []) as MarketResearchSummary[]
}

// ── Industry intelligence — daily-ingested marketing + coffee articles ──
// Populated by industry-intelligence-sync. Filtered to articles with a
// useful Haiku-synthesized insight + a min relevance bar so the
// strategist's context block doesn't get noisy.

export interface IndustryArticleInsight {
  source_name:     string
  source_category: string  // 'seo' | 'marketing' | 'social' | 'coffee'
  title:           string
  url:             string
  insight:         string
  relevance:       number
  tags:            string[]
  published_at:    string | null
  summarized_at:   string
}

// ── AI-agent visibility ─────────────────────────────────────────────────
// Per-query aggregated mention rate across recent probes. The orchestrator
// uses this to know whether Minuto is showing up in shopping-LLM
// responses, and which competitors are routinely co-mentioned.

export interface AiVisibilityRow {
  query:                 string
  category:              string
  language:              string
  probes_total:          number
  mentions_total:        number
  mention_rate:          number          // 0..1
  avg_mention_position:  number | null   // chars from start; lower = mentioned earlier
  top_competitors:       Array<{ name: string; count: number }>
  last_run:              string
}

export async function fetchAiVisibilitySummary(
  supabase: SupabaseClient,
  lookbackDays = 30,
): Promise<AiVisibilityRow[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString()
  // Cheap to do client-side aggregation since each probe row is tiny + the
  // total volume is bounded (~13 queries × 1-3 providers × weekly = small).
  const { data, error } = await supabase
    .from('ai_visibility_probes')
    .select('query_text, minuto_mentioned, minuto_position_chars, competitors_mentioned, ran_at')
    .gte('ran_at', since)
    .is('error', null)
    .limit(2000)
  if (error) throw new Error(`fetchAiVisibilitySummary failed: ${error.message}`)

  // Also pull query metadata for category/language.
  const { data: queries, error: qErr } = await supabase
    .from('ai_visibility_queries')
    .select('query, category, language')
  if (qErr) throw new Error(`fetchAiVisibilitySummary queries failed: ${qErr.message}`)
  const meta = new Map((queries ?? []).map((q: any) => [q.query as string, { category: q.category as string, language: q.language as string }]))

  // Aggregate per query_text.
  const byQuery = new Map<string, {
    total: number
    mentions: number
    posSum: number
    posCnt: number
    competitors: Map<string, number>
    lastRun: string
  }>()
  for (const r of (data ?? []) as Array<any>) {
    const k = r.query_text as string
    const agg = byQuery.get(k) ?? { total: 0, mentions: 0, posSum: 0, posCnt: 0, competitors: new Map<string, number>(), lastRun: r.ran_at }
    agg.total++
    if (r.minuto_mentioned) {
      agg.mentions++
      if (r.minuto_position_chars != null) { agg.posSum += r.minuto_position_chars; agg.posCnt++ }
    }
    for (const c of (r.competitors_mentioned ?? []) as string[]) {
      agg.competitors.set(c, (agg.competitors.get(c) ?? 0) + 1)
    }
    if (r.ran_at > agg.lastRun) agg.lastRun = r.ran_at
    byQuery.set(k, agg)
  }

  return Array.from(byQuery.entries()).map(([query, agg]) => ({
    query,
    category:             meta.get(query)?.category ?? '?',
    language:             meta.get(query)?.language ?? '?',
    probes_total:         agg.total,
    mentions_total:       agg.mentions,
    mention_rate:         agg.total > 0 ? agg.mentions / agg.total : 0,
    avg_mention_position: agg.posCnt > 0 ? agg.posSum / agg.posCnt : null,
    top_competitors:      Array.from(agg.competitors.entries())
                                .sort((a, b) => b[1] - a[1])
                                .slice(0, 5)
                                .map(([name, count]) => ({ name, count })),
    last_run:             agg.lastRun,
  })).sort((a, b) => b.mention_rate - a.mention_rate)
}

export async function fetchIndustryInsights(
  supabase: SupabaseClient,
  opts: { minRelevance?: number; lookbackDays?: number; limit?: number } = {},
): Promise<IndustryArticleInsight[]> {
  const minRel        = opts.minRelevance ?? 0.5
  const lookbackDays  = opts.lookbackDays ?? 14
  const limit         = opts.limit ?? 12
  const since         = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString()
  const { data, error } = await supabase
    .from('industry_articles')
    .select('source_name, source_category, title, url, insight, relevance, tags, published_at, summarized_at')
    .not('summarized_at', 'is', null)
    .gte('summarized_at', since)
    .gte('relevance', minRel)
    .order('relevance', { ascending: false })
    .order('summarized_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`fetchIndustryInsights failed: ${error.message}`)
  return (data ?? []) as IndustryArticleInsight[]
}
