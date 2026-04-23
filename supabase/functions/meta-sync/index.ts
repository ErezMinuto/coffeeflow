import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const AD_ACCOUNT_ID = 'act_10154225724732620'

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
  // Supabase functions have a 150s gateway timeout. Doing campaigns +
  // adsets + ads + IG organic + IG insights in one invocation blows past
  // that. Callers can scope the work with ?parts=campaigns,adsets,ads,ig
  // (comma-separated). Default is "campaigns,ig" to preserve the old
  // behavior for anything still calling without params. The adsets/ads
  // parts should be invoked on their own schedule.
  const url      = new URL(req.url)
  const partsRaw = url.searchParams.get('parts') ?? 'campaigns,ig'
  const parts    = new Set(partsRaw.split(',').map(s => s.trim()).filter(Boolean))
  const run      = (name: string) => parts.has(name) || parts.has('all')
  // Per-stage diagnostic counters returned in the response so we don't have
  // to dig through function logs to figure out where a 0-records sync died.
  const stats = {
    campaigns_found:   0,
    campaign_rows:     0,
    campaign_errors:   0,
    adsets_found:      0,
    adset_rows:        0,
    adset_errors:      0,
    ads_found:         0,
    ad_rows:           0,
    ad_errors:         0,
    pages_found:       0,
    ig_account_id:     null as string | null,
    ig_posts_found:    0,
    ig_post_rows:      0,
    ig_post_errors:    0,
    follower_count:    0,
    last_meta_error:   null as string | null,
    token_granted:     [] as string[],
    token_declined:    [] as string[],
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
