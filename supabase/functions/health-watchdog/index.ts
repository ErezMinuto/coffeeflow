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
]

interface HealthFinding {
  severity: 'WARN' | 'ERROR'
  category: 'cron_silent' | 'cron_failed' | 'task_failure_rate' | 'task_stuck' | 'no_learnings' | 'api_errors'
  message:  string
  context?: Record<string, unknown>
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST')    return jsonResponse({ error: 'POST only' }, 405)

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)
  const findings: HealthFinding[] = []

  // ── 1. Cron silence / failure detection ───────────────────────────────
  for (const cron of EXPECTED_CRONS) {
    try {
      const { data, error } = await supabase.rpc('cron_last_run_for_job', { p_jobname: cron.jobname })
      if (error) {
        console.warn(`[health-watchdog] RPC cron_last_run_for_job failed for ${cron.jobname}: ${error.message}`)
        continue
      }
      const lastRun = (data?.[0] ?? null) as { start_time: string; status: string } | null

      if (!lastRun) {
        if (cron.required) {
          findings.push({
            severity: 'ERROR',
            category: 'cron_silent',
            message:  `cron "${cron.jobname}" has NO runs on record`,
            context:  { jobname: cron.jobname, max_silence_hours: cron.max_silence_hours },
          })
        }
        continue
      }
      const ageHours = (Date.now() - new Date(lastRun.start_time).getTime()) / (3600 * 1000)
      if (ageHours > cron.max_silence_hours) {
        findings.push({
          severity: cron.required ? 'ERROR' : 'WARN',
          category: 'cron_silent',
          message:  `cron "${cron.jobname}" hasn't fired in ${ageHours.toFixed(1)}h (max expected: ${cron.max_silence_hours}h)`,
          context:  { jobname: cron.jobname, last_run: lastRun.start_time, age_hours: ageHours },
        })
      }
      if (lastRun.status === 'failed') {
        findings.push({
          severity: cron.required ? 'ERROR' : 'WARN',
          category: 'cron_failed',
          message:  `cron "${cron.jobname}" most recent run FAILED at ${lastRun.start_time}`,
          context:  { jobname: cron.jobname, last_run: lastRun.start_time, status: lastRun.status },
        })
      }
    } catch (e: any) {
      // Don't let a single cron-check failure kill the whole watchdog.
      console.warn(`[health-watchdog] cron check threw for ${cron.jobname}: ${e?.message ?? e}`)
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
  try {
    const fourteenAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString()
    const { data: orchLearnings } = await supabase
      .from('seo_learnings')
      .select('id, created_at')
      .eq('created_by', 'orchestrator')
      .gte('created_at', fourteenAgo)
      .limit(1)
    if ((orchLearnings ?? []).length === 0) {
      // Only WARN — could just mean experiments haven't matured yet.
      findings.push({
        severity: 'WARN',
        category: 'no_learnings',
        message:  'No autonomous learnings written by orchestrator in last 14 days — experiment loop may be stalled, or experiments not maturing past min_lookback_days',
      })
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
      { needle: 'unauthorized',        category: 'API auth (401)' },
      { needle: 'forbidden',           category: 'API permission (403)' },
      { needle: 'rate limit',          category: 'API rate limit' },
      { needle: 'quota exhausted',     category: 'IG quota exhausted' },
      { needle: 'scope_insufficient',  category: 'OAuth scope insufficient' },
    ]
    for (const p of patterns) {
      if (flat.includes(p.needle)) {
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

  if (error) {
    console.error(`[health-watchdog] task insert failed: ${error.message}`)
    return jsonResponse({ ok: false, error: error.message, findings }, 500)
  }
  return jsonResponse({ ok: true, healthy: false, findings_count: findings.length, task_id: data.id, findings })
})
