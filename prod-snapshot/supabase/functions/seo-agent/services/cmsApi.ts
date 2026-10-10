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
export async function fetchRecentBlogPosts(supabase, sinceIsoDate, limit = 100) {
  const { data, error } = await supabase.from('minuto_blog_posts').select('title, url, published_at').gte('published_at', sinceIsoDate).order('published_at', {
    ascending: false,
    nullsFirst: false
  }).limit(limit);
  if (error) throw new Error(`fetchRecentBlogPosts failed: ${error.message}`);
  return data ?? [];
}
export async function fetchActiveCatalog(supabase) {
  const { data, error } = await supabase.from('woo_products').select('name, price, permalink, image_url, stock_status, categories').not('image_url', 'is', null).order('name');
  if (error) throw new Error(`fetchActiveCatalog failed: ${error.message}`);
  return data ?? [];
}
// Minuto's OWN roasted coffee lineup — the only products valid as the "hero"
// of a piece of content. A blog/IG banner renders bag_hero = the byte-perfect
// Minuto bag, so green 1kg home-roasting SKUs (you can't brew green coffee) and
// resold third-party brands (Veneto / Toddy) are off-brand and must NEVER be
// featured (QA rejects them). The full woo_products catalog is mostly equipment
// + accessories + reseller coffee; this narrows to the two WooCommerce
// categories that hold Minuto's roasted line, with green/reseller stripped as
// defense-in-depth. Server-side category filter also dodges the 1000-row page
// cap (some coffee SKUs sit past row 1000).
const MINUTO_COFFEE_CATEGORIES = [
  'פולי קפה טרי - קפה ספשלטי specialty coffee',
  'תערובות קפה מינוטו'
];
export async function fetchMinutoCoffeeCatalog(supabase) {
  const orFilter = MINUTO_COFFEE_CATEGORIES.map((c)=>`categories.cs.{"${c}"}`).join(',');
  const { data, error } = await supabase.from('woo_products').select('name, price, permalink, image_url, stock_status, categories').or(orFilter).order('name');
  if (error) throw new Error(`fetchMinutoCoffeeCatalog failed: ${error.message}`);
  const isOffBrand = (n)=>/ירוק|green coffee|unroasted|raw coffee|veneto|ונטו|toddy|טודי/i.test(n);
  return (data ?? []).filter((p)=>!isOffBrand(p.name));
}
export async function fetchInventoryAlerts(supabase) {
  const { data, error } = await supabase.from('products').select('name, packed_stock, min_packed_stock');
  if (error) throw new Error(`fetchInventoryAlerts failed: ${error.message}`);
  return (data ?? []).map((p)=>{
    const min = p.min_packed_stock ?? 0;
    const state = p.packed_stock <= 0 ? 'critical' : p.packed_stock <= min ? 'low' : 'healthy';
    return {
      ...p,
      state
    };
  });
}
export async function fetchVocInsights(supabase, limit = 20) {
  const { data, error } = await supabase.from('voc_insights').select('pattern, real_meaning, suggested_response, customer_stage, product_context, frequency, confidence, example_phrases').order('frequency', {
    ascending: false
  }).order('last_mined_at', {
    ascending: false
  }).limit(limit);
  if (error) throw new Error(`fetchVocInsights failed: ${error.message}`);
  return data ?? [];
}
// Untapped: low competition + decent search volume. Sort by a leverage
// score = searches / max(competition_index, 0.1) — favors high-volume +
// low-competition keywords. Caps at `limit` of the best opportunities.
export async function fetchKeywordOpportunities(supabase, limit = 20) {
  const { data, error } = await supabase.from('keyword_ideas').select('keyword, avg_monthly_searches, competition, competition_index').not('avg_monthly_searches', 'is', null).limit(500);
  if (error) throw new Error(`fetchKeywordOpportunities failed: ${error.message}`);
  return (data ?? []).filter((r)=>(r.avg_monthly_searches ?? 0) >= 50) // floor for noise
  .sort((a, b)=>{
    const scoreA = (a.avg_monthly_searches ?? 0) / Math.max(a.competition_index ?? 1, 0.1);
    const scoreB = (b.avg_monthly_searches ?? 0) / Math.max(b.competition_index ?? 1, 0.1);
    return scoreB - scoreA;
  }).slice(0, limit);
}
export async function fetchCustomerSegmentSummary(supabase) {
  const { data, error } = await supabase.from('customer_rfm').select('segment, total_spent_ils, order_count, days_since_last, first_order_date').limit(5000);
  if (error) throw new Error(`fetchCustomerSegmentSummary failed: ${error.message}`);
  const rows = data ?? [];
  if (rows.length === 0) {
    return {
      total_customers: 0,
      by_segment: [],
      new_in_last_30d: 0,
      at_risk_count: 0
    };
  }
  const thirtyDaysAgoMs = Date.now() - 30 * 24 * 3600 * 1000;
  let newCount = 0;
  let atRiskCount = 0;
  const bySeg = new Map();
  for (const r of rows){
    const seg = r.segment ?? 'unknown';
    const agg = bySeg.get(seg) ?? {
      count: 0,
      totSpent: 0,
      totOrders: 0,
      totDaysSince: 0
    };
    agg.count++;
    agg.totSpent += Number(r.total_spent_ils ?? 0);
    agg.totOrders += Number(r.order_count ?? 0);
    agg.totDaysSince += Number(r.days_since_last ?? 0);
    bySeg.set(seg, agg);
    if (r.first_order_date && new Date(r.first_order_date).getTime() > thirtyDaysAgoMs) newCount++;
    if ((r.days_since_last ?? 0) > 90 && (r.order_count ?? 0) > 1) atRiskCount++;
  }
  const by_segment = Array.from(bySeg.entries()).map(([segment, a])=>({
      segment,
      count: a.count,
      avg_total_spent_ils: a.count > 0 ? Math.round(a.totSpent / a.count) : 0,
      avg_order_count: a.count > 0 ? Math.round(a.totOrders / a.count * 10) / 10 : 0,
      avg_days_since_last: a.count > 0 ? Math.round(a.totDaysSince / a.count) : 0
    })).sort((a, b)=>b.count - a.count);
  return {
    total_customers: rows.length,
    by_segment,
    new_in_last_30d: newCount,
    at_risk_count: atRiskCount
  };
}
export async function fetchCompetitorIntelligence(supabase, lookbackDays = 30) {
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString();
  // 1. LLM co-mention frequency (from ai_visibility_probes).
  const { data: probes } = await supabase.from('ai_visibility_probes').select('query_text, competitors_mentioned').gte('ran_at', since).is('error', null).limit(500);
  const byCompetitor = new Map();
  for (const p of probes ?? []){
    for (const c of p.competitors_mentioned ?? []){
      const agg = byCompetitor.get(c) ?? {
        totalMentions: 0,
        queries: new Set()
      };
      agg.totalMentions++;
      agg.queries.add(p.query_text);
      byCompetitor.set(c, agg);
    }
  }
  const llm_co_mentions = Array.from(byCompetitor.entries()).map(([name, agg])=>({
      name,
      mention_count_30d: agg.totalMentions,
      queries_appearing_in: agg.queries.size
    })).sort((a, b)=>b.mention_count_30d - a.mention_count_30d).slice(0, 10);
  // 2. Recent market research summaries (already-available competitor scans).
  const { data: research } = await supabase.from('market_research').select('source, research_date, summary').gte('research_date', since.split('T')[0]).not('summary', 'is', null).order('research_date', {
    ascending: false
  }).limit(5);
  const recent_research = (research ?? []).map((r)=>({
      source: r.source,
      research_date: r.research_date,
      summary_excerpt: (r.summary ?? '').slice(0, 200)
    }));
  return {
    llm_co_mentions,
    recent_research
  };
}
export async function fetchRecentMarketResearch(supabase, lookbackDays = 30, limit = 5) {
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString().split('T')[0];
  const { data, error } = await supabase.from('market_research').select('research_date, source, summary').gte('research_date', since).not('summary', 'is', null).order('research_date', {
    ascending: false
  }).limit(limit);
  if (error) throw new Error(`fetchRecentMarketResearch failed: ${error.message}`);
  return data ?? [];
}
export async function fetchAiVisibilitySummary(supabase, lookbackDays = 30) {
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString();
  // Cheap to do client-side aggregation since each probe row is tiny + the
  // total volume is bounded (~13 queries × 1-3 providers × weekly = small).
  const { data, error } = await supabase.from('ai_visibility_probes').select('query_text, minuto_mentioned, minuto_position_chars, competitors_mentioned, ran_at').gte('ran_at', since).is('error', null).limit(2000);
  if (error) throw new Error(`fetchAiVisibilitySummary failed: ${error.message}`);
  // Also pull query metadata for category/language.
  const { data: queries, error: qErr } = await supabase.from('ai_visibility_queries').select('query, category, language');
  if (qErr) throw new Error(`fetchAiVisibilitySummary queries failed: ${qErr.message}`);
  const meta = new Map((queries ?? []).map((q)=>[
      q.query,
      {
        category: q.category,
        language: q.language
      }
    ]));
  // Aggregate per query_text.
  const byQuery = new Map();
  for (const r of data ?? []){
    const k = r.query_text;
    const agg = byQuery.get(k) ?? {
      total: 0,
      mentions: 0,
      posSum: 0,
      posCnt: 0,
      competitors: new Map(),
      lastRun: r.ran_at
    };
    agg.total++;
    if (r.minuto_mentioned) {
      agg.mentions++;
      if (r.minuto_position_chars != null) {
        agg.posSum += r.minuto_position_chars;
        agg.posCnt++;
      }
    }
    for (const c of r.competitors_mentioned ?? []){
      agg.competitors.set(c, (agg.competitors.get(c) ?? 0) + 1);
    }
    if (r.ran_at > agg.lastRun) agg.lastRun = r.ran_at;
    byQuery.set(k, agg);
  }
  return Array.from(byQuery.entries()).map(([query, agg])=>({
      query,
      category: meta.get(query)?.category ?? '?',
      language: meta.get(query)?.language ?? '?',
      probes_total: agg.total,
      mentions_total: agg.mentions,
      mention_rate: agg.total > 0 ? agg.mentions / agg.total : 0,
      avg_mention_position: agg.posCnt > 0 ? agg.posSum / agg.posCnt : null,
      top_competitors: Array.from(agg.competitors.entries()).sort((a, b)=>b[1] - a[1]).slice(0, 5).map(([name, count])=>({
          name,
          count
        })),
      last_run: agg.lastRun
    })).sort((a, b)=>b.mention_rate - a.mention_rate);
}
export async function fetchIndustryInsights(supabase, opts = {}) {
  const minRel = opts.minRelevance ?? 0.5;
  const lookbackDays = opts.lookbackDays ?? 14;
  const limit = opts.limit ?? 12;
  const since = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase.from('industry_articles').select('source_name, source_category, title, url, insight, relevance, tags, published_at, summarized_at').not('summarized_at', 'is', null).gte('summarized_at', since).gte('relevance', minRel).order('relevance', {
    ascending: false
  }).order('summarized_at', {
    ascending: false
  }).limit(limit);
  if (error) throw new Error(`fetchIndustryInsights failed: ${error.message}`);
  return data ?? [];
}
