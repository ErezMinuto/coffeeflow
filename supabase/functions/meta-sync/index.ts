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

  try {
    const { data: tokenRow } = await supabase
      .from('oauth_tokens').select('access_token').eq('platform', 'meta').single()
    if (!tokenRow) throw new Error('Meta not connected')
    const token = tokenRow.access_token

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
    async function fetchAll<T = any>(url: string): Promise<T[]> {
      const out: T[] = []
      let next: string | null = url
      while (next) {
        const r = await fetch(next)
        const j: any = await r.json()
        if (j.error) {
          console.error('[meta-sync] paged fetch error:', j.error.message)
          break
        }
        if (Array.isArray(j.data)) out.push(...j.data)
        next = j.paging?.next ?? null
      }
      return out
    }

    const campaigns = await fetchAll<any>(
      `https://graph.facebook.com/v18.0/${AD_ACCOUNT_ID}/campaigns?fields=name,status,objective&limit=50&access_token=${token}`
    )
    console.log(`[meta-sync] campaigns fetched: ${campaigns.length}`)

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
          console.error('[meta-sync] campaign upsert failed', campaign.id, dayDate, upErr.message)
        } else {
          records++
        }
      }
    }

    // ── Instagram organic sync ────────────────────────────────
    try {
      const pagesRes = await fetch(`https://graph.facebook.com/v18.0/me/accounts?access_token=${token}`)
      const pages = await pagesRes.json()
      console.log('Pages:', JSON.stringify(pages).slice(0, 300))

      if (pages.data?.length) {
        const pageToken = pages.data[0].access_token
        const pageId = pages.data[0].id

        const igRes = await fetch(
          `https://graph.facebook.com/v18.0/${pageId}?fields=instagram_business_account&access_token=${pageToken}`
        )
        const igData = await igRes.json()
        const igId = igData.instagram_business_account?.id
        console.log('IG account id:', igId)

        if (igId) {
          // Fetch account follower count and store in meta_daily_insights
          try {
            const igAccountRes = await fetch(
              `https://graph.facebook.com/v18.0/${igId}?fields=followers_count,media_count&access_token=${pageToken}`
            )
            const igAccount = await igAccountRes.json()
            const followerCount = igAccount.followers_count ?? 0
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
                console.error('[meta-sync] post upsert failed', post.id, upErr.message)
              } else {
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

    return new Response(JSON.stringify({ success: true, records }), {
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
