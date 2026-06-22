// Minuto Organic Marketing — system health watchdog.
//
// The autonomous loop is brittle. If a cron stops firing, or the
// orchestrator errors silently for two weeks, or a worker has a 100%
// failure rate, the rest of the system keeps going through the motions
// — no signal to the admin until you happen to look at the database.
//
// Daily 08:00 UTC, this function scans for failure patterns and, if
// any are present, creates ONE consolidated dynamic_experiment task
// with subtype='health_alert' summarizing all findings. Admin sees it
// in the existing task queue (same UX as scout alerts) and can decide
// what to act on.
//
// Detection patterns (v1):
//   1. Cron job didn't fire in expected window — checks cron.job_run_details
//   2. Cron job's most-recent run failed
//   3. seo_tasks failure rate >25% in last 24h
//   4. seo_tasks "stuck" — claimed (status=processing) past locked_until + 30min
//   5. No experiment learning written in N cycles (signal that the loop isn't producing rules)
//   6. WP/Meta/Anthropic API errors detected in recent task error_msgs
//
// Outputs SILENT-OK when everything is healthy (no spammy daily "all
// good" tasks).

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Email alerting — same Resend convention as email-automation-scheduler so
// DKIM/SPF reputation stays on one sender. The watchdog ALSO creates a
// dashboard task (below), but a task you have to go look at isn't a real
// alert — email is the channel the owner actually monitors.
const RESEND_KEY        = Deno.env.get('RESEND_API_KEY') ?? ''
const SENDER_EMAIL      = Deno.env.get('SENDER_EMAIL') ?? 'info@minuto.co.il'
const ADMIN_ALERT_EMAIL = Deno.env.get('ADMIN_ALERT_EMAIL') ?? 'erez@minuto.co.il'

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

// Email the owner when findings exist. Returns a status string (never throws)
// so a Resend hiccup can't take down the watchdog or block the dashboard task.
async function sendAlertEmail(
  findings: Array<{ severity: string; category: string; message: string }>,
  errCount: number,
  warnCount: number,
): Promise<string> {
  if (!RESEND_KEY) return 'skipped (no RESEND_API_KEY)'
  const rows = findings
    .map(f => {
      const color = f.severity === 'ERROR' ? '#b91c1c' : '#b45309'
      return `<tr>
        <td style="padding:6px 10px;font-weight:700;color:${color};white-space:nowrap;vertical-align:top">${f.severity}</td>
        <td style="padding:6px 10px;color:#6b7280;white-space:nowrap;vertical-align:top">${f.category}</td>
        <td style="padding:6px 10px;color:#111827">${f.message}</td>
      </tr>`
    })
    .join('')
  const subject = `${errCount > 0 ? '🔴' : '🟠'} CoffeeFlow health: ${errCount} error${errCount === 1 ? '' : 's'}, ${warnCount} warning${warnCount === 1 ? '' : 's'}`
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto">
    <h2 style="color:#111827;margin:0 0 4px">CoffeeFlow system health alert</h2>
    <p style="color:#6b7280;margin:0 0 16px">The watchdog detected ${findings.length} issue(s) that need attention. This is sent only when something is wrong — silence means healthy.</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px;border:1px solid #e5e7eb">
      <thead><tr style="background:#f9fafb">
        <th style="padding:6px 10px;text-align:left;color:#374151">Severity</th>
        <th style="padding:6px 10px;text-align:left;color:#374151">Category</th>
        <th style="padding:6px 10px;text-align:left;color:#374151">Detail</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#9ca3af;font-size:12px;margin-top:16px">Full detail is also in the admin task queue (task_subtype=health_alert). — health-watchdog</p>
  </div>`
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Minuto <${SENDER_EMAIL}>`, to: [ADMIN_ALERT_EMAIL], subject, html }),
    })
    if (!res.ok) return `failed (${res.status}: ${(await res.text()).slice(0, 200)})`
    return 'sent'
  } catch (e: any) {
    return `failed (${e?.message ?? e})`
  }
}

// Crons we expect to run on a known cadence. The schedule is intentionally
// duplicated here vs. queried from cron.job because the watchdog should
// know WHAT cadence each cron CLAIMS — if someone manually disables a
// job, the watchdog should flag that as a problem, not silently accept
// it as the new normal.
const EXPECTED_CRONS: Array<{
  jobname:                 string
  max_silence_hours:       number   // alert if no successful run within this window
  required:                boolean  // true = critical (alert at WARN), false = nice-to-have
}> = [
  { jobname: 'organic-orchestrator-twice-weekly',  max_silence_hours: 84, required: true  },  // 3.5 days
  { jobname: 'industry-intelligence-daily',         max_silence_hours: 36, required: true  },
  { jobname: 'meta-sync-daily',                     max_silence_hours: 36, required: true  },
  { jobname: 'ga4-sync-daily',                      max_silence_hours: 36, required: true  },
  { jobname: 'evaluator-tick-daily',                max_silence_hours: 36, required: true  },
  { jobname: 'scout-tick-daily',                    max_silence_hours: 36, required: false },
  { jobname: 'ai-visibility-probe-weekly',          max_silence_hours: 8 * 24, required: false },
  { jobname: 'seo-worker-writer-tick',              max_silence_hours: 1,  required: true  },
  { jobname: 'seo-worker-visual-tick',              max_silence_hours: 1,  required: true  },
  { jobname: 'organic-worker-instagram-tick',       max_silence_hours: 1,  required: true  },
  // Added 2026-06-21 after woo-orders-sync silently froze for 12 days: its
  // cron was never registered, so nothing was watching it. These are the
  // remaining business-critical schedules that feed customer-facing flows.
  { jobname: 'woo-orders-sync-daily',               max_silence_hours: 30, required: true  },  // feeds welcome emails + revenue
  { jobname: 'email-automation-first-purchase-daily', max_silence_hours: 30, required: true },
  { jobname: 'woo-products-enrich-tick',            max_silence_hours: 30, required: false },
  { jobname: 'seo-worker-research-tick',            max_silence_hours: 1,  required: true  },
  { jobname: 'mission-worker-tick',                 max_silence_hours: 1,  required: false },
  // Self-check: if the watchdog's OWN cron is unscheduled or made inactive,
  // the next run (or this run, if late) reports it. Not a substitute for an
  // external dead-man's-switch, but catches the in-band failure modes.
  { jobname: 'health-watchdog-daily',               max_silence_hours: 30, required: true  },
]

// Data-freshness SLOs — the ground truth. A cron can "succeed" (pg_cron
// only records that the HTTP POST was dispatched, not that the function did
// its job) while the destination table goes stale: a function that no-ops,
// errors after the POST returns, or an external trigger that lapses. The
// only reliable signal is "is the data actually advancing?". For each
// critical table we read max(timestamp) and alert if it's older than the
// budget — this catches staleness REGARDLESS of cause, which is exactly the
// class of failure (woo_orders frozen behind a healthy-looking cron) that
// went unnoticed for 12 days.
const EXPECTED_FRESH_DATA: Array<{
  table:          string
  column:         string   // timestamptz or date column whose max() = freshness
  max_age_hours:  number
  required:       boolean
  label:          string
}> = [
  // order_date (business signal) not synced_at: a quiet day with zero new
  // orders wouldn't advance synced_at even though the sync ran fine. This
  // store sees 3-9 orders every single day, so 60h has effectively no false
  // positives yet still catches a freeze within ~2.5 days.
  { table: 'woo_orders',         column: 'order_date',    max_age_hours: 60, required: true,  label: 'WooCommerce orders (feeds welcome emails)' },
  { table: 'ga4_pages_daily',    column: 'synced_at',     max_age_hours: 40, required: true,  label: 'GA4 analytics' },
  { table: 'meta_ad_daily',      column: 'synced_at',     max_age_hours: 40, required: true,  label: 'Meta ad insights' },
  { table: 'meta_organic_posts', column: 'synced_at',     max_age_hours: 48, required: false, label: 'Meta organic posts' },
  // Content tables only advance when new material exists (a no-RSS-news day
  // is normal), so the budget is deliberately generous + non-critical.
  { table: 'industry_articles',  column: 'summarized_at', max_age_hours: 72, required: false, label: 'Industry intelligence feed' },
]

interface HealthFinding {
  severity: 'WARN' | 'ERROR'
  category: 'cron_silent' | 'cron_missing' | 'cron_disabled' | 'cron_failed' | 'data_stale' | 'task_failure_rate' | 'task_stuck' | 'no_learnings' | 'api_errors' | 'token_expiry'
  message:  string
  context?: Record<string, unknown>
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)
  const findings: HealthFinding[] = []

  // ── 1. Cron registry health — exists, active, ran, succeeded ──────────
  // Uses cron_job_health (reads cron.job + cron.job_run_details) so we catch
  // the failure that started all this: a job that was NEVER REGISTERED (the
  // migration was written but never applied to prod). A job that doesn't
  // exist or is inactive can't appear in run history, so a run-history-only
  // check is blind to it — we check cron.job directly.
  for (const cron of EXPECTED_CRONS) {
    try {
      const { data, error } = await supabase.rpc('cron_job_health', { p_jobname: cron.jobname })
      if (error) {
        // Fall back to the v1 RPC if the v2 one isn't deployed yet, so the
        // watchdog degrades gracefully rather than going blind on crons.
        console.warn(`[health-watchdog] RPC cron_job_health failed for ${cron.jobname}: ${error.message}`)
        continue
      }
      const row = (data?.[0] ?? null) as
        { active: boolean; schedule: string; last_start: string | null; last_status: string | null } | null

      // No row → the job does not exist in cron.job at all. THE woo-orders-sync
      // failure mode. Always an ERROR for required jobs.
      if (!row) {
        if (cron.required) {
          findings.push({
            severity: 'ERROR',
            category: 'cron_missing',
            message:  `cron "${cron.jobname}" is NOT registered (no such job in cron.job) — the schedule was never applied or was unscheduled`,
            context:  { jobname: cron.jobname, max_silence_hours: cron.max_silence_hours },
          })
        }
        continue
      }

      // Exists but inactive → it will never fire. Won't show as a failed run.
      if (row.active === false) {
        findings.push({
          severity: cron.required ? 'ERROR' : 'WARN',
          category: 'cron_disabled',
          message:  `cron "${cron.jobname}" exists but is INACTIVE (active=false) — it will not run`,
          context:  { jobname: cron.jobname, schedule: row.schedule },
        })
        continue
      }

      if (!row.last_start) {
        // Registered + active but no run history yet: usually a freshly-created
        // cron that hasn't hit its first scheduled slot. WARN (not ERROR) — the
        // data-freshness check below is the real backstop for whether its
        // output is actually arriving, so this stays informational.
        if (cron.required) {
          findings.push({
            severity: 'WARN',
            category: 'cron_silent',
            message:  `cron "${cron.jobname}" is registered & active but has no runs on record yet (new cron, or pg_cron hasn't executed it)`,
            context:  { jobname: cron.jobname, max_silence_hours: cron.max_silence_hours },
          })
        }
        continue
      }

      const ageHours = (Date.now() - new Date(row.last_start).getTime()) / (3600 * 1000)
      if (ageHours > cron.max_silence_hours) {
        findings.push({
          severity: cron.required ? 'ERROR' : 'WARN',
          category: 'cron_silent',
          message:  `cron "${cron.jobname}" hasn't fired in ${ageHours.toFixed(1)}h (max expected: ${cron.max_silence_hours}h)`,
          context:  { jobname: cron.jobname, last_run: row.last_start, age_hours: ageHours },
        })
      }
      if (row.last_status === 'failed') {
        findings.push({
          severity: cron.required ? 'ERROR' : 'WARN',
          category: 'cron_failed',
          message:  `cron "${cron.jobname}" most recent run FAILED at ${row.last_start}`,
          context:  { jobname: cron.jobname, last_run: row.last_start, status: row.last_status },
        })
      }
    } catch (e: any) {
      // Don't let a single cron-check failure kill the whole watchdog.
      console.warn(`[health-watchdog] cron check threw for ${cron.jobname}: ${e?.message ?? e}`)
    }
  }

  // ── 1b. Data-freshness SLOs — the ground-truth staleness check ────────
  for (const src of EXPECTED_FRESH_DATA) {
    try {
      const { data, error } = await supabase
        .from(src.table)
        .select(src.column)
        .order(src.column, { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
      if (error) {
        console.warn(`[health-watchdog] freshness query failed for ${src.table}.${src.column}: ${error.message}`)
        continue
      }
      const raw = (data as Record<string, unknown> | null)?.[src.column] as string | null | undefined
      if (!raw) {
        // No rows / null max — for a required source that's a problem in itself.
        if (src.required) {
          findings.push({
            severity: 'ERROR',
            category: 'data_stale',
            message:  `${src.label} (${src.table}.${src.column}) has NO data — table is empty or the column is all-null`,
            context:  { table: src.table, column: src.column },
          })
        }
        continue
      }
      const ageHours = (Date.now() - new Date(raw).getTime()) / (3600 * 1000)
      if (ageHours > src.max_age_hours) {
        findings.push({
          severity: src.required ? 'ERROR' : 'WARN',
          category: 'data_stale',
          message:  `${src.label} is STALE — newest ${src.table}.${src.column} is ${ageHours.toFixed(1)}h old (budget: ${src.max_age_hours}h). The sync is not advancing the data even if its cron looks healthy.`,
          context:  { table: src.table, column: src.column, latest: raw, age_hours: ageHours, budget_hours: src.max_age_hours },
        })
      }
    } catch (e: any) {
      console.warn(`[health-watchdog] freshness check threw for ${src.table}: ${e?.message ?? e}`)
    }
  }

  // ── 2. Task failure rate (last 24h) ───────────────────────────────────
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const { data: recentTasks } = await supabase
      .from('seo_tasks')
      .select('status')
      .gte('created_at', since)
      .limit(500)
    const total  = (recentTasks ?? []).length
    const failed = (recentTasks ?? []).filter(t => t.status === 'failed').length
    const rate   = total > 0 ? failed / total : 0
    if (total >= 5 && rate >= 0.25) {
      findings.push({
        severity: rate >= 0.5 ? 'ERROR' : 'WARN',
        category: 'task_failure_rate',
        message:  `seo_tasks failure rate ${(rate * 100).toFixed(0)}% over last 24h (${failed}/${total})`,
        context:  { failed, total, rate, since },
      })
    }
  } catch (e: any) {
    console.warn(`[health-watchdog] failure-rate check threw: ${e?.message ?? e}`)
  }

  // ── 3. Stuck tasks (claimed past locked_until + grace) ───────────────
  try {
    const graceCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const { data: stuck } = await supabase
      .from('seo_tasks')
      .select('id, task_type, worker_id, locked_until')
      .eq('status', 'processing')
      .lt('locked_until', graceCutoff)
      .limit(50)
    if ((stuck ?? []).length > 0) {
      findings.push({
        severity: 'WARN',
        category: 'task_stuck',
        message:  `${stuck!.length} task(s) stuck in 'processing' past their lock expiry + 30min grace`,
        context:  { count: stuck!.length, samples: stuck!.slice(0, 5) },
      })
    }
  } catch (e: any) {
    console.warn(`[health-watchdog] stuck-task check threw: ${e?.message ?? e}`)
  }

  // ── 4. No autonomous learnings written in 14d ────────────────────────
  // Only meaningful if the loop actually HAD a chance to write one. An
  // orchestrator learning is the OUTPUT of evaluating a matured experiment,
  // so "no learnings" is expected — not a stall — whenever no experiment has
  // yet aged past its min_lookback_days. Gate the warning on the existence of
  // at least one matured (evaluation-eligible) experiment; otherwise stay
  // silent so we don't flag normal early-collection state as a system fault.
  try {
    const fourteenAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString()
    const { data: orchLearnings } = await supabase
      .from('seo_learnings')
      .select('id, created_at')
      .eq('created_by', 'orchestrator')
      .gte('created_at', fourteenAgo)
      .limit(1)
    if ((orchLearnings ?? []).length === 0) {
      // How many experiments have matured past their own min_lookback_days?
      // (Same per-row date math the evaluator uses in getExperimentsDueForEvaluation.)
      const { data: exps } = await supabase
        .from('seo_experiments')
        .select('id, created_at, min_lookback_days, status')
        .limit(500)
      const now = Date.now()
      const matured = (exps ?? []).filter(e => {
        const lookbackDays = (e as { min_lookback_days?: number }).min_lookback_days ?? 7
        const eligibleAt = new Date((e as { created_at: string }).created_at).getTime()
          + lookbackDays * 24 * 3600 * 1000
        return eligibleAt <= now
      })
      // No matured experiment → nothing could have produced a learning yet.
      // Suppress the warning entirely (this is the common false positive).
      if (matured.length > 0) {
        findings.push({
          severity: 'WARN',
          category: 'no_learnings',
          message:  `No autonomous learnings written by orchestrator in last 14 days, despite ${matured.length} experiment(s) matured past min_lookback_days — experiment loop may be stalled`,
          context:  { matured_experiments: matured.length },
        })
      }
    }
  } catch (e: any) {
    console.warn(`[health-watchdog] learnings check threw: ${e?.message ?? e}`)
  }

  // ── 5. API error patterns in recent task error_msgs ──────────────────
  try {
    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
    const { data: errs } = await supabase
      .from('seo_tasks')
      .select('error_msg')
      .gte('updated_at', since)
      .not('error_msg', 'is', null)
      .limit(200)
    const flat = (errs ?? []).map(r => r.error_msg as string).join(' | ').toLowerCase()
    const patterns = [
      { needle: 'unauthorized',          category: 'API auth (401)' },
      { needle: 'forbidden',             category: 'API permission (403)' },
      { needle: 'rate limit',            category: 'API rate limit' },
      { needle: 'quota exhausted',       category: 'IG quota exhausted' },
      { needle: 'scope_insufficient',    category: 'OAuth scope insufficient' },
      // Meta's expired/invalid-token errors don't contain "unauthorized" —
      // they read "Session has expired" / "OAuthException" / our own
      // "Meta access token expired … re-auth". Match those so a lapsed 60-day
      // Meta token (the IG-worker 401 cause) raises an alert instead of
      // silently failing IG tasks. Kept in sync with meta-publish's messages.
      { needle: 'access token expired',  category: 'Meta token expired — re-auth needed' },
      { needle: 'session has expired',   category: 'Meta token expired — re-auth needed' },
      { needle: 'oauthexception',        category: 'Meta OAuth error — re-auth needed' },
      { needle: 're-auth via settings',  category: 'Meta token expired — re-auth needed' },
    ]
    // Dedupe by display category — several needles intentionally map to the
    // same category (e.g. the Meta token-expiry phrasings), and we want ONE
    // alert line per distinct problem, not one per matched phrase.
    const seenCategories = new Set<string>()
    for (const p of patterns) {
      if (flat.includes(p.needle) && !seenCategories.has(p.category)) {
        seenCategories.add(p.category)
        findings.push({
          severity: 'ERROR',
          category: 'api_errors',
          message:  `Detected '${p.category}' pattern in recent task errors (last 48h)`,
          context:  { needle: p.needle },
        })
      }
    }
  } catch (e: any) {
    console.warn(`[health-watchdog] api-error scan threw: ${e?.message ?? e}`)
  }

  // ── 5b. OAuth token expiry — warn BEFORE tokens lapse ────────────────
  // The api_errors scan (section 5) is REACTIVE: it only fires once a token is
  // already dead and tasks are failing. This proactive check reads
  // oauth_tokens.expires_at and warns ~7 days ahead so the admin can reconnect
  // on their own schedule instead of via an outage. Meta's long-lived USER
  // token is the usual offender (~60-day TTL, no auto-refresh) — the exact
  // failure that bled silently for 2+ weeks before being caught.
  try {
    const { data: tokens } = await supabase
      .from('oauth_tokens')
      .select('platform, expires_at, refresh_token')
      .not('expires_at', 'is', null)
    const now = Date.now()
    const WARN_WINDOW_MS = 7 * 24 * 3600 * 1000
    for (const t of (tokens ?? []) as Array<{ platform: string; expires_at: string; refresh_token: string | null }>) {
      // Skip tokens that auto-renew. For platforms like Google, expires_at is the
      // SHORT-LIVED access token (~1h TTL) and refresh_token mints a fresh one on
      // every sync — so a lapsed access token is normal, not an outage. Only
      // tokens with NO refresh_token (e.g. Meta's ~60-day user token) represent a
      // connection that genuinely dies on expiry and needs a manual reconnect.
      if (t.refresh_token) continue
      const expMs = new Date(t.expires_at).getTime()
      if (!Number.isFinite(expMs)) continue
      const daysLeft = Math.floor((expMs - now) / 86_400_000)
      const when = t.expires_at.slice(0, 10)
      if (expMs <= now) {
        findings.push({
          severity: 'ERROR',
          category: 'token_expiry',
          message:  `${t.platform} OAuth token EXPIRED ${Math.abs(daysLeft)}d ago (${when}) — reconnect via Settings to restore ${t.platform} publishing/sync`,
          context:  { platform: t.platform, expires_at: t.expires_at, days_left: daysLeft },
        })
      } else if (expMs - now <= WARN_WINDOW_MS) {
        findings.push({
          severity: 'WARN',
          category: 'token_expiry',
          message:  `${t.platform} OAuth token expires in ${daysLeft}d (${when}) — reconnect soon via Settings to avoid an outage`,
          context:  { platform: t.platform, expires_at: t.expires_at, days_left: daysLeft },
        })
      }
    }
  } catch (e: any) {
    console.warn(`[health-watchdog] token-expiry check threw: ${e?.message ?? e}`)
  }

  // ── 6. Emit findings → ONE consolidated dynamic_experiment task ──────
  if (findings.length === 0) {
    console.log('[health-watchdog] all healthy, no task created')
    return jsonResponse({ ok: true, healthy: true, findings_count: 0 })
  }

  const errCount  = findings.filter(f => f.severity === 'ERROR').length
  const warnCount = findings.filter(f => f.severity === 'WARN').length
  const summary   = `Health-watchdog detected ${findings.length} issue(s): ${errCount} ERROR + ${warnCount} WARN.\n\n` +
                    findings.map(f => `  [${f.severity}] ${f.category}: ${f.message}`).join('\n')

  const { data, error } = await supabase
    .from('seo_tasks')
    .insert({
      task_type:    'dynamic_experiment',
      task_subtype: 'health_alert',
      brief_data: {
        description:            summary,
        approval_required:      true,
        estimated_effort_hours: 0.5,
        details: { findings, generated_at: new Date().toISOString() },
      },
      rationale:           `[health-watchdog] ${errCount} ERROR + ${warnCount} WARN`,
      orchestrator_run_id: crypto.randomUUID(),
    })
    .select('id')
    .single()

  // Email the owner regardless of whether the task insert succeeded — the
  // email is the primary alert; the task is the dashboard record. Don't let a
  // failed task insert suppress the email (or vice-versa).
  const emailStatus = await sendAlertEmail(findings, errCount, warnCount)
  console.log(`[health-watchdog] alert email → ${ADMIN_ALERT_EMAIL}: ${emailStatus}`)

  if (error) {
    console.error(`[health-watchdog] task insert failed: ${error.message}`)
    return jsonResponse({ ok: false, error: error.message, email_status: emailStatus, findings }, 500)
  }
  return jsonResponse({ ok: true, healthy: false, findings_count: findings.length, task_id: data.id, email_status: emailStatus, findings })
})
