// Minuto SEO Agent — GA4 sync.
//
// Pulls landing-page performance from Google Analytics 4 Data API and
// upserts into ga4_pages_daily for the orchestrator to consume.
//
// Default mode: sync last N days of Organic Search landing-page metrics
// for the configured GA4_PROPERTY_ID. Idempotent — daily cron re-syncs
// the trailing window to capture late-arriving conversion data.
//
// Diagnostic mode (POST body: {diagnostic: true}): returns the service-
// account email + project_id + property_id WITHOUT calling GA4. Use this
// once to copy the SA email into GA4 admin → Property access management
// → Add user (Viewer role).
//
// Auth: reuses the existing _shared/vertex_auth.ts JWT-bearer flow. The
// 'cloud-platform' scope already covers GA4 Data API; no new credentials
// to manage. The same GCP_SERVICE_ACCOUNT_JSON used by Vertex Imagen
// signs the JWT. Just make sure the SA is granted Viewer on the GA4
// property.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { isServiceCaller, unauthorized } from '../_shared/service_caller.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { getGoogleAccessToken } from '../_shared/vertex_auth.ts'
import { createLogger } from '../_shared/logger.ts'

// GA4 Data API requires this narrow scope — cloud-platform alone returns
// 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT. The shared auth helper caches
// tokens per-scope so this doesn't conflict with Vertex's cloud-platform
// token.
const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly'

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PROPERTY_ID   = Deno.env.get('GA4_PROPERTY_ID') ?? ''

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// Default sync window — 7 days. Daily cron re-syncs this trailing window
// so late-arriving conversions (attribution delays etc.) get captured.
const DEFAULT_LOOKBACK_DAYS = 7

interface SyncBody {
  diagnostic?: boolean
  lookback_days?: number
  channel_group?: string  // default 'Organic Search'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  // verify_jwt is off, so the caller is checked here. Only the ga4-sync-* crons call this; the diagnostic mode reveals the service
  // account, so it is gated too.
  if (!(await isServiceCaller(req))) return unauthorized(CORS_HEADERS)
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  // Created after the auth check so an unauthenticated caller cannot write log rows.
  const log = createLogger('ga4-sync')
  try {
    let body: SyncBody = {}
    try { body = await req.json() } catch { /* empty body ok */ }

    // ── DIAGNOSTIC MODE — no API call, just surface the SA email so the
    // admin can grant it Viewer access in GA4 admin without digging through
    // GCP console.
    if (body.diagnostic) {
      try {
        const raw = Deno.env.get('GCP_SERVICE_ACCOUNT_JSON')
        if (!raw) {
          log.error('config.missing', 'GCP_SERVICE_ACCOUNT_JSON not set', { mode: 'diagnostic' })
          await log.finish('error', { mode: 'diagnostic' })
          return jsonResponse({ error: 'GCP_SERVICE_ACCOUNT_JSON not set', run_id: log.runId }, 500)
        }
        const parsed = JSON.parse(raw)
        await log.finish('success', { mode: 'diagnostic' })
        return jsonResponse({
          run_id: log.runId,
          service_account_email: parsed.client_email,
          project_id:            parsed.project_id ?? Deno.env.get('GCP_PROJECT_ID'),
          has_ga4_property_id:   !!PROPERTY_ID,
          ga4_property_id:       PROPERTY_ID || null,
          instructions: PROPERTY_ID
            ? `Service account email above is ready. In GA4 admin → Property access management → Add user, paste the email with Viewer role. Then call this function with no body to do a real sync.`
            : `Set GA4_PROPERTY_ID env var first (via 'supabase secrets set'), then grant the service_account_email above Viewer role in GA4 admin → Property access management → Add user.`,
        })
      } catch (e: any) {
        // Not passing `e`: a JSON.parse error on the SA JSON can quote part of it.
        log.error('diagnostic.fail', 'diagnostic failed', { mode: 'diagnostic' })
        await log.finish('error', { mode: 'diagnostic' })
        return jsonResponse({ error: `diagnostic failed: ${e?.message ?? e}`, run_id: log.runId }, 500)
      }
    }

    // ── REAL SYNC ────────────────────────────────────────────────────────
    if (!PROPERTY_ID) {
      log.error('config.missing', 'GA4_PROPERTY_ID not configured')
      await log.finish('error')
      return jsonResponse({
        error: 'GA4_PROPERTY_ID not configured. Set via: supabase secrets set GA4_PROPERTY_ID=<id> --project-ref ytydgldyeygpzmlxvpvb',
        run_id: log.runId,
      }, 500)
    }

    const lookbackDays = Math.max(1, Math.min(90, body.lookback_days ?? DEFAULT_LOOKBACK_DAYS))
    const channelGroup = body.channel_group ?? 'Organic Search'

    const startDate = isoDate(addDays(new Date(), -lookbackDays))
    const endDate   = 'today'   // GA4 accepts the literal 'today' keyword

    console.log(`[ga4-sync] property=${PROPERTY_ID} window=${startDate}..${endDate} channel="${channelGroup}"`)
    // Five crons call this, one per channel group; channel tells their runs apart.
    const ctx = { channel: channelGroup, start_date: startDate, lookback_days: lookbackDays }
    log.info('run.start', `window ${startDate}..${endDate} channel "${channelGroup}"`, ctx)

    let token: string
    try {
      token = await getGoogleAccessToken(GA4_SCOPE)
    } catch (e: any) {
      log.error('google.auth.fail', 'Google access token request failed', ctx, e)
      await log.finish('error', ctx)
      return jsonResponse({ error: `auth failed: ${e?.message ?? e}`, run_id: log.runId }, 500)
    }

    // Build the GA4 runReport request. We pull per (date, pagePath) with
    // a channel filter so the orchestrator can read straight from the table.
    const reportBody = {
      dateRanges: [{ startDate, endDate }],
      dimensions: [
        { name: 'date' },
        { name: 'pagePath' },
        { name: 'sessionDefaultChannelGroup' },
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'activeUsers' },
        { name: 'engagedSessions' },
        { name: 'screenPageViews' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' },
        { name: 'conversions' },
        { name: 'totalRevenue' },     // proxy for conversion_value
      ],
      dimensionFilter: {
        filter: {
          fieldName: 'sessionDefaultChannelGroup',
          stringFilter: {
            matchType: 'EXACT',
            value:      channelGroup,
          },
        },
      },
      limit: '10000',
      orderBys: [{ desc: true, metric: { metricName: 'sessions' } }],
    }

    const apiUrl = `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`
    const apiRes = await fetch(apiUrl, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(reportBody),
    })

    if (!apiRes.ok) {
      const errText = await apiRes.text().catch(() => '')
      log.error('ga4.fetch.fail', `GA4 Data API ${apiRes.status}`, { ...ctx, status: apiRes.status, body: errText.slice(0, 600) })
      await log.finish('error', { ...ctx, status: apiRes.status })
      return jsonResponse({
        run_id: log.runId,
        error: `GA4 Data API ${apiRes.status}: ${errText.slice(0, 600)}`,
        hint:  apiRes.status === 403
          ? 'Service account likely lacks Viewer role on this GA4 property. Open GA4 admin → Property access management → Add user with the service_account_email from {diagnostic:true}.'
          : undefined,
      }, apiRes.status === 403 ? 403 : 500)
    }

    const report = await apiRes.json() as {
      rows?: Array<{
        dimensionValues: Array<{ value: string }>
        metricValues:    Array<{ value: string }>
      }>
      rowCount?: number
    }

    const rows = report.rows ?? []
    if (rows.length === 0) {
      // The quiet failure: nothing throws, nothing is written.
      log.warn('ga4.empty', 'GA4 returned 0 rows for this channel + window', ctx)
      await log.finish('success', { ...ctx, rows_returned: 0, upserted: 0 })
      return jsonResponse({
        run_id:     log.runId,
        processed:  0,
        window:     { startDate, endDate, channelGroup, propertyId: PROPERTY_ID },
        note:       'GA4 returned 0 rows. Check the property has data for this channel + date range.',
      })
    }

    // Map GA4 response → ga4_pages_daily rows. GA4 returns date in
    // YYYYMMDD format (no dashes); convert to ISO YYYY-MM-DD.
    const upsertRows = rows.map(r => {
      const [dateRaw, pagePath, ch] = r.dimensionValues.map(d => d.value)
      const [sessions, activeUsers, engagedSessions, screenPageViews,
             bounceRate, avgSessionDuration, conversions, totalRevenue] =
        r.metricValues.map(m => m.value)
      return {
        date:                  `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`,
        page_path:             pagePath,
        channel_group:         ch,
        sessions:              Number(sessions) || 0,
        active_users:          Number(activeUsers) || 0,
        engaged_sessions:      Number(engagedSessions) || 0,
        screen_page_views:     Number(screenPageViews) || 0,
        bounce_rate:           bounceRate ? Number(bounceRate) : null,
        avg_session_duration:  avgSessionDuration ? Number(avgSessionDuration) : null,
        conversions:           Number(conversions) || 0,
        conversion_value:      Number(totalRevenue) || 0,
        synced_at:             new Date().toISOString(),
      }
    })

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)
    // Upsert against the (date, page_path, channel_group) PK so re-runs
    // overwrite cleanly. Chunk to stay under Supabase row-limit per call.
    const CHUNK_SIZE = 500
    let totalUpserted = 0
    for (let i = 0; i < upsertRows.length; i += CHUNK_SIZE) {
      const chunk = upsertRows.slice(i, i + CHUNK_SIZE)
      const { error } = await supabase
        .from('ga4_pages_daily')
        .upsert(chunk, { onConflict: 'date,page_path,channel_group' })
      if (error) {
        log.error('ga4.upsert.fail', `ga4_pages_daily upsert failed at chunk ${i / CHUNK_SIZE}`, { ...ctx, code: error.code, message: error.message, upserted_so_far: totalUpserted })
        await log.finish(totalUpserted > 0 ? 'partial' : 'error', { ...ctx, rows_returned: rows.length, upserted: totalUpserted })
        return jsonResponse({
          run_id: log.runId,
          error: `upsert failed at chunk ${i / CHUNK_SIZE}: ${error.message}`,
          upserted_so_far: totalUpserted,
        }, 500)
      }
      totalUpserted += chunk.length
    }

    console.log(`[ga4-sync] upserted ${totalUpserted} rows`)
    await log.finish('success', { ...ctx, rows_returned: rows.length, upserted: totalUpserted })

    return jsonResponse({
      processed:    totalUpserted,
      window:       { startDate, endDate, channelGroup, propertyId: PROPERTY_ID },
      rows_returned: rows.length,
      rowCount:     report.rowCount ?? null,
      run_id:       log.runId,
    })
  } catch (err) {
    log.error('run.throw', 'sync aborted by an unhandled error', undefined, err)
    await log.finish('error')
    throw err
  }
})

function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0]
}
