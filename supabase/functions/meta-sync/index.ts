import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Per-environment Meta IDs come from Supabase secrets, not hardcoded.
// If the secret isn't set the function fails fast at startup with a
// clear message — better than silently sending requests to whatever
// the previous hardcoded value was, which makes accidents (e.g. running
// a fork against the wrong ad account) much harder to spot.
const AD_ACCOUNT_ID = Deno.env.get('META_AD_ACCOUNT_ID')
if (!AD_ACCOUNT_ID) throw new Error('META_AD_ACCOUNT_ID secret is required')

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const startedAt = new Date().toISOString()
  let records = 0

  // ── Scope control ──────────────────────────────────────────
  // Supabase functions have a 150s gateway timeout. Doing everything in one
  // invocation blows past that. Callers control scope two ways:
  //
  //   ?mode=settings     → account_settings + adsets + ads (rarely changed)
  //   ?mode=performance  → campaigns daily + adset_daily + placement_daily
  //                         + ad_daily + ig (fresh every doctor run)
  //   ?mode=all          → everything (legacy behavior for the cron)
  //
  // Granular override via ?parts= still works for debugging — if `parts` is
  // present it takes priority over `mode`.
  const url       = new URL(req.url)
  const mode      = (url.searchParams.get('mode') ?? '').toLowerCase()
  const partsRaw  = url.searchParams.get('parts')
    ?? (mode === 'settings'    ? 'account_settings,adsets,ads'
     :  mode === 'performance' ? 'campaigns,adset_daily,placement_daily,ad_daily,ig'
     :  mode === 'voc'         ? 'ig_comments,fb_comments,ig_dms'
     :  mode === 'all'         ? 'all'
     :  'campaigns,ig')       // default for back-compat
  const parts     = new Set(partsRaw.split(',').map(s => s.trim()).filter(Boolean))
  const run       = (name: string) => parts.has(name) || parts.has('all')
  // Per-stage diagnostic counters returned in the response so we don't have
  // to dig through function logs to figure out where a 0-records sync died.
  const stats = {
    campaigns_found:      0,
    campaign_rows:        0,
    campaign_errors:      0,
    adsets_found:         0,
    adset_rows:           0,
    adset_errors:         0,
    ads_found:            0,
    ad_rows:              0,
    ad_errors:            0,
    account_settings_rows:0,
    adset_daily_rows:     0,
    placement_daily_rows: 0,
    ad_daily_rows:        0,
    pages_found:          0,
    ig_account_id:        null as string | null,
    ig_posts_found:       0,
    ig_post_rows:         0,
    ig_post_errors:       0,
    ig_comment_rows:      0,
    fb_comment_rows:      0,
    ig_dm_thread_rows:    0,
    ig_dm_message_rows:   0,
    comment_errors:       0,
    follower_count:       0,
    last_meta_error:      null as string | null,
    token_granted:        [] as string[],
    token_declined:       [] as string[],
  }

  try {
    const { data: tokenRow } = await supabase
      .from('oauth_tokens').select('access_token').eq('platform', 'meta').single()
    if (!tokenRow) throw new Error('Meta not connected')
    const token = tokenRow.access_token

    // Diagnostic: what permissions did OAuth actually grant vs decline? This
    // is the source of truth — the FLB Configuration UI is unreliable because
    // a permission can appear selected there but fail to reach the token if
    // the user skipped a consent step or the permission needs App Review for
    // Advanced Access and the app is still in Development mode.
    try {
      const permsRes = await fetch(`https://graph.facebook.com/v19.0/me/permissions?access_token=${token}`)
      const perms = await permsRes.json()
      if (perms.error) {
        stats.last_meta_error = perms.error.message
      } else if (Array.isArray(perms.data)) {
        for (const p of perms.data) {
          if (p.status === 'granted') stats.token_granted.push(p.permission)
          else if (p.status === 'declined') stats.token_declined.push(p.permission)
        }
      }
    } catch (e: any) {
      console.error('[meta-sync] /me/permissions fetch error:', e?.message)
    }

    const today = new Date().toISOString().split('T')[0]

    // ── Ads sync ──────────────────────────────────────────────
    // Two old bugs fixed here:
    //
    // 1. Conversion type filter was hardcoded to `purchase`. Meta returns an
    //    `actions` array containing every action type the campaign drove —
    //    leads, add_to_cart, custom pixel events, subscribes, etc. The old
    //    code only counted purchases, so any campaign optimizing for leads or
    //    custom events showed conversions=0 in the dashboard.
    //
    // 2. Insights used `date_preset=last_90d` which returns ONE aggregated
    //    row covering the whole 90 days, but the upsert stamped `date: today`.
    //    Every sync overwrote the same row, so per-day historical data was
    //    impossible. Now uses `time_increment=1` to get one row per day.
    //
    // Conversion definition: sum of every action_type that's a real
    // conversion event. Excludes engagement actions (link_click,
    // post_engagement, video_view, etc.) which Meta lumps into the same
    // `actions` array but shouldn't count as conversions.

    const CONVERSION_TYPE_PATTERNS = [
      /^purchase$/, /^lead$/, /^complete_registration$/, /^subscribe$/,
      /^add_to_cart$/, /^initiate_checkout$/, /^add_payment_info$/,
      /^offsite_conversion\./,            // Pixel events
      /^onsite_conversion\.purchase$/,    // On-FB purchases
      /^onsite_conversion\.lead/,         // On-FB leads
    ]
    const isConversionType = (t: string) => CONVERSION_TYPE_PATTERNS.some(rx => rx.test(t))

    // Helper: page through all results when Meta returns paging.next.
    // Surfaces Meta API errors to stats.last_meta_error — without this,
    // a permission issue or malformed field list returns [] with no clue
    // in the response payload. Debugging that is miserable.
    async function fetchAll<T = any>(url: string, label = 'unknown'): Promise<T[]> {
      const out: T[] = []
      let next: string | null = url
      while (next) {
        const r = await fetch(next)
        const j: any = await r.json()
        if (j.error) {
          const msg = `${label}: ${j.error.message} (code=${j.error.code}${j.error.error_subcode ? `/${j.error.error_subcode}` : ''})`
          console.error('[meta-sync] paged fetch error:', msg)
          stats.last_meta_error = msg
          break
        }
        if (Array.isArray(j.data)) out.push(...j.data)
        next = j.paging?.next ?? null
      }
      return out
    }

    // Active-only campaign list. We still fetch 90 days of daily insights
    // per active campaign (campaigns that were active at any point in that
    // window still contribute historical rows to meta_ad_campaigns).
    const campaignEffFilter = encodeURIComponent('["ACTIVE"]')
    const campaigns = run('campaigns') ? await fetchAll<any>(
      `https://graph.facebook.com/v18.0/${AD_ACCOUNT_ID}/campaigns?fields=name,status,objective&effective_status=${campaignEffFilter}&limit=50&access_token=${token}`,
      'campaigns'
    ) : []
    stats.campaigns_found = campaigns.length
    if (run('campaigns')) console.log(`[meta-sync] campaigns fetched: ${campaigns.length}`)

    for (const campaign of campaigns) {
      // time_increment=1 → one insights row per day, each with date_start.
      const insightsUrl =
        `https://graph.facebook.com/v18.0/${campaign.id}/insights` +
        `?fields=spend,impressions,clicks,cpm,cpc,ctr,actions` +
        `&date_preset=last_90d&time_increment=1&access_token=${token}`
      const dailyRows = await fetchAll<any>(insightsUrl)

      for (const i of dailyRows) {
        const dayDate = i.date_start ?? today
        let conversions = 0
        for (const a of (i.actions || [])) {
          if (isConversionType(a.action_type)) conversions += parseInt(a.value || '0', 10)
        }

        const { error: upErr } = await supabase.from('meta_ad_campaigns').upsert({
          campaign_id: String(campaign.id),
          date:        dayDate,
          name:        campaign.name,
          status:      campaign.status,
          objective:   campaign.objective,
          spend:       parseFloat(i.spend || '0'),
          impressions: parseInt(i.impressions || '0'),
          clicks:      parseInt(i.clicks || '0'),
          cpm:         parseFloat(i.cpm || '0'),
          cpc:         parseFloat(i.cpc || '0'),
          ctr:         parseFloat(i.ctr || '0'),
          conversions,
          synced_at:   new Date().toISOString(),
        }, { onConflict: 'campaign_id,date' })

        if (upErr) {
          stats.campaign_errors++
          stats.last_meta_error = upErr.message
          console.error('[meta-sync] campaign upsert failed', campaign.id, dayDate, upErr.message)
        } else {
          stats.campaign_rows++
          records++
        }
      }
    }

    // ── Ad-set snapshot sync ──────────────────────────────────
    //
    // Pulls the current targeting + budget + optimization config for every
    // ad set in the account. This is where the audience lives — the Campaign
    // Doctor needs this data to diagnose audience-level issues (too broad,
    // wrong optimization goal, Advantage+ misuse, placement/creative mismatch).
    //
    // Latest-state snapshot, not time-series: one row per adset, overwritten
    // on each sync. Targeting/budget change rarely; daily history isn't useful.
    //
    // Budget fields arrive in minor currency units (agorot for ILS). Divided
    // by 100 on write so downstream consumers see whole ILS.
    if (run('adsets')) try {
      const adsetFields = [
        'name', 'status', 'effective_status', 'campaign_id',
        'optimization_goal', 'billing_event', 'bid_strategy',
        'daily_budget', 'lifetime_budget', 'budget_remaining',
        'targeting', 'promoted_object', 'destination_type',
        'learning_stage_info', 'created_time', 'updated_time',
      ].join(',')
      // Active-only filter for the same reason as ads — doctor only cares
      // about adsets that are live or recently paused.
      const effStatusFilter = encodeURIComponent('["ACTIVE"]')
      const adsets = await fetchAll<any>(
        `https://graph.facebook.com/v18.0/${AD_ACCOUNT_ID}/adsets?fields=${adsetFields}&effective_status=${effStatusFilter}&limit=100&access_token=${token}`,
        'adsets'
      )
      stats.adsets_found = adsets.length
      console.log(`[meta-sync] adsets fetched: ${adsets.length}`)

      for (const a of adsets) {
        const toIls = (v: any) => v != null ? (parseInt(v, 10) / 100) : null
        const { error: upErr } = await supabase.from('meta_ad_adsets').upsert({
          adset_id:            String(a.id),
          campaign_id:         a.campaign_id ? String(a.campaign_id) : null,
          name:                a.name ?? null,
          status:              a.status ?? null,
          effective_status:    a.effective_status ?? null,
          optimization_goal:   a.optimization_goal ?? null,
          billing_event:       a.billing_event ?? null,
          bid_strategy:        a.bid_strategy ?? null,
          daily_budget:        toIls(a.daily_budget),
          lifetime_budget:     toIls(a.lifetime_budget),
          budget_remaining:    toIls(a.budget_remaining),
          targeting:           a.targeting ?? null,
          promoted_object:     a.promoted_object ?? null,
          destination_type:    a.destination_type ?? null,
          learning_stage_info: a.learning_stage_info ?? null,
          created_time:        a.created_time ?? null,
          updated_time:        a.updated_time ?? null,
          synced_at:           new Date().toISOString(),
        }, { onConflict: 'adset_id' })

        if (upErr) {
          stats.adset_errors++
          stats.last_meta_error = upErr.message
          console.error('[meta-sync] adset upsert failed', a.id, upErr.message)
        } else {
          stats.adset_rows++
          records++
        }
      }
    } catch (e: any) {
      console.error('[meta-sync] adsets sync threw', e?.message)
      stats.last_meta_error = `adsets: ${e?.message}`
    }

    // ── Ad (creative) snapshot sync ───────────────────────────
    //
    // One row per ad, latest-state. We flatten the nested `creative` object
    // into columns so the doctor can reason over headlines, primary text,
    // CTAs, and creative format without re-fetching. `object_story_spec` is
    // where FB puts the link/message/image when the creative was built inline
    // (vs. a pre-existing page post) — we pull title/body/CTA from whichever
    // location actually has them.
    if (run('ads')) try {
      const adFields = [
        'name', 'status', 'effective_status', 'adset_id', 'campaign_id',
        // Slimmer creative fields — skip object_story_spec which is the
        // heaviest blob and often duplicates title/body. If we need it
        // later for CAROUSEL creatives, add a lazy lookup per-ad.
        'creative{id,title,body,call_to_action_type,image_url,video_id}',
        'created_time', 'updated_time',
      ].join(',')
      // Active-only filter — paused/archived ads aren't useful for the
      // doctor, and pulling everything pushes us past the 150s gateway.
      // Meta's `effective_status` filter is a URL-encoded JSON array.
      const effStatusFilter = encodeURIComponent('["ACTIVE"]')
      const ads = await fetchAll<any>(
        `https://graph.facebook.com/v18.0/${AD_ACCOUNT_ID}/ads?fields=${adFields}&effective_status=${effStatusFilter}&limit=100&access_token=${token}`,
        'ads'
      )
      stats.ads_found = ads.length
      console.log(`[meta-sync] ads fetched: ${ads.length}`)

      for (const a of ads) {
        const c = a.creative ?? {}

        // Detect creative type from top-level creative fields. We used to
        // inspect object_story_spec too, but that field is heavy enough to
        // blow the 150s gateway on this account (342 adsets).
        let creativeType: string | null = null
        if (c.video_id)      creativeType = 'VIDEO'
        else if (c.image_url) creativeType = 'IMAGE'
        else if (c.id)       creativeType = 'UNKNOWN' // CAROUSEL/dynamic — needs follow-up fetch

        const title    = c.title ?? null
        const body     = c.body ?? null
        const cta      = c.call_to_action_type ?? null
        const linkUrl  = null // no object_story_spec → enrich later if needed
        const imageUrl = c.image_url ?? null
        const videoId  = c.video_id ?? null

        const { error: upErr } = await supabase.from('meta_ads').upsert({
          ad_id:            String(a.id),
          adset_id:         a.adset_id ? String(a.adset_id) : null,
          campaign_id:      a.campaign_id ? String(a.campaign_id) : null,
          name:             a.name ?? null,
          status:           a.status ?? null,
          effective_status: a.effective_status ?? null,
          creative_id:      c.id ? String(c.id) : null,
          creative_type:    creativeType,
          title,
          body,
          call_to_action:   cta,
          link_url:         linkUrl,
          image_url:        imageUrl,
          video_id:         videoId,
          created_time:     a.created_time ?? null,
          updated_time:     a.updated_time ?? null,
          synced_at:        new Date().toISOString(),
        }, { onConflict: 'ad_id' })

        if (upErr) {
          stats.ad_errors++
          stats.last_meta_error = upErr.message
          console.error('[meta-sync] ad upsert failed', a.id, upErr.message)
        } else {
          stats.ad_rows++
          records++
        }
      }
    } catch (e: any) {
      console.error('[meta-sync] ads sync threw', e?.message)
      stats.last_meta_error = `ads: ${e?.message}`
    }

    // ── Account-level settings ────────────────────────────────
    // Minuto-wide Meta Ads config: currency, time zone, pixel, spend caps.
    // One row, overwritten on each settings sync. Tells the doctor what
    // pixel to expect events from and whether the account has spend
    // caps that would bottleneck scaling.
    if (run('account_settings')) try {
      const accUrl = `https://graph.facebook.com/v18.0/${AD_ACCOUNT_ID}?fields=name,currency,timezone_name,business,amount_spent,spend_cap,account_status,funding_source_details&access_token=${token}`
      const res = await fetch(accUrl)
      const data = await res.json()
      if (data.error) {
        stats.last_meta_error = `account_settings: ${data.error.message}`
      } else {
        const { error: upErr } = await supabase.from('meta_account_settings').upsert({
          ad_account_id:  AD_ACCOUNT_ID,
          name:           data.name ?? null,
          currency:       data.currency ?? null,
          time_zone:      data.timezone_name ?? null,
          business_id:    data.business?.id ?? null,
          amount_spent:   data.amount_spent ? parseFloat(data.amount_spent) / 100 : null,
          spend_cap:      data.spend_cap ? parseFloat(data.spend_cap) / 100 : null,
          account_status: data.account_status ?? null,
          funding_source: data.funding_source_details?.display_string ?? null,
          synced_at:      new Date().toISOString(),
        }, { onConflict: 'ad_account_id' })
        if (!upErr) stats.account_settings_rows = 1
      }
    } catch (e: any) {
      console.error('[meta-sync] account_settings threw', e?.message)
      stats.last_meta_error = `account_settings: ${e?.message}`
    }

    // ── Ad-set daily insights ─────────────────────────────────
    // Daily-breakdown performance per adset. Answers "which audience segment
    // inside this campaign actually converts". Active adsets only to respect
    // the 150s gateway; last 14 days.
    if (run('adset_daily')) try {
      const effFilter = encodeURIComponent('["ACTIVE"]')
      const fields = 'adset_id,campaign_id,impressions,clicks,spend,cpm,cpc,ctr,frequency,reach,actions,date_start'
      const insightsUrl = `https://graph.facebook.com/v18.0/${AD_ACCOUNT_ID}/insights`
        + `?level=adset&fields=${fields}`
        + `&date_preset=last_14d&time_increment=1`
        + `&filtering=[{"field":"adset.effective_status","operator":"IN","value":["ACTIVE"]}]`
        + `&effective_status=${effFilter}&limit=500&access_token=${token}`
      const rows = await fetchAll<any>(insightsUrl, 'adset_daily')
      for (const r of rows) {
        let conversions = 0
        for (const a of (r.actions || [])) {
          if (isConversionType(a.action_type)) conversions += parseInt(a.value || '0', 10)
        }
        const { error: upErr } = await supabase.from('meta_adset_daily').upsert({
          adset_id:     String(r.adset_id ?? ''),
          campaign_id:  r.campaign_id ? String(r.campaign_id) : null,
          date:         r.date_start,
          impressions:  parseInt(r.impressions || '0'),
          clicks:       parseInt(r.clicks || '0'),
          spend:        parseFloat(r.spend || '0'),
          conversions,
          cpm:          parseFloat(r.cpm || '0'),
          cpc:          parseFloat(r.cpc || '0'),
          ctr:          parseFloat(r.ctr || '0'),
          frequency:    parseFloat(r.frequency || '0'),
          reach:        parseInt(r.reach || '0'),
          synced_at:    new Date().toISOString(),
        }, { onConflict: 'adset_id,date' })
        if (!upErr) stats.adset_daily_rows++
      }
    } catch (e: any) {
      console.error('[meta-sync] adset_daily threw', e?.message)
      stats.last_meta_error = `adset_daily: ${e?.message}`
    }

    // ── Placement-level daily performance ─────────────────────
    // Breakdown by publisher_platform + platform_position. Reveals if
    // Instagram Reels is converting while Facebook Feed is burning money,
    // etc. Critical for per-placement bid adjustments.
    if (run('placement_daily')) try {
      const fields = 'adset_id,campaign_id,impressions,clicks,spend,actions,date_start'
      const breakdown = 'publisher_platform,platform_position'
      const insightsUrl = `https://graph.facebook.com/v18.0/${AD_ACCOUNT_ID}/insights`
        + `?level=adset&fields=${fields}&breakdowns=${breakdown}`
        + `&date_preset=last_14d&time_increment=1`
        + `&filtering=[{"field":"adset.effective_status","operator":"IN","value":["ACTIVE"]}]`
        + `&limit=500&access_token=${token}`
      const rows = await fetchAll<any>(insightsUrl, 'placement_daily')
      for (const r of rows) {
        let conversions = 0
        for (const a of (r.actions || [])) {
          if (isConversionType(a.action_type)) conversions += parseInt(a.value || '0', 10)
        }
        const { error: upErr } = await supabase.from('meta_placement_daily').upsert({
          adset_id:           String(r.adset_id ?? ''),
          campaign_id:        r.campaign_id ? String(r.campaign_id) : null,
          publisher_platform: r.publisher_platform ?? 'unknown',
          platform_position:  r.platform_position ?? 'unknown',
          date:               r.date_start,
          impressions:        parseInt(r.impressions || '0'),
          clicks:             parseInt(r.clicks || '0'),
          spend:              parseFloat(r.spend || '0'),
          conversions,
          synced_at:          new Date().toISOString(),
        }, { onConflict: 'adset_id,publisher_platform,platform_position,date' })
        if (!upErr) stats.placement_daily_rows++
      }
    } catch (e: any) {
      console.error('[meta-sync] placement_daily threw', e?.message)
      stats.last_meta_error = `placement_daily: ${e?.message}`
    }

    // ── Ad-level daily performance ────────────────────────────
    // Which specific ads are converting vs. just getting impressions.
    if (run('ad_daily')) try {
      const fields = 'ad_id,adset_id,campaign_id,impressions,clicks,spend,ctr,actions,date_start'
      const insightsUrl = `https://graph.facebook.com/v18.0/${AD_ACCOUNT_ID}/insights`
        + `?level=ad&fields=${fields}`
        + `&date_preset=last_14d&time_increment=1`
        + `&filtering=[{"field":"ad.effective_status","operator":"IN","value":["ACTIVE"]}]`
        + `&limit=500&access_token=${token}`
      const rows = await fetchAll<any>(insightsUrl, 'ad_daily')
      for (const r of rows) {
        let conversions = 0
        for (const a of (r.actions || [])) {
          if (isConversionType(a.action_type)) conversions += parseInt(a.value || '0', 10)
        }
        const { error: upErr } = await supabase.from('meta_ad_daily').upsert({
          ad_id:       String(r.ad_id ?? ''),
          adset_id:    r.adset_id ? String(r.adset_id) : null,
          campaign_id: r.campaign_id ? String(r.campaign_id) : null,
          date:        r.date_start,
          impressions: parseInt(r.impressions || '0'),
          clicks:      parseInt(r.clicks || '0'),
          spend:       parseFloat(r.spend || '0'),
          conversions,
          ctr:         parseFloat(r.ctr || '0'),
          synced_at:   new Date().toISOString(),
        }, { onConflict: 'ad_id,date' })
        if (!upErr) stats.ad_daily_rows++
      }
    } catch (e: any) {
      console.error('[meta-sync] ad_daily threw', e?.message)
      stats.last_meta_error = `ad_daily: ${e?.message}`
    }

    // ── Instagram organic sync ────────────────────────────────
    if (run('ig')) try {
      const pagesRes = await fetch(`https://graph.facebook.com/v18.0/me/accounts?access_token=${token}`)
      const pages = await pagesRes.json()
      console.log('Pages:', JSON.stringify(pages).slice(0, 300))

      stats.pages_found = pages.data?.length ?? 0
      if (pages.error) {
        stats.last_meta_error = pages.error.message
        console.error('[meta-sync] /me/accounts error:', pages.error.message)
      }
      if (pages.data?.length) {
        const pageToken = pages.data[0].access_token
        const pageId = pages.data[0].id

        const igRes = await fetch(
          `https://graph.facebook.com/v18.0/${pageId}?fields=instagram_business_account&access_token=${pageToken}`
        )
        const igData = await igRes.json()
        const igId = igData.instagram_business_account?.id
        stats.ig_account_id = igId ?? null
        if (igData.error) {
          stats.last_meta_error = igData.error.message
          console.error('[meta-sync] page IG lookup error:', igData.error.message)
        }
        console.log('IG account id:', igId)

        if (igId) {
          // Fetch account follower count and store in meta_daily_insights
          try {
            const igAccountRes = await fetch(
              `https://graph.facebook.com/v18.0/${igId}?fields=followers_count,media_count&access_token=${pageToken}`
            )
            const igAccount = await igAccountRes.json()
            const followerCount = igAccount.followers_count ?? 0
            stats.follower_count = followerCount
            if (igAccount.error) {
              stats.last_meta_error = igAccount.error.message
              console.error('[meta-sync] IG account fetch error:', igAccount.error.message)
            }
            console.log('IG followers:', followerCount)
            if (followerCount > 0) {
              await supabase.from('meta_daily_insights').upsert({
                date: today,
                follower_count: followerCount,
              }, { onConflict: 'date' })
            }
          } catch (fcErr) {
            console.log('Follower count fetch error:', fcErr.message)
          }

          // Fetch media with thumbnail
          const postsRes = await fetch(
            `https://graph.facebook.com/v18.0/${igId}/media?fields=id,media_type,caption,timestamp,like_count,comments_count,thumbnail_url,media_url&limit=50&access_token=${pageToken}`
          )
          const postsData = await postsRes.json()
          stats.ig_posts_found = postsData.data?.length ?? 0
          if (postsData.error) {
            stats.last_meta_error = postsData.error.message
            console.error('[meta-sync] IG media fetch error:', postsData.error.message)
          }
          console.log('Posts:', JSON.stringify(postsData).slice(0, 300))

          if (postsData.data) {
            for (const post of postsData.data) {
              // Instagram Graph API metric deprecation history:
              //   - `impressions` was deprecated for IG media in late 2024 — including
              //     it in the metric list makes the WHOLE request fail, which the old
              //     code silently swallowed and stored 0 for every metric.
              //   - `views` is the modern replacement for impressions on REEL/VIDEO.
              //   - `total_interactions` is the new aggregate engagement field.
              //   - `reach`, `saved`, `shares` still supported across types.
              // We pick the metric set per media_type and log every failure instead
              // of silently catching, so future deprecations are visible in the logs.
              const isVideo = post.media_type === 'VIDEO' || post.media_type === 'REELS'
              const metricList = isVideo
                ? 'reach,views,saved,shares,total_interactions'
                : 'reach,saved,shares,total_interactions'

              let reach = 0, impressions = 0, saves = 0, shares = 0
              try {
                const insRes = await fetch(
                  `https://graph.facebook.com/v18.0/${post.id}/insights?metric=${metricList}&access_token=${pageToken}`
                )
                const insData = await insRes.json()
                if (insData.error) {
                  console.error('[meta-sync] IG insights error', post.id, post.media_type, insData.error.message)
                } else if (insData.data) {
                  for (const m of insData.data) {
                    const v = m.values?.[0]?.value || 0
                    if (m.name === 'reach')              reach       = v
                    else if (m.name === 'views')         impressions = v   // store views as impressions for backwards compat
                    else if (m.name === 'saved')         saves       = v
                    else if (m.name === 'shares')        shares      = v
                    // total_interactions is logged but not stored — likes+comments+shares+saves already covers it
                  }
                }
              } catch (e: any) {
                console.error('[meta-sync] IG insights fetch threw', post.id, e?.message)
              }

              const { error: upErr } = await supabase.from('meta_organic_posts').upsert({
                post_id: post.id,
                post_type: post.media_type === 'VIDEO' ? 'reel' : 'post',
                message: post.caption,
                created_at: post.timestamp,
                likes: post.like_count || 0,
                comments: post.comments_count || 0,
                thumbnail_url: post.thumbnail_url || post.media_url || null,
                reach, impressions, saves, shares,
              }, { onConflict: 'post_id' })
              if (upErr) {
                stats.ig_post_errors++
                stats.last_meta_error = upErr.message
                console.error('[meta-sync] post upsert failed', post.id, upErr.message)
              } else {
                stats.ig_post_rows++
                records++
              }
            }
          }
        }
      }
    } catch (igErr) {
      console.log('Instagram sync error:', igErr.message)
    }

    // ── Instagram + Facebook comments ─────────────────────────
    // Voice-of-Customer raw source. Comments are where real Hebrew
    // buying language surfaces — questions ("מתאים לדלונגי?"), objections
    // ("מחיר יקר"), reactions ("וואו הריח"). Uses existing
    // instagram_basic + pages_read_engagement permissions (no re-auth).
    //
    // Strategy: fetch comments for posts with engagement — skip posts
    // with 0 comments (no signal), cap at 30 most recent posts to keep
    // timing inside the 150s gateway.
    if (run('ig_comments')) try {
      // Re-derive pages + IG account (same flow as organic sync, but only
      // runs when ig_comments is explicitly requested to avoid duplicate work
      // when both ig and ig_comments parts are active).
      const pagesRes2 = await fetch(`https://graph.facebook.com/v18.0/me/accounts?access_token=${token}`)
      const pagesJ = await pagesRes2.json()
      const page = pagesJ.data?.[0]
      if (page) {
        const pageToken = page.access_token
        const igRes = await fetch(
          `https://graph.facebook.com/v18.0/${page.id}?fields=instagram_business_account&access_token=${pageToken}`
        )
        const igJ = await igRes.json()
        const igId = igJ.instagram_business_account?.id
        if (igId) {
          // Fetch recent IG media ids + comment counts (light call, no insights).
          const mediaRes = await fetch(
            `https://graph.facebook.com/v18.0/${igId}/media?fields=id,comments_count,timestamp&limit=30&access_token=${pageToken}`
          )
          const mediaJ = await mediaRes.json()
          const mediaList = (mediaJ.data ?? []).filter((m: any) => (m.comments_count ?? 0) > 0)

          for (const media of mediaList) {
            try {
              // Fetch first page of comments per media. Pagination via
              // paging.next if needed, capped at 100 comments per post.
              let commentsUrl = `https://graph.facebook.com/v18.0/${media.id}/comments?fields=id,text,username,timestamp,like_count,replies{id,text,username,timestamp,like_count}&limit=50&access_token=${pageToken}`
              let fetched = 0
              while (commentsUrl && fetched < 100) {
                const cRes = await fetch(commentsUrl)
                const cJ = await cRes.json()
                if (cJ.error) {
                  console.error('[meta-sync] ig_comments error for', media.id, cJ.error.message)
                  stats.comment_errors++
                  break
                }
                for (const c of (cJ.data ?? [])) {
                  // Top-level comment
                  await supabase.from('instagram_comments').upsert({
                    comment_id:    c.id,
                    post_id:       media.id,
                    text:          c.text ?? null,
                    username:      c.username ?? null,
                    like_count:    c.like_count ?? 0,
                    replies_count: (c.replies?.data ?? []).length,
                    created_time:  c.timestamp ?? null,
                    parent_comment_id: null,
                    synced_at:     new Date().toISOString(),
                  }, { onConflict: 'comment_id' })
                  stats.ig_comment_rows++
                  fetched++
                  // Threaded replies
                  for (const r of (c.replies?.data ?? [])) {
                    await supabase.from('instagram_comments').upsert({
                      comment_id:    r.id,
                      post_id:       media.id,
                      text:          r.text ?? null,
                      username:      r.username ?? null,
                      like_count:    r.like_count ?? 0,
                      replies_count: 0,
                      created_time:  r.timestamp ?? null,
                      parent_comment_id: c.id,
                      synced_at:     new Date().toISOString(),
                    }, { onConflict: 'comment_id' })
                    stats.ig_comment_rows++
                    fetched++
                  }
                }
                commentsUrl = cJ.paging?.next ?? ''
              }
            } catch (e: any) {
              console.error('[meta-sync] ig_comments per-post error', media.id, e?.message)
              stats.comment_errors++
            }
          }
        }
      }
    } catch (e: any) {
      console.error('[meta-sync] ig_comments threw', e?.message)
      stats.last_meta_error = `ig_comments: ${e?.message}`
    }

    // Facebook page post comments — same pattern but Graph uses slightly
    // different field names (`message` instead of `text`, `from` object).
    if (run('fb_comments')) try {
      const pagesRes3 = await fetch(`https://graph.facebook.com/v18.0/me/accounts?access_token=${token}`)
      const pagesJ = await pagesRes3.json()
      const page = pagesJ.data?.[0]
      if (page) {
        const pageToken = page.access_token
        // Get recent page posts
        const postsRes = await fetch(
          `https://graph.facebook.com/v18.0/${page.id}/posts?fields=id,comments.summary(true){id,message,from{id,name},created_time,like_count,comment_count,comments{id,message,from{id,name},created_time,like_count}}&limit=30&access_token=${pageToken}`
        )
        const postsJ = await postsRes.json()
        if (postsJ.error) {
          console.error('[meta-sync] fb_posts error', postsJ.error.message)
          stats.last_meta_error = `fb_posts: ${postsJ.error.message}`
        } else {
          for (const p of (postsJ.data ?? [])) {
            for (const c of (p.comments?.data ?? [])) {
              await supabase.from('facebook_comments').upsert({
                comment_id:    c.id,
                post_id:       p.id,
                message:       c.message ?? null,
                from_name:     c.from?.name ?? null,
                from_id:       c.from?.id ?? null,
                like_count:    c.like_count ?? 0,
                comment_count: (c.comments?.data ?? []).length,
                created_time:  c.created_time ?? null,
                parent_comment_id: null,
                synced_at:     new Date().toISOString(),
              }, { onConflict: 'comment_id' })
              stats.fb_comment_rows++
              for (const r of (c.comments?.data ?? [])) {
                await supabase.from('facebook_comments').upsert({
                  comment_id:    r.id,
                  post_id:       p.id,
                  message:       r.message ?? null,
                  from_name:     r.from?.name ?? null,
                  from_id:       r.from?.id ?? null,
                  like_count:    r.like_count ?? 0,
                  comment_count: 0,
                  created_time:  r.created_time ?? null,
                  parent_comment_id: c.id,
                  synced_at:     new Date().toISOString(),
                }, { onConflict: 'comment_id' })
                stats.fb_comment_rows++
              }
            }
          }
        }
      }
    } catch (e: any) {
      console.error('[meta-sync] fb_comments threw', e?.message)
      stats.last_meta_error = `fb_comments: ${e?.message}`
    }

    // ── Instagram Direct Messages ───────────────────────────
    //
    // Requires `instagram_business_manage_messages` permission (Meta App
    // Review + Business Verification required). If the current token
    // doesn't include it, the API returns a specific permission error —
    // we catch it gracefully and surface in stats.last_meta_error so the
    // user knows to re-auth.
    //
    // Privacy handling (Meta App Review compliance):
    //   - Usernames stored in instagram_dms but stripped before voc-mine
    //   - Raw messages auto-purged after 30 days (scheduled cleanup, see
    //     follow-up task). We flag `purged=false` on insert so the purge
    //     job can find unpurged rows.
    //   - Only aggregated patterns (voc_insights) retained indefinitely.
    if (run('ig_dms')) try {
      // Get IG business account id (same flow as organic sync).
      const pagesRes4 = await fetch(`https://graph.facebook.com/v18.0/me/accounts?access_token=${token}`)
      const pagesJ = await pagesRes4.json()
      const page = pagesJ.data?.[0]
      if (!page) {
        stats.last_meta_error = `ig_dms: no page found`
      } else {
        const pageToken = page.access_token
        const igLookup = await fetch(
          `https://graph.facebook.com/v18.0/${page.id}?fields=instagram_business_account&access_token=${pageToken}`
        )
        const igLookupJ = await igLookup.json()
        const igId = igLookupJ.instagram_business_account?.id
        if (!igId) {
          stats.last_meta_error = `ig_dms: no IG business account linked to page`
        } else {
          // List conversations (DM threads). Platform=instagram filters to
          // IG-only (the endpoint can also return Messenger threads).
          // Meta routes IG messaging through the Facebook Page infrastructure,
          // not the IG account directly. The /conversations endpoint expects
          // the PAGE id with ?platform=instagram, not the IG user id. Calling
          // it with igId returns error code 3 ("capability not available")
          // which looks like a permission issue but is actually a wrong-endpoint
          // issue. Took a while to figure out.
          // Two-step fetch to avoid Meta backend timeouts:
          //   Step 1: list conversation IDs (lightweight query, just id +
          //           updated_time). Meta times out if we also ask for
          //           participants/message_count expanded for each.
          //   Step 2: per conversation, fetch messages — participant info
          //           comes along for free inside each message's `from`.
          //
          // limit=25 is Meta's hard cap on this endpoint. fetchAll follows
          // paging.next automatically — we cap outer loop at 50 pages
          // (= 1250 conversations) which is more than enough for VoC.
          // Even with fields=id only, Meta rejects >10 per page if the
          // account has heavy message history. Start small and only fetch
          // the first page — don't paginate. 10 most-recent conversations
          // is a solid VoC sample (most-recent are most-relevant anyway).
          const convUrl = `https://graph.facebook.com/v18.0/${page.id}/conversations?platform=instagram&fields=id&limit=10&access_token=${pageToken}`
          const convRes = await fetch(convUrl)
          const convJ = await convRes.json()
          if (convJ.error) {
            console.error('[meta-sync] ig_dms_conversations error', convJ.error.message)
            stats.last_meta_error = `ig_dms_conversations: ${convJ.error.message} (code=${convJ.error.code})`
            throw new Error('abort ig_dms')
          }
          const conversations = convJ.data ?? []
          const recentConvs = conversations

          for (const conv of recentConvs) {
            // Fetch messages (includes participant id in `from`). Message
            // limit 20 per thread — enough for VoC patterns without pushing
            // sync past the gateway timeout.
            try {
              const msgsUrl = `https://graph.facebook.com/v18.0/${conv.id}?fields=messages.limit(20){id,from,message,created_time,attachments}&access_token=${pageToken}`
              const msgsRes = await fetch(msgsUrl)
              const msgsJ = await msgsRes.json()
              if (msgsJ.error) {
                console.error('[meta-sync] ig_dms msgs error for', conv.id, msgsJ.error.message)
                stats.comment_errors++
                continue
              }
              const messages = msgsJ.messages?.data ?? []

              // Identify the customer from the first non-Minuto sender
              let customerId: string | null = null
              let customerUsername: string | null = null
              for (const m of messages) {
                const fromId = m.from?.id ? String(m.from.id) : null
                if (fromId && fromId !== String(igId)) {
                  customerId = fromId
                  customerUsername = m.from?.username ?? null
                  break
                }
              }

              await supabase.from('instagram_dm_threads').upsert({
                conversation_id:      String(conv.id),
                participant_id:       customerId,
                participant_username: customerUsername,
                message_count:        messages.length,
                last_message_time:    conv.updated_time ?? null,
                last_synced_at:       new Date().toISOString(),
              }, { onConflict: 'conversation_id' })
              stats.ig_dm_thread_rows++

              for (const m of messages) {
                const fromId = m.from?.id ? String(m.from.id) : null
                const isFromMinuto = fromId === String(igId)
                await supabase.from('instagram_dms').upsert({
                  message_id:      String(m.id),
                  conversation_id: String(conv.id),
                  sender_id:       fromId,
                  sender_username: m.from?.username ?? null,
                  is_from_minuto:  isFromMinuto,
                  message:         m.message ?? null,
                  attachments:     m.attachments ?? null,
                  created_time:    m.created_time ?? null,
                  synced_at:       new Date().toISOString(),
                  purged:          false,
                }, { onConflict: 'message_id' })
                stats.ig_dm_message_rows++
              }
            } catch (msgsErr: any) {
              console.error('[meta-sync] ig_dms per-thread error', conv.id, msgsErr?.message)
              stats.comment_errors++
            }
          }
        }
      }
    } catch (e: any) {
      console.error('[meta-sync] ig_dms threw', e?.message)
      stats.last_meta_error = `ig_dms: ${e?.message}`
    }

    await supabase.from('sync_log').insert({
      platform: 'meta', status: 'success', records,
      started_at: startedAt, finished_at: new Date().toISOString(),
    })

    return new Response(JSON.stringify({ success: true, records, parts: [...parts], stats }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (err) {
    console.error('Meta sync error:', err.message)
    await supabase.from('sync_log').insert({
      platform: 'meta', status: 'error', error_msg: err.message,
      started_at: startedAt, finished_at: new Date().toISOString(),
    })
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
