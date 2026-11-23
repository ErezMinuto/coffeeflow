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
 * Two more modes for the SEO agent's weekly audit (build plan, Phase 1), run
 * by .github/workflows/seo-audit-weekly.yml:
 *   { "mode": "query_page", "window": "current" | "previous" }
 *       clicks/impressions per (search, page) summed over 28 days → gsc_query_page
 *   { "mode": "inspect", "urls": ["https://www.minuto.co.il/...", ...] }
 *       Google's index status per URL (URL Inspection API, max 60) → gsc_url_inspection
 *
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * (uses same oauth_tokens row as google-sync — same refresh token, different scope)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { forbidden, hasRole } from '../_shared/role_caller.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import {
  chunk, cleanInspectUrls, forEachGscPage, queryPageWindow, syncWindow, toDbRows, toInspectionRow, toQueryPageRows, upsertInBatches,
  type GscApiRow, type GscDbRow,
} from './rows.ts'

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

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const mode = body.mode === 'query_page' || body.mode === 'inspect' ? body.mode : 'daily'
  const win = mode === 'daily' ? syncWindow(body) : mode === 'query_page' ? queryPageWindow(body.window) : { startDate: '', endDate: '' }
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

    if (mode === 'inspect') {
      // Google's index status for each URL. Stops early rather than run into
      // the 150 s gateway limit; the reply says how many were done.
      const urls = cleanInspectUrls(body.urls, siteUrl)
      if (!urls.length) throw new Error('inspect needs urls: absolute https URLs on the site')
      const deadline = Date.now() + 110_000
      const rows = []
      for (const url of urls) {
        if (Date.now() > deadline) break
        const res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ inspectionUrl: url, siteUrl }),
        })
        const j = await res.json().catch(() => ({}))
        rows.push(res.ok ? toInspectionRow(url, j) : { ...toInspectionRow(url, {}), error: `HTTP ${res.status}: ${String(j?.error?.message ?? '').slice(0, 300)}` })
      }
      for (const batch of chunk(rows, 200)) {
        const { error } = await supabase.from('gsc_url_inspection').insert(batch)
        if (error) throw new Error(`gsc_url_inspection insert failed: ${error.message}`)
      }
      const failed = rows.filter((r) => r.error).length
      await supabase.from('sync_log').insert({ platform: 'google_search_inspect', status: failed === rows.length ? 'error' : 'success', records: rows.length, started_at: startedAt, finished_at: new Date().toISOString(), ...(failed ? { error_msg: `${failed} of ${rows.length} inspections failed` } : {}) })
      return new Response(JSON.stringify({ success: failed < rows.length, mode, records: rows.length, failed, requested: urls.length }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

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

    if (mode === 'query_page') {
      // Every (search, page) pair over the window, summed. Replaces that
      // window's rows so a re-run never leaves stale pairs behind.
      const syncedAtQp = new Date().toISOString()
      const { error: delErr } = await supabase.from('gsc_query_page').delete().eq('period_end', endDate).eq('period_days', 28)
      if (delErr) throw new Error(`gsc_query_page clear failed: ${delErr.message}`)
      await forEachGscPage(queryPage(['query', 'page']), async (page) => {
        for (const batch of chunk(toQueryPageRows(page, endDate, syncedAtQp), 1000)) {
          const { error } = await supabase.from('gsc_query_page').upsert(batch, { onConflict: 'period_end,period_days,query,page' })
          if (error) throw new Error(`gsc_query_page upsert failed after ${records} rows: ${error.message}`)
          records += batch.length
        }
      })
      await supabase.from('sync_log').insert({ platform: 'google_search_query_page', status: 'success', records, started_at: startedAt, finished_at: new Date().toISOString() })
      return new Response(JSON.stringify({ success: true, mode, records, start_date: startDate, end_date: endDate }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

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
