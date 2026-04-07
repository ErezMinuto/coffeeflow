/**
 * CoffeeFlow — Google Search Console Sync
 *
 * Fetches organic search performance (keywords, clicks, impressions, CTR, position)
 * from Google Search Console for the last 30 days and upserts into google_search_console table.
 *
 * Site URL: https://www.minuto.co.il (set via GOOGLE_SITE_URL secret)
 *
 * Requires the OAuth token to have scope: https://www.googleapis.com/auth/webmasters.readonly
 * User must reconnect Google after this scope was added.
 *
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * (uses same oauth_tokens row as google-sync — same refresh token, different scope)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const startedAt = new Date().toISOString()
  let records = 0

  try {
    // Fetch stored OAuth token (same token as google-sync)
    const { data: tokenRow } = await supabase
      .from('oauth_tokens')
      .select('*')
      .eq('platform', 'google')
      .single()

    if (!tokenRow) throw new Error('Google not connected — connect Google in Settings first')

    // Refresh access token
    const accessToken = await refreshGoogleToken(tokenRow.refresh_token)
    await supabase.from('oauth_tokens').update({
      access_token: accessToken,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    }).eq('platform', 'google')

    // Site URL — stored as Supabase secret, fallback to env
    const siteUrl = Deno.env.get('GOOGLE_SITE_URL') || 'https://www.minuto.co.il'
    const encodedSite = encodeURIComponent(siteUrl)

    // Date range: last 30 days
    const today = new Date()
    // Search Console has a ~2-day delay, so end at yesterday
    today.setDate(today.getDate() - 1)
    const endDate = today.toISOString().split('T')[0]
    const startDate = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0]

    console.log(`Fetching GSC data for ${siteUrl} from ${startDate} to ${endDate}`)

    // Query 1: Top keywords by clicks (query + date dimensions)
    const keywordRes = await fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startDate,
          endDate,
          dimensions: ['query', 'date'],
          rowLimit: 1000,
          dataState: 'all',
        }),
      }
    )

    if (!keywordRes.ok) {
      const errText = await keywordRes.text()
      throw new Error(`Search Console API error (${keywordRes.status}): ${errText.substring(0, 300)}`)
    }

    const keywordData = await keywordRes.json()
    const rows = keywordData.rows ?? []
    console.log(`Fetched ${rows.length} keyword rows`)

    // Query 2: Top pages by clicks (page + date dimensions)
    const pageRes = await fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startDate,
          endDate,
          dimensions: ['page', 'date'],
          rowLimit: 200,
          dataState: 'all',
        }),
      }
    )

    const pageData = pageRes.ok ? await pageRes.json() : { rows: [] }
    const pageRows = pageData.rows ?? []
    console.log(`Fetched ${pageRows.length} page rows`)

    // Upsert keyword rows
    // GSC dimensions come back as: keys[0]=query, keys[1]=date
    for (const row of rows) {
      const [keyword, date] = row.keys as [string, string]
      await supabase.from('google_search_console').upsert({
        date,
        keyword,
        page: null,
        clicks:      Math.round(row.clicks ?? 0),
        impressions: Math.round(row.impressions ?? 0),
        ctr:         row.ctr ?? 0,
        position:    row.position ?? 0,
        synced_at:   new Date().toISOString(),
      }, { onConflict: 'date,keyword,page' })
      records++
    }

    // Upsert page rows — stored with keyword='__page__' to distinguish
    for (const row of pageRows) {
      const [page, date] = row.keys as [string, string]
      await supabase.from('google_search_console').upsert({
        date,
        keyword: '__page__',
        page,
        clicks:      Math.round(row.clicks ?? 0),
        impressions: Math.round(row.impressions ?? 0),
        ctr:         row.ctr ?? 0,
        position:    row.position ?? 0,
        synced_at:   new Date().toISOString(),
      }, { onConflict: 'date,keyword,page' })
      records++
    }

    await supabase.from('sync_log').insert({
      platform: 'google_search',
      status: 'success',
      records,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })

    console.log(`Done. Upserted ${records} rows.`)

    return new Response(JSON.stringify({ success: true, records, site: siteUrl }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Google Search sync error:', msg)

    await supabase.from('sync_log').insert({
      platform: 'google_search',
      status: 'error',
      error_msg: msg,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })

    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
