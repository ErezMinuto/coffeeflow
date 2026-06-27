// Minuto Strategist Brain — Phase 3: thesis evaluator (the loop close).
//
// On a thesis's check_date, grades it against the REVENUE north-star: did moving
// the driver actually move money? Writes the verdict + outcome back to
// strategic_theses, so the next brain run reads what its prior bets really did
// and pivots. This is the "I grew the audience, sales didn't follow, I was wrong"
// capability — the difference between an agent that learns and one that doesn't.
//
// One Opus grade per due thesis (no ReAct loop — a single bounded judgment),
// against a freshly-assembled current snapshot. Cron-polled daily; idle + cheap
// when nothing is due.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createSupabase, logClaudeCost, appendChatMessage } from '../seo-agent/db.ts'
import { callClaude, parseClaudeJson } from '../seo-agent/claude.ts'
import { THESIS_EVALUATOR_SYSTEM_PROMPT } from '../seo-agent/prompts/thesisEvaluator.ts'
import { assembleBusinessSnapshot } from '../seo-agent/services/businessSnapshot.ts'
import { STRATEGIST_MODEL, STRATEGIST_EFFORT, estimateUsd } from '../seo-agent/strategistConfig.ts'
import { sendOwnerEmail } from '../_shared/email.ts'
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const DASHBOARD_URL = Deno.env.get('DASHBOARD_URL') ?? 'https://coffeeflow-neon.vercel.app'
const BATCH = 5                       // theses graded per invocation
const RECHECK_DAYS = 14               // push inconclusive theses out this far to re-judge later

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

interface ThesisRow {
  id: string
  thesis: string
  lever: string
  success_metric: string
  metric_baseline: number | null
  check_date: string | null
  evidence_snapshot: Record<string, unknown>
  created_at: string
}

interface Verdict {
  verdict: 'validated' | 'refuted' | 'inconclusive'
  revenue_followed: boolean
  outcome: string
  confidence: 'low' | 'medium' | 'high'
  data_gap: string | null
}

function isoToday(): string { return new Date().toISOString().split('T')[0] }

async function gradeThesis(snapshotJson: string, t: ThesisRow): Promise<{ verdict: Verdict; cost: { i: number; o: number; cr: number; cc: number; model: string } }> {
  const userMsg =
    `Grade this thesis now. It is at (or past) its check_date.\n\n` +
    `THESIS: ${t.thesis}\n` +
    `LEVER: ${t.lever}\n` +
    `SUCCESS METRIC (the driver): ${t.success_metric}\n` +
    `BASELINE at creation: ${t.metric_baseline ?? '(not recorded)'}\n` +
    `RECORDED ON: ${t.created_at}\n` +
    `CHECK DATE: ${t.check_date}\n` +
    `EVIDENCE SNAPSHOT captured when it was recorded (the THEN state):\n${JSON.stringify(t.evidence_snapshot ?? {})}\n\n` +
    `Compare THEN vs the CURRENT business snapshot in your system context, and return the JSON verdict.`

  const res = await callClaude({
    model:     STRATEGIST_MODEL,
    system:    THESIS_EVALUATOR_SYSTEM_PROMPT + '\n\n═══ CURRENT BUSINESS SNAPSHOT (revenue-first) ═══\n' + snapshotJson,
    messages:  [{ role: 'user', content: userMsg }],
    effort:    STRATEGIST_EFFORT,
    maxTokens: 4000,
    timeoutMs: 120_000,
  })
  const verdict = parseClaudeJson<Verdict>(res.text)
  return { verdict, cost: { i: res.inputTokens, o: res.outputTokens, cr: res.cacheReadTokens, cc: res.cacheCreationTokens, model: res.model } }
}

async function evaluate(supabase: SupabaseClient): Promise<Response> {
  const today = isoToday()
  const { data, error } = await supabase
    .from('strategic_theses')
    .select('id, thesis, lever, success_metric, metric_baseline, check_date, evidence_snapshot, created_at')
    .eq('status', 'active')
    .not('check_date', 'is', null)
    .lte('check_date', today)
    .order('check_date', { ascending: true })
    .limit(BATCH)
  if (error) return json({ ok: false, error: `due-theses select failed: ${error.message}` }, 500)
  const due = (data ?? []) as ThesisRow[]
  if (due.length === 0) return json({ ok: true, idle: 'no theses due for evaluation' })

  // One current snapshot, reused to grade every due thesis this run.
  let snapshotJson: string
  try { snapshotJson = JSON.stringify(await assembleBusinessSnapshot(supabase)) }
  catch (e) { return json({ ok: false, error: `snapshot failed: ${e instanceof Error ? e.message : String(e)}` }, 500) }

  const resolved: Array<{ thesis: string; verdict: string; outcome: string }> = []
  const results: Array<Record<string, unknown>> = []

  for (const t of due) {
    try {
      const { verdict: v, cost } = await gradeThesis(snapshotJson, t)
      await logClaudeCost(supabase, { sourceFn: 'strategist-evaluator', model: cost.model, inputTokens: cost.i, outputTokens: cost.o, cacheReadTokens: cost.cr, cacheCreationTokens: cost.cc })

      if (v.verdict === 'validated' || v.verdict === 'refuted') {
        await supabase
          .from('strategic_theses')
          .update({ status: v.verdict, outcome: v.outcome, updated_at: new Date().toISOString() })
          .eq('id', t.id)
          .eq('status', 'active')   // optimistic: don't double-resolve
        resolved.push({ thesis: t.thesis, verdict: v.verdict, outcome: v.outcome })
      } else {
        // inconclusive → keep active, push the check out, record why (the data gap).
        const next = new Date(Date.now() + RECHECK_DAYS * 24 * 3600 * 1000).toISOString().split('T')[0]
        await supabase
          .from('strategic_theses')
          .update({ check_date: next, outcome: `inconclusive (${v.confidence}) — ${v.data_gap ?? v.outcome}; re-check ${next}`, updated_at: new Date().toISOString() })
          .eq('id', t.id)
          .eq('status', 'active')
      }
      results.push({ id: t.id, verdict: v.verdict, est_usd: estimateUsd({ model: cost.model, inputTokens: cost.i, outputTokens: cost.o, cacheReadTokens: cost.cr, cacheCreationTokens: cost.cc }) })
    } catch (e) {
      results.push({ id: t.id, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // Notify the owner about resolved theses (best-effort).
  if (resolved.length > 0) {
    const rows = resolved.map(r => {
      const color = r.verdict === 'validated' ? '#15803d' : '#b91c1c'
      return `<li style="margin:0 0 10px"><b style="color:${color};text-transform:uppercase;font-size:12px">${r.verdict}</b><br><span style="color:#111827">${r.thesis}</span><br><span style="color:#6b7280;font-size:13px">${r.outcome}</span></li>`
    }).join('')
    const validatedN = resolved.filter(r => r.verdict === 'validated').length
    await sendOwnerEmail({
      subject: `📊 Strategist scored ${resolved.length} thesis${resolved.length === 1 ? '' : 'es'} (${validatedN} validated)`,
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#111827">
        <h2 style="margin:0 0 4px">📊 Theses scored against revenue</h2>
        <p style="color:#6b7280;margin:0 0 16px">The strategist checked its past bets against what sales actually did. A "refuted" here is the system working — it caught a belief that didn't pay off.</p>
        <ul style="padding-left:18px;margin:0">${rows}</ul>
        <p style="margin-top:18px"><a href="${DASHBOARD_URL}/admin/seo-agent" style="display:inline-block;background:#6A7D45;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Open the dashboard →</a></p>
      </div>`,
    }).catch(() => {})
    try {
      await appendChatMessage(supabase, {
        session_id: 'strategist-brain',
        role: 'assistant',
        content: `**Theses scored against revenue (${today})**\n\n` + resolved.map(r => `- **${r.verdict}** — ${r.thesis}\n  ${r.outcome}`).join('\n'),
        metadata: { kind: 'thesis_evaluation', count: resolved.length },
      })
    } catch { /* non-critical */ }
  }

  return json({ ok: true, evaluated: due.length, resolved: resolved.length, results })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const supabase = createSupabase()
  try {
    return await evaluate(supabase)
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
