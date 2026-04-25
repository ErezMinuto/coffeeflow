/**
 * CoffeeFlow — Google Ads Sync
 *
 * Modes (controlled by ?mode=... query param):
 *
 *   performance  — daily insights, creatives, keywords, search terms,
 *                  ad-group daily, gclid→campaign click mapping. Run
 *                  before every doctor check.
 *
 *   settings     — account-level settings, campaign settings, ad group
 *                  settings, audiences, conversion actions. Run rarely:
 *                  on-demand when user makes changes in Google Ads, or
 *                  on a daily cron.
 *
 *   all (default) — both. Preserves the backwards-compatible cron behavior.
 *
 * The split exists so the doctor's pre-run performance sync is fast (doesn't
 * re-fetch config that rarely changes) and the settings tables stay a stable
 * source of truth for all campaign/ad-group/audience configuration.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Helpers ──────────────────────────────────────────────────────────────────

async function refreshGoogleToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: Deno.env.get('GOOGLE_CLIENT_ID')!,
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET')!,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json()
  if (data.error) throw new Error(`Token refresh failed: ${data.error_description || data.error}`)
  return data.access_token
}

/**
 * Generic GAQL caller with built-in pagination. Google Ads API returns
 * results page-by-page; nextPageToken is appended to the body. Caller gets
 * all results merged. Errors are thrown so call sites can try/catch per-block.
 */
async function gaqlSearch(
  url: string, headers: Record<string, string>, query: string, label: string
): Promise<any[]> {
  const all: any[] = []
  let pageToken: string | undefined = undefined
  let pageCount = 0
  while (true) {
    const body: any = { query }
    if (pageToken) body.pageToken = pageToken
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    const raw = await res.text()
    let data: any
    try { data = JSON.parse(raw) }
    catch { throw new Error(`[${label}] non-JSON response (${res.status}): ${raw.slice(0, 200)}`) }
    if (data.error) throw new Error(`[${label}] ${JSON.stringify(data.error).slice(0, 500)}`)
    if (Array.isArray(data.results)) all.push(...data.results)
    pageToken = data.nextPageToken
    pageCount++
    if (!pageToken || pageCount > 50) break // safety cap
  }
  return all
}

const toIsoDate = (d: Date) => d.toISOString().split('T')[0]
const daysAgo = (n: number) => toIsoDate(new Date(Date.now() - n * 86400_000))

// ── Handler ──────────────────────────────────────────────────────────────────

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const urlObj = new URL(req.url)
  // Default to 'all' for back-compat with the existing cron that calls this
  // function with no params. Doctor will call ?mode=performance explicitly.
  const mode = (urlObj.searchParams.get('mode') ?? 'all').toLowerCase()
  const runSettings    = mode === 'settings'    || mode === 'all'
  const runPerformance = mode === 'performance' || mode === 'all'

  const startedAt = new Date().toISOString()
  const stats: Record<string, any> = {
    mode,
    campaign_rows: 0, ad_rows: 0, keyword_rows: 0, search_term_rows: 0,
    ad_group_daily_rows: 0, click_mapping_rows: 0,
    account_settings_rows: 0, campaign_settings_rows: 0, ad_group_settings_rows: 0,
    audience_rows: 0, conversion_action_rows: 0,
    errors: [] as string[],
  }

  // ── Async pattern: insert a "running" sync_log row up front, return 202 to
  // the client immediately, and continue the work in the background via
  // EdgeRuntime.waitUntil. Without this, every full sync hit the Supabase
  // wall-clock limit (~75s observed) and returned HTTP 546 to the client
  // with no error in logs (the timeout kills the worker before any catch
  // block can run). Frontend now polls sync_log by id to know when done.
  const { data: syncLogRow, error: syncInsertErr } = await supabase
    .from('sync_log')
    .insert({
      platform: 'google',
      status: 'running',
      started_at: startedAt,
      stats: { mode, phase: 'starting' },
    })
    .select('id')
    .single()

  if (syncInsertErr || !syncLogRow) {
    return new Response(
      JSON.stringify({ error: `Failed to start sync log: ${syncInsertErr?.message}` }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const syncId = (syncLogRow as any).id as string

  // Background work — wrapped in a try/catch so we ALWAYS update the row
  // (otherwise the frontend would poll forever on a crashed sync).
  // @ts-ignore — EdgeRuntime is provided by Supabase Deno runtime
  EdgeRuntime.waitUntil((async () => {
    try {
    const devToken = Deno.env.get('GOOGLE_DEVELOPER_TOKEN')
    if (!devToken) throw new Error('GOOGLE_DEVELOPER_TOKEN not set')

    const { data: tokenRow } = await supabase
      .from('oauth_tokens').select('*').eq('platform', 'google').single()
    if (!tokenRow) throw new Error('Google not connected')

    const accessToken = await refreshGoogleToken(tokenRow.refresh_token)
    await supabase.from('oauth_tokens').update({
      access_token: accessToken,
      expires_at:   new Date(Date.now() + 3600 * 1000).toISOString(),
    }).eq('platform', 'google')

    const customerId = Deno.env.get('GOOGLE_CUSTOMER_ID')!.replace(/-/g, '')
    const apiUrl = `https://googleads.googleapis.com/v20/customers/${customerId}/googleAds:search`
    const apiHeaders = {
      'Authorization':    `Bearer ${accessToken}`,
      'developer-token':  devToken,
      'Content-Type':     'application/json',
    }

    const today    = toIsoDate(new Date())
    const since14  = daysAgo(14)
    const since90  = daysAgo(90)

    // ════════════════════════════════════════════════════════════════════════
    // SETTINGS BLOCKS — rare updates
    // ════════════════════════════════════════════════════════════════════════

    // Account-level settings. customer resource — one row.
    if (runSettings) {
      try {
        const q = `
          SELECT
            customer.id,
            customer.descriptive_name,
            customer.currency_code,
            customer.time_zone,
            customer.auto_tagging_enabled,
            customer.conversion_tracking_setting.conversion_tracking_status,
            customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled,
            customer.test_account,
            customer.manager
          FROM customer
        `
        const rows = await gaqlSearch(apiUrl, apiHeaders, q, 'customer')
        for (const r of rows) {
          const c = r.customer ?? {}
          const ct = c.conversionTrackingSetting ?? {}
          await supabase.from('google_account_settings').upsert({
            customer_id:                String(c.id ?? customerId),
            descriptive_name:           c.descriptiveName ?? null,
            currency_code:              c.currencyCode ?? null,
            time_zone:                  c.timeZone ?? null,
            auto_tagging_enabled:       c.autoTaggingEnabled ?? null,
            conversion_tracking_status: ct.conversionTrackingStatus ?? null,
            has_enhanced_conversions:   ct.enhancedConversionsForLeadsEnabled ?? null,
            test_account:               c.testAccount ?? null,
            manager:                    c.manager ?? null,
            synced_at:                  new Date().toISOString(),
          }, { onConflict: 'customer_id' })
          stats.account_settings_rows++
        }
      } catch (e: any) {
        console.error('[google-sync] account_settings:', e.message)
        stats.errors.push(`account_settings: ${e.message}`)
      }

      // Campaign settings (expanded from what we used to store)
      try {
        const q = `
          SELECT
            campaign.id,
            campaign.name,
            campaign.status,
            campaign.advertising_channel_type,
            campaign.bidding_strategy_type,
            campaign.target_cpa.target_cpa_micros,
            campaign.maximize_conversion_value.target_roas,
            campaign.network_settings.target_google_search,
            campaign.network_settings.target_search_network,
            campaign.network_settings.target_content_network,
            campaign.network_settings.target_partner_search_network,
            campaign.final_url_suffix,
            campaign.tracking_url_template,
            campaign.start_date,
            campaign.end_date,
            campaign_budget.amount_micros,
            campaign_budget.delivery_method
          FROM campaign
          WHERE campaign.status != 'REMOVED'
        `
        const rows = await gaqlSearch(apiUrl, apiHeaders, q, 'campaign_settings')
        for (const r of rows) {
          const c = r.campaign ?? {}
          const ns = c.networkSettings ?? {}
          const b = r.campaignBudget ?? {}
          await supabase.from('google_campaign_settings').upsert({
            campaign_id:              String(c.id ?? ''),
            name:                     c.name ?? null,
            status:                   c.status ?? null,
            advertising_channel_type: c.advertisingChannelType ?? null,
            bidding_strategy_type:    c.biddingStrategyType ?? null,
            target_cpa_micros:        c.targetCpa?.targetCpaMicros ? String(c.targetCpa.targetCpaMicros) : null,
            target_roas:              c.maximizeConversionValue?.targetRoas ?? null,
            target_search_network:    ns.targetSearchNetwork ?? null,
            target_content_network:   ns.targetContentNetwork ?? null,
            target_partner_search:    ns.targetPartnerSearchNetwork ?? null,
            daily_budget_micros:      b.amountMicros ? String(b.amountMicros) : null,
            budget_delivery_method:   b.deliveryMethod ?? null,
            final_url_suffix:         c.finalUrlSuffix ?? null,
            tracking_template:        c.trackingUrlTemplate ?? null,
            start_date:               c.startDate ?? null,
            end_date:                 c.endDate && c.endDate !== '2037-12-30' ? c.endDate : null,
            synced_at:                new Date().toISOString(),
          }, { onConflict: 'campaign_id' })
          stats.campaign_settings_rows++
        }
      } catch (e: any) {
        console.error('[google-sync] campaign_settings:', e.message)
        stats.errors.push(`campaign_settings: ${e.message}`)
      }

      // Ad group settings
      try {
        const q = `
          SELECT
            ad_group.id,
            ad_group.name,
            ad_group.status,
            ad_group.type,
            ad_group.cpc_bid_micros,
            ad_group.target_cpa_micros,
            ad_group.target_roas,
            campaign.id
          FROM ad_group
          WHERE ad_group.status != 'REMOVED'
            AND campaign.status != 'REMOVED'
        `
        const rows = await gaqlSearch(apiUrl, apiHeaders, q, 'ad_group_settings')
        for (const r of rows) {
          const ag = r.adGroup ?? {}
          await supabase.from('google_ad_group_settings').upsert({
            ad_group_id:        String(ag.id ?? ''),
            campaign_id:        String(r.campaign?.id ?? ''),
            name:               ag.name ?? null,
            status:             ag.status ?? null,
            type:               ag.type ?? null,
            cpc_bid_micros:     ag.cpcBidMicros ? String(ag.cpcBidMicros) : null,
            target_cpa_micros:  ag.targetCpaMicros ? String(ag.targetCpaMicros) : null,
            target_roas:        ag.targetRoas ?? null,
            synced_at:          new Date().toISOString(),
          }, { onConflict: 'ad_group_id' })
          stats.ad_group_settings_rows++
        }
      } catch (e: any) {
        console.error('[google-sync] ad_group_settings:', e.message)
        stats.errors.push(`ad_group_settings: ${e.message}`)
      }

      // Audiences / user lists. Only customer-match (CRM) and remarketing
      // lists usable on Search network. Filter closed/stale lists.
      try {
        const q = `
          SELECT
            user_list.id,
            user_list.name,
            user_list.description,
            user_list.type,
            user_list.size_for_search,
            user_list.size_for_display,
            user_list.membership_status,
            user_list.membership_life_span
          FROM user_list
          WHERE user_list.membership_status = 'OPEN'
        `
        const rows = await gaqlSearch(apiUrl, apiHeaders, q, 'user_list')
        for (const r of rows) {
          const u = r.userList ?? {}
          await supabase.from('google_audiences').upsert({
            audience_id:               String(u.id ?? ''),
            name:                      u.name ?? null,
            type:                      u.type ?? null,
            description:               u.description ?? null,
            size_for_search:           u.sizeForSearch ?? null,
            size_for_display:          u.sizeForDisplay ?? null,
            membership_status:         u.membershipStatus ?? null,
            membership_life_span_days: u.membershipLifeSpan ?? null,
            synced_at:                 new Date().toISOString(),
          }, { onConflict: 'audience_id' })
          stats.audience_rows++
        }
      } catch (e: any) {
        console.error('[google-sync] user_list:', e.message)
        stats.errors.push(`user_list: ${e.message}`)
      }

      // Conversion actions — which are Primary vs Secondary. Doctor needs
      // this to make authoritative statements (no more heuristic guessing).
      try {
        const q = `
          SELECT
            conversion_action.id,
            conversion_action.name,
            conversion_action.category,
            conversion_action.type,
            conversion_action.status,
            conversion_action.primary_for_goal,
            conversion_action.include_in_conversions_metric,
            conversion_action.counting_type,
            conversion_action.attribution_model_settings.attribution_model,
            conversion_action.value_settings.default_value,
            conversion_action.value_settings.always_use_default_value
          FROM conversion_action
          WHERE conversion_action.status = 'ENABLED'
        `
        const rows = await gaqlSearch(apiUrl, apiHeaders, q, 'conversion_action')
        for (const r of rows) {
          const ca = r.conversionAction ?? {}
          const vs = ca.valueSettings ?? {}
          const ams = ca.attributionModelSettings ?? {}
          const valueType = vs.defaultValue != null && vs.alwaysUseDefaultValue
            ? 'DEFAULT'
            : (vs.defaultValue != null ? 'DIFFERENT_VALUES' : 'NO_VALUE')
          await supabase.from('google_conversion_actions').upsert({
            action_id:              String(ca.id ?? ''),
            name:                   ca.name ?? null,
            category:               ca.category ?? null,
            type:                   ca.type ?? null,
            status:                 ca.status ?? null,
            primary_for_goal:       ca.primaryForGoal ?? null,
            include_in_conversions: ca.includeInConversionsMetric ?? null,
            counting_type:          ca.countingType ?? null,
            attribution_model:      ams.attributionModel ?? null,
            value_type:             valueType,
            synced_at:              new Date().toISOString(),
          }, { onConflict: 'action_id' })
          stats.conversion_action_rows++
        }
      } catch (e: any) {
        console.error('[google-sync] conversion_action:', e.message)
        stats.errors.push(`conversion_action: ${e.message}`)
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // PERFORMANCE BLOCKS — fresh every doctor run
    // ════════════════════════════════════════════════════════════════════════

    // Campaign daily insights WITH impression-share metrics. The IS fields
    // are the budget-cap signal — same single API call, just more columns.
    if (runPerformance) {
      try {
        const q = `
          SELECT
            campaign.id, campaign.name, campaign.status,
            metrics.impressions, metrics.clicks, metrics.cost_micros,
            metrics.ctr, metrics.average_cpc,
            metrics.conversions, metrics.conversions_value,
            metrics.all_conversions, metrics.all_conversions_value,
            metrics.search_impression_share,
            metrics.search_budget_lost_impression_share,
            metrics.search_rank_lost_impression_share,
            metrics.search_top_impression_share,
            segments.date
          FROM campaign
          WHERE segments.date BETWEEN '${since90}' AND '${today}'
            AND campaign.status != 'REMOVED'
          ORDER BY metrics.cost_micros DESC
          LIMIT 500
        `
        const rows = await gaqlSearch(apiUrl, apiHeaders, q, 'campaign_daily')
        for (const r of rows) {
          const cost = (r.metrics.costMicros || 0) / 1_000_000
          const allConv = Number(r.metrics.allConversions ?? 0)
          const primaryConv = Number(r.metrics.conversions ?? 0)
          const allVal = Number(r.metrics.allConversionsValue ?? 0)
          const primaryVal = Number(r.metrics.conversionsValue ?? 0)
          const conversions = allConv > 0 ? allConv : primaryConv
          const convValue = allVal > 0 ? allVal : primaryVal
          const roas = cost > 0 ? convValue / cost : 0
          const { error } = await supabase.from('google_campaigns').upsert({
            campaign_id: String(r.campaign.id),
            date: r.segments.date,
            name: r.campaign.name,
            status: r.campaign.status,
            impressions: r.metrics.impressions || 0,
            clicks: r.metrics.clicks || 0,
            cost,
            ctr: r.metrics.ctr || 0,
            cpc: (r.metrics.averageCpc || 0) / 1_000_000,
            conversions,
            conversion_value: convValue,
            roas,
            search_impression_share:             r.metrics.searchImpressionShare ?? null,
            search_budget_lost_impression_share: r.metrics.searchBudgetLostImpressionShare ?? null,
            search_rank_lost_impression_share:   r.metrics.searchRankLostImpressionShare ?? null,
            search_top_impression_share:         r.metrics.searchTopImpressionShare ?? null,
            synced_at: new Date().toISOString(),
          }, { onConflict: 'campaign_id,date' })
          if (!error) stats.campaign_rows++
        }
      } catch (e: any) {
        console.error('[google-sync] campaign_daily:', e.message)
        stats.errors.push(`campaign_daily: ${e.message}`)
      }

      // Ad creatives + daily performance (existing behavior — keep)
      try {
        const q = `
          SELECT
            ad_group_ad.ad.id,
            ad_group_ad.ad.responsive_search_ad.headlines,
            ad_group_ad.ad.responsive_search_ad.descriptions,
            ad_group_ad.ad.final_urls,
            ad_group_ad.ad_strength,
            ad_group_ad.status,
            ad_group.id, ad_group.name,
            campaign.id, campaign.name,
            metrics.impressions, metrics.clicks, metrics.cost_micros,
            metrics.ctr, metrics.conversions
          FROM ad_group_ad
          WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
            AND ad_group_ad.status != 'REMOVED'
            AND campaign.status != 'REMOVED'
            AND segments.date BETWEEN '${since14}' AND '${today}'
        `
        const rows = await gaqlSearch(apiUrl, apiHeaders, q, 'ad_creatives')
        const adStrengthMap: Record<string, string> = {
          EXCELLENT: 'מצוין', GOOD: 'טוב', AVERAGE: 'ממוצע',
          POOR: 'חלש', PENDING: 'בבדיקה',
        }
        for (const r of rows) {
          const rsa = r.adGroupAd?.ad?.responsiveSearchAd ?? {}
          const headlines    = (rsa.headlines ?? []).map((h: any) => h.text).filter(Boolean)
          const descriptions = (rsa.descriptions ?? []).map((d: any) => d.text).filter(Boolean)
          await supabase.from('google_ads').upsert({
            ad_id:        String(r.adGroupAd?.ad?.id ?? ''),
            ad_group_id:  String(r.adGroup?.id ?? ''),
            ad_group_name: r.adGroup?.name ?? '',
            campaign_id:  String(r.campaign?.id ?? ''),
            campaign_name: r.campaign?.name ?? '',
            status:       r.adGroupAd?.status ?? '',
            ad_strength:  adStrengthMap[r.adGroupAd?.adStrength ?? ''] ?? r.adGroupAd?.adStrength ?? '',
            headlines, descriptions,
            final_urls:  r.adGroupAd?.ad?.finalUrls ?? [],
            impressions: r.metrics?.impressions ?? 0,
            clicks:      r.metrics?.clicks ?? 0,
            cost:        (r.metrics?.costMicros ?? 0) / 1_000_000,
            ctr:         r.metrics?.ctr ?? 0,
            conversions: r.metrics?.conversions ?? 0,
            synced_at:   new Date().toISOString(),
          }, { onConflict: 'ad_id' })
          stats.ad_rows++
        }
      } catch (e: any) {
        console.error('[google-sync] ad_creatives:', e.message)
        stats.errors.push(`ad_creatives: ${e.message}`)
      }

      // Keyword daily + top-100 keyword_ideas (backward compat)
      try {
        const q = `
          SELECT
            ad_group_criterion.keyword.text,
            ad_group_criterion.keyword.match_type,
            ad_group.id, ad_group.name,
            campaign.id, campaign.name,
            metrics.impressions, metrics.clicks, metrics.cost_micros,
            metrics.ctr, metrics.average_cpc,
            metrics.conversions, metrics.conversions_value,
            metrics.search_impression_share,
            segments.date
          FROM keyword_view
          WHERE campaign.status != 'REMOVED'
            AND ad_group_criterion.type = 'KEYWORD'
            AND ad_group_criterion.status != 'REMOVED'
            AND segments.date BETWEEN '${since14}' AND '${today}'
          ORDER BY metrics.cost_micros DESC
          LIMIT 2000
        `
        const rows = await gaqlSearch(apiUrl, apiHeaders, q, 'keywords_daily')
        // Aggregate per-keyword for the legacy keyword_ideas table (top-100).
        const kwAgg: Map<string, any> = new Map()
        for (const r of rows) {
          const kw = r.adGroupCriterion?.keyword?.text ?? ''
          const match = r.adGroupCriterion?.keyword?.matchType ?? 'UNSPECIFIED'
          if (!kw) continue
          // Per-day row to google_keywords_daily
          await supabase.from('google_keywords_daily').upsert({
            campaign_id: String(r.campaign?.id ?? ''),
            ad_group_id: String(r.adGroup?.id ?? ''),
            keyword_text: kw,
            match_type: match,
            date: r.segments.date,
            impressions: r.metrics?.impressions ?? 0,
            clicks: r.metrics?.clicks ?? 0,
            cost_micros: r.metrics?.costMicros ?? 0,
            conversions: r.metrics?.conversions ?? 0,
            conversion_value: r.metrics?.conversionsValue ?? 0,
            ctr: r.metrics?.ctr ?? 0,
            avg_cpc_micros: r.metrics?.averageCpc ?? 0,
            search_impression_share: r.metrics?.searchImpressionShare ?? null,
            synced_at: new Date().toISOString(),
          }, { onConflict: 'campaign_id,ad_group_id,keyword_text,match_type,date' })
          stats.keyword_rows++

          // Aggregate for legacy keyword_ideas
          const key = kw
          if (!kwAgg.has(key)) {
            kwAgg.set(key, { impressions: 0, clicks: 0, cost: 0, matchType: match, impShare: 0, impShareN: 0 })
          }
          const a = kwAgg.get(key)!
          a.impressions += r.metrics?.impressions ?? 0
          a.clicks += r.metrics?.clicks ?? 0
          a.cost += (r.metrics?.costMicros ?? 0) / 1_000_000
          if (r.metrics?.searchImpressionShare) {
            a.impShare += r.metrics.searchImpressionShare
            a.impShareN += 1
          }
        }
        // Populate legacy keyword_ideas (backward compat for existing doctor code)
        const topKeywords = [...kwAgg.entries()]
          .sort((a, b) => b[1].impressions - a[1].impressions)
          .slice(0, 150)
        for (const [kw, a] of topKeywords) {
          const avgCpc = a.clicks > 0 ? a.cost / a.clicks : 0
          const avgIS = a.impShareN > 0 ? (a.impShare / a.impShareN) * 100 : 0
          await supabase.from('keyword_ideas').upsert({
            keyword: kw,
            avg_monthly_searches: a.impressions,
            competition: a.matchType,
            competition_index: parseFloat(avgIS.toFixed(1)),
            low_top_bid_micros: Math.round(avgCpc * 1_000_000),
            high_top_bid_micros: Math.round(avgCpc * 1_000_000 * 1.2),
            synced_at: new Date().toISOString(),
          }, { onConflict: 'keyword' })
        }
      } catch (e: any) {
        console.error('[google-sync] keywords_daily:', e.message)
        stats.errors.push(`keywords_daily: ${e.message}`)
      }

      // Search terms report — what users actually typed
      try {
        const q = `
          SELECT
            search_term_view.search_term,
            search_term_view.status,
            segments.keyword.info.text,
            segments.keyword.info.match_type,
            ad_group.id, campaign.id,
            metrics.impressions, metrics.clicks, metrics.cost_micros,
            metrics.conversions, metrics.conversions_value,
            segments.date
          FROM search_term_view
          WHERE campaign.status != 'REMOVED'
            AND segments.date BETWEEN '${since14}' AND '${today}'
            AND metrics.cost_micros > 0
          ORDER BY metrics.cost_micros DESC
          LIMIT 2000
        `
        const rows = await gaqlSearch(apiUrl, apiHeaders, q, 'search_terms')
        for (const r of rows) {
          const term = r.searchTermView?.searchTerm ?? ''
          if (!term) continue
          await supabase.from('google_search_terms').upsert({
            campaign_id: String(r.campaign?.id ?? ''),
            ad_group_id: String(r.adGroup?.id ?? ''),
            search_term: term,
            triggering_keyword: r.segments?.keyword?.info?.text ?? null,
            match_type: r.segments?.keyword?.info?.matchType ?? null,
            date: r.segments.date,
            impressions: r.metrics?.impressions ?? 0,
            clicks: r.metrics?.clicks ?? 0,
            cost_micros: r.metrics?.costMicros ?? 0,
            conversions: r.metrics?.conversions ?? 0,
            conversion_value: r.metrics?.conversionsValue ?? 0,
            status: r.searchTermView?.status ?? null,
            synced_at: new Date().toISOString(),
          }, { onConflict: 'campaign_id,ad_group_id,search_term,date' })
          stats.search_term_rows++
        }
      } catch (e: any) {
        console.error('[google-sync] search_terms:', e.message)
        stats.errors.push(`search_terms: ${e.message}`)
      }

      // Ad-group daily performance
      try {
        const q = `
          SELECT
            ad_group.id, ad_group.name,
            campaign.id,
            metrics.impressions, metrics.clicks, metrics.cost_micros,
            metrics.ctr, metrics.conversions, metrics.conversions_value,
            metrics.search_impression_share,
            segments.date
          FROM ad_group
          WHERE ad_group.status != 'REMOVED'
            AND campaign.status != 'REMOVED'
            AND segments.date BETWEEN '${since14}' AND '${today}'
          ORDER BY metrics.cost_micros DESC
        `
        const rows = await gaqlSearch(apiUrl, apiHeaders, q, 'ad_group_daily')
        for (const r of rows) {
          await supabase.from('google_ad_group_daily').upsert({
            ad_group_id: String(r.adGroup?.id ?? ''),
            campaign_id: String(r.campaign?.id ?? ''),
            ad_group_name: r.adGroup?.name ?? null,
            date: r.segments.date,
            impressions: r.metrics?.impressions ?? 0,
            clicks: r.metrics?.clicks ?? 0,
            cost_micros: r.metrics?.costMicros ?? 0,
            conversions: r.metrics?.conversions ?? 0,
            conversion_value: r.metrics?.conversionsValue ?? 0,
            ctr: r.metrics?.ctr ?? 0,
            search_impression_share: r.metrics?.searchImpressionShare ?? null,
            synced_at: new Date().toISOString(),
          }, { onConflict: 'ad_group_id,date' })
          stats.ad_group_daily_rows++
        }
      } catch (e: any) {
        console.error('[google-sync] ad_group_daily:', e.message)
        stats.errors.push(`ad_group_daily: ${e.message}`)
      }

      // Click view → gclid → campaign_id mapping. THE fix for PMax attribution.
      // click_view requires single-day segments — must query 14 days separately.
      //
      // BEFORE: serial for-loop over 14 days, ~3-5s per day = 40-70s total.
      //         This was the single biggest contributor to the wall-clock
      //         timeout that killed the function with HTTP 546.
      // AFTER:  Promise.allSettled over 14 days fires concurrent requests;
      //         total time ~= max(any one day) ≈ 5s. Order-independent
      //         since each day upserts on the unique gclid key.
      try {
        const dayPromises = Array.from({ length: 14 }, async (_, d) => {
          const targetDate = daysAgo(d)
          const q = `
            SELECT
              click_view.gclid,
              campaign.id, ad_group.id,
              segments.ad_network_type,
              segments.device,
              segments.date
            FROM click_view
            WHERE segments.date = '${targetDate}'
          `
          let dayCount = 0
          try {
            const rows = await gaqlSearch(apiUrl, apiHeaders, q, `click_view_${targetDate}`)
            for (const r of rows) {
              const gclid = r.clickView?.gclid
              if (!gclid) continue
              await supabase.from('google_click_mapping').upsert({
                gclid,
                campaign_id: String(r.campaign?.id ?? ''),
                ad_group_id: String(r.adGroup?.id ?? ''),
                click_date: r.segments.date,
                device: r.segments?.device ?? null,
                synced_at: new Date().toISOString(),
              }, { onConflict: 'gclid' })
              dayCount++
            }
          } catch (dayErr: any) {
            // Some days may have no clicks; don't abort the whole sync
            if (!dayErr.message.includes('no results')) {
              console.warn(`[google-sync] click_view ${targetDate}:`, dayErr.message)
            }
          }
          return dayCount
        })
        const results = await Promise.allSettled(dayPromises)
        const clickLoopCount = results
          .filter(r => r.status === 'fulfilled')
          .reduce((sum, r: any) => sum + r.value, 0)
        stats.click_mapping_rows += clickLoopCount
        console.log(`[google-sync] click_view: ${clickLoopCount} gclids mapped across 14 days (parallel)`)
      } catch (e: any) {
        console.error('[google-sync] click_view:', e.message)
        stats.errors.push(`click_view: ${e.message}`)
      }
    }

      // ── Log final result ────────────────────────────────────────────────
      // UPDATE the row we inserted at the start of the request, instead of
      // INSERT-ing a new one. The 'running' row's id was returned to the
      // client so it can poll for completion.
      const totalRecords = stats.campaign_rows + stats.ad_rows + stats.keyword_rows
        + stats.search_term_rows + stats.ad_group_daily_rows + stats.click_mapping_rows
        + stats.account_settings_rows + stats.campaign_settings_rows
        + stats.ad_group_settings_rows + stats.audience_rows + stats.conversion_action_rows

      await supabase.from('sync_log').update({
        status:    stats.errors.length ? 'partial' : 'success',
        records:   totalRecords,
        error_msg: stats.errors.length ? stats.errors.join(' | ').slice(0, 500) : null,
        finished_at: new Date().toISOString(),
        stats,
      }).eq('id', syncId)

    } catch (err: any) {
      console.error('[google-sync] fatal:', err.message)
      await supabase.from('sync_log').update({
        status: 'error',
        error_msg: err.message,
        finished_at: new Date().toISOString(),
        stats,
      }).eq('id', syncId)
    }
  })())

  // Return 202 Accepted immediately. Client polls sync_log row by id.
  return new Response(
    JSON.stringify({
      success: true,
      status: 'running',
      sync_id: syncId,
      message: 'Sync started in background. Poll /rest/v1/sync_log?id=eq.<sync_id> for status.',
    }),
    { status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
})
