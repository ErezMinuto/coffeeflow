/**
 * CoffeeFlow — Google Search Console Sync
 *
 * Fetches organic search performance (keywords, clicks, impressions, CTR, position)
 * from Google Search Console and upserts into google_search_console table.
 *
 * Each run syncs a short window: by default the last 5 days ending yesterday
 * (Search Console revises roughly the last 3). A backfill passes
 * { "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD" }, at most 14 days per
 * call. One call for the whole 90 days (~130k rows) hit the worker's resource limit.
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
import { forbidden, hasRole } from '../_shared/role_caller.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { forEachGscPage, syncWindow, toDbRows, upsertInBatches, type GscApiRow, type GscDbRow } from './rows.ts'

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
  // verify_jwt is off, so the caller is checked here. Callers: an admin from dashboard Settings and auto-sync.yml (service key).
  if (!(await hasRole(req, ['admin']))) return forbidden(CORS)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const startedAt = new Date().toISOString()
  let records = 0

  const win = syncWindow(await req.json().catch(() => ({})))
  if ('error' in win) {
    return new Response(JSON.stringify({ error: win.error }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
  const { startDate, endDate } = win

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

    console.log(`Fetching GSC data for ${siteUrl} from ${startDate} to ${endDate}`)

    // One searchAnalytics.query call, as a page of rows. Search Console caps a
    // call at 25,000 rows; forEachGscPage repeats it with startRow and hands
    // each page over before fetching the next.
    const queryPage = (dimensions: string[]) => async (startRow: number, rowLimit: number): Promise<GscApiRow[]> => {
      const res = await fetch(
        `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ startDate, endDate, dimensions, rowLimit, startRow, dataState: 'all' }),
        }
      )
      if (!res.ok) {
        const errText = await res.text()
        throw new Error(`Search Console API error (${res.status}) for ${dimensions.join('+')} at row ${startRow}: ${errText.substring(0, 300)}`)
      }
      return (await res.json()).rows ?? []
    }

    // Upsert each page in batches of 1,000. Any write error throws, so the run
    // is logged as an error instead of a silent success.
    const upsert = (batch: GscDbRow[]) =>
      supabase.from('google_search_console').upsert(batch, { onConflict: 'date,keyword,page' })
    const syncedAt = new Date().toISOString()

    // Query 1: every keyword (query + date dimensions)
    await forEachGscPage(queryPage(['query', 'date']), async (page) => {
      records += await upsertInBatches(toDbRows(page, [], syncedAt), upsert, 1000)
    })
    console.log(`Keyword rows upserted: ${records}`)

    // Query 2: every page (page + date dimensions). As before, a Search Console
    // error here does not fail the keyword sync (it ends the page rows); a
    // database write error still fails the run.
    const keywordRecords = records
    const pagePage = queryPage(['page', 'date'])
    await forEachGscPage(
      (startRow, rowLimit) => pagePage(startRow, rowLimit).catch((e) => {
        console.warn(`Page rows stopped: ${e instanceof Error ? e.message : String(e)}`)
        return [] as GscApiRow[]
      }),
      async (page) => { records += await upsertInBatches(toDbRows([], page, syncedAt), upsert, 1000) },
    )
    console.log(`Page rows upserted: ${records - keywordRecords}`)

    await supabase.from('sync_log').insert({
      platform: 'google_search',
      status: 'success',
      records,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })

    console.log(`Done. Upserted ${records} rows.`)

    return new Response(JSON.stringify({ success: true, records, site: siteUrl, start_date: startDate, end_date: endDate }), {
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
