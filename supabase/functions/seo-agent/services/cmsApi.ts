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
