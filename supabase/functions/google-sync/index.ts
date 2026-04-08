import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

  const startedAt = new Date().toISOString()
  let records = 0

  try {
    const devToken = Deno.env.get('GOOGLE_DEVELOPER_TOKEN')
    if (!devToken) throw new Error('GOOGLE_DEVELOPER_TOKEN not set')

    const { data: tokenRow } = await supabase
      .from('oauth_tokens')
      .select('*')
      .eq('platform', 'google')
      .single()

    if (!tokenRow) throw new Error('Google not connected')

    const accessToken = await refreshGoogleToken(tokenRow.refresh_token)
    await supabase.from('oauth_tokens').update({
      access_token: accessToken,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    }).eq('platform', 'google')

    const rawCustomerId = Deno.env.get('GOOGLE_CUSTOMER_ID')!
    const customerId = rawCustomerId.replace(/-/g, '')
    const loginCustomerId = (Deno.env.get('GOOGLE_LOGIN_CUSTOMER_ID') ?? '').replace(/-/g, '')

    const today = new Date().toISOString().split('T')[0]
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

    const query = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.ctr,
        metrics.average_cpc,
        metrics.conversions,
        metrics.conversions_value,
        segments.date
      FROM campaign
      WHERE segments.date BETWEEN '${monthAgo}' AND '${today}'
        AND campaign.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 200
    `

    const url = `https://googleads.googleapis.com/v20/customers/${customerId}/googleAds:search`

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': devToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    })

    const rawText = await res.text()
    let data
    try {
      data = JSON.parse(rawText)
    } catch {
      throw new Error(`API returned non-JSON (${res.status}): ${rawText.substring(0, 200)}`)
    }

    if (data.error) throw new Error(JSON.stringify(data.error))

    for (const row of data.results || []) {
      const cost = (row.metrics.costMicros || 0) / 1_000_000
      const conversions = row.metrics.conversions || 0
      const convValue = row.metrics.conversionsValue || 0
      const roas = cost > 0 ? convValue / cost : 0

      await supabase.from('google_campaigns').upsert({
        campaign_id: row.campaign.id,
        date: row.segments.date,
        name: row.campaign.name,
        status: row.campaign.status,
        impressions: row.metrics.impressions || 0,
        clicks: row.metrics.clicks || 0,
        cost,
        ctr: row.metrics.ctr || 0,
        cpc: (row.metrics.averageCpc || 0) / 1_000_000,
        conversions,
        conversion_value: convValue,
        roas,
      }, { onConflict: 'campaign_id,date' })

      records++
    }

    // ── Fetch RSA ad creatives ─────────────────────────────────────────────
    const adQuery = `
      SELECT
        ad_group_ad.ad.id,
        ad_group_ad.ad.responsive_search_ad.headlines,
        ad_group_ad.ad.responsive_search_ad.descriptions,
        ad_group_ad.ad.final_urls,
        ad_group_ad.ad_strength,
        ad_group_ad.status,
        ad_group.id,
        ad_group.name,
        campaign.id,
        campaign.name,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.ctr,
        metrics.conversions
      FROM ad_group_ad
      WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
        AND ad_group_ad.status != 'REMOVED'
        AND campaign.status != 'REMOVED'
        AND segments.date BETWEEN '${monthAgo}' AND '${today}'
    `

    const adRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': devToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: adQuery }),
    })

    const adRawText = await adRes.text()
    let adData
    try { adData = JSON.parse(adRawText) } catch {
      console.error('Ad creative API non-JSON:', adRawText.substring(0, 200))
      adData = { results: [] }
    }

    let adRecords = 0
    for (const row of adData.results || []) {
      const rsa = row.adGroupAd?.ad?.responsiveSearchAd ?? {}
      const headlines    = (rsa.headlines    ?? []).map((h: { text: string }) => h.text).filter(Boolean)
      const descriptions = (rsa.descriptions ?? []).map((d: { text: string }) => d.text).filter(Boolean)
      const finalUrls    = row.adGroupAd?.ad?.finalUrls ?? []
      const adStrengthRaw = row.adGroupAd?.adStrength ?? ''

      const adStrengthMap: Record<string, string> = {
        EXCELLENT: 'מצוין', GOOD: 'טוב', AVERAGE: 'ממוצע',
        POOR: 'חלש', PENDING: 'בבדיקה',
      }

      await supabase.from('google_ads').upsert({
        ad_id:        String(row.adGroupAd?.ad?.id ?? ''),
        ad_group_id:  String(row.adGroup?.id ?? ''),
        ad_group_name: row.adGroup?.name ?? '',
        campaign_id:  String(row.campaign?.id ?? ''),
        campaign_name: row.campaign?.name ?? '',
        status:       row.adGroupAd?.status ?? '',
        ad_strength:  adStrengthMap[adStrengthRaw] ?? adStrengthRaw,
        headlines,
        descriptions,
        final_urls:   finalUrls,
        impressions:  row.metrics?.impressions ?? 0,
        clicks:       row.metrics?.clicks ?? 0,
        cost:         (row.metrics?.costMicros ?? 0) / 1_000_000,
        ctr:          row.metrics?.ctr ?? 0,
        conversions:  row.metrics?.conversions ?? 0,
        synced_at:    new Date().toISOString(),
      }, { onConflict: 'ad_id' })

      adRecords++
    }

    console.log(`[google-sync] Ad creatives synced: ${adRecords}`)

    // ── Keyword-level performance (keyword_view GAQL) ─────────────────────────
    // Note: Google Ads Keyword Planner has no REST API — gRPC only.
    // Instead we query keyword_view for real performance data from Minuto's own campaigns.
    let keywordRecords = 0
    try {
      const kwQuery = `
        SELECT
          ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type,
          ad_group_criterion.status,
          campaign.name,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.ctr,
          metrics.average_cpc,
          metrics.conversions,
          metrics.search_impression_share,
          metrics.search_top_impression_share
        FROM keyword_view
        WHERE campaign.status != 'REMOVED'
          AND ad_group_criterion.type = 'KEYWORD'
          AND ad_group_criterion.status != 'REMOVED'
          AND segments.date BETWEEN '${monthAgo}' AND '${today}'
        ORDER BY metrics.impressions DESC
        LIMIT 150
      `

      // Note: use same headers as campaign queries (no login-customer-id) — that's what works
      const kwRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': devToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: kwQuery }),
      })

      const kwRawText = await kwRes.text()
      let kwData: any
      try { kwData = JSON.parse(kwRawText) } catch {
        console.error('[google-sync] keyword_view non-JSON:', kwRawText.substring(0, 200))
        kwData = { results: [] }
      }

      if (kwData.error) {
        console.warn('[google-sync] keyword_view error:', JSON.stringify(kwData.error).substring(0, 300))
      } else {
        const kwResults = kwData.results ?? []
        console.log(`[google-sync] keyword_view results: ${kwResults.length}`)
        for (const row of kwData.results ?? []) {
          const kw     = row.adGroupCriterion?.keyword?.text ?? ''
          const match  = row.adGroupCriterion?.keyword?.matchType ?? 'UNSPECIFIED'
          const impr   = row.metrics?.impressions ?? 0
          const clicks = row.metrics?.clicks ?? 0
          const cost   = (row.metrics?.costMicros ?? 0) / 1_000_000
          const cpc    = (row.metrics?.averageCpc ?? 0) / 1_000_000
          const impShare = row.metrics?.searchImpressionShare ?? 0
          const topShare = row.metrics?.searchTopImpressionShare ?? 0

          if (!kw) continue

          await supabase.from('keyword_ideas').upsert({
            keyword:               kw,
            avg_monthly_searches:  impr,   // reuse field: lifetime impressions from our campaigns
            competition:           match,  // reuse field: match type
            competition_index:     parseFloat((impShare * 100).toFixed(1)),   // impression share %
            low_top_bid_micros:    Math.round(cpc * 1_000_000),               // actual CPC in micros
            high_top_bid_micros:   Math.round((cost > 0 ? cost / Math.max(clicks, 1) : cpc) * 1_000_000 * 1.2),
            synced_at:             new Date().toISOString(),
          }, { onConflict: 'keyword' })
          keywordRecords++
        }
      }
    } catch (kwErr: any) {
      console.warn('[google-sync] keyword_view fetch failed:', kwErr.message)
    }

    console.log(`[google-sync] Keyword ideas synced: ${keywordRecords}`)

    await supabase.from('sync_log').insert({
      platform: 'google',
      status: 'success',
      records: records + adRecords + keywordRecords,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })

    return new Response(JSON.stringify({ success: true, campaign_records: records, ad_records: adRecords, keyword_records: keywordRecords }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error('Google sync error:', err.message)
    await supabase.from('sync_log').insert({
      platform: 'google',
      status: 'error',
      error_msg: err.message,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })

    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
