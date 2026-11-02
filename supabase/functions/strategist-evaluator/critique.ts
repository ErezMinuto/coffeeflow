// Strategist closed loop: the draft critic (action=critique_draft).
//
// Picks up recommendations in 'awaiting_critique', grades the draft in
// artifact_snapshot against the brief + brand rules, and moves the row:
//   pass → exporting (the executor exports it)
//   reject, revisions left → revising (the executor re-drafts with feedback)
//   reject, none left → needs_human (nothing is exported)
//
// Deterministic brand checks run first and count like critic issues. The LLM is
// a Gemini model (MODEL_CRITIC slot), a different family from the Claude
// drafters. This file never publishes, sends or creates anything.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { callClaude, parseClaudeJson } from '../seo-agent/claude.ts'
import { DRAFT_CRITIC_SYSTEM_PROMPT, DRAFT_CRITIC_RESPONSE_SCHEMA } from '../seo-agent/prompts/draftCritic.ts'
import { fetchMinutoCoffeeCatalog } from '../seo-agent/services/cmsApi.ts'
import type { RecommendationRow } from '../seo-agent/types.ts'
import {
  deterministicIssues, feedbackForDrafter, nextStateAfterCritique, normaliseVerdict, passes,
  readLoopConfig, type Verdict,
} from '../_shared/strategist_loop.ts'
import { fetchActivePaidCampaigns } from '../seo-agent/services/paidCampaigns.ts'
import { claimLoopRows, finishLoopRow, MAX_CRITIQUE_ATTEMPTS, sweepStaleLoop } from '../_shared/strategist_loop_ledger.ts'

// Verified against GET /v1beta/models on 2026-11-02 (used for the plan review).
// Thinking-only model: maxTokens must leave room for thinking + the JSON.
export const MODEL_CRITIC = Deno.env.get('MODEL_CRITIC')?.trim() || 'gemini-3.1-pro-preview'
const BATCH = 2   // ~30-90 s per Gemini Pro call; the cron timeout is 150 s

/** Catalog lines for the products the draft names, so the critic can check facts. */
function catalogFacts(catalog: Array<{ name: string; price?: unknown; stock_status?: unknown; permalink?: unknown }>, draftText: string): string {
  const hits = catalog.filter(p => p.name && draftText.includes(p.name))
  const lines = (hits.length ? hits : catalog.slice(0, 40)).map(p => `- ${p.name} | price ₪${p.price ?? '?'} | ${p.stock_status ?? '?'} | ${p.permalink ?? ''}`)
  return (hits.length ? 'Products named in the draft:\n' : 'No catalog product is named verbatim in the draft. Current Minuto coffee catalog:\n') + lines.join('\n')
}

export async function buildCritiqueMessage(supabase: SupabaseClient, rec: RecommendationRow, extraContext = ''): Promise<string> {
  const snapshot = rec.artifact_snapshot ?? {}
  const draftJson = JSON.stringify(snapshot, null, 2)
  let facts = '(catalog unavailable: treat every product attribute in the draft as unverified)'
  try { facts = catalogFacts(await fetchMinutoCoffeeCatalog(supabase), draftJson) } catch { /* keep the fallback */ }
  return [
    `ACTION TYPE: ${rec.action_type}`,
    `REVISION: ${rec.revision_count ?? 0} (0 = first draft)`,
    '',
    '=== STRATEGIST BRIEF ===',
    `Title: ${rec.title}`,
    `Rationale: ${rec.rationale ?? ''}`,
    `Action params: ${JSON.stringify(rec.action_params ?? {})}`,
    `Success metric: ${JSON.stringify(rec.success_metric ?? {})}`,
    '',
    '=== CATALOG FACTS (the only allowed source of product attributes) ===',
    facts,
    extraContext ? `\n${extraContext}` : '',
    '',
    '=== DRAFT ===',
    draftJson.slice(0, 60_000),
  ].join('\n')
}

/** Paid ads are judged against what is already running (overlap, duplicates). */
async function adContext(supabase: SupabaseClient, actionType: string): Promise<string> {
  if (!actionType.startsWith('ad_')) return ''
  try {
    return `=== ACTIVE CAMPAIGNS (synced, last 30 days) ===\n${JSON.stringify(await fetchActivePaidCampaigns(supabase))}`
  } catch (e) {
    // Without this the critic cannot check overlap: say so, so it rejects on missing context.
    return `=== ACTIVE CAMPAIGNS ===\nUNAVAILABLE (${e instanceof Error ? e.message : String(e)}). You cannot verify overlap with running campaigns: raise a high issue "active_campaigns_unavailable".`
  }
}

async function critiqueOne(supabase: SupabaseClient, rec: RecommendationRow, workerId: string): Promise<Record<string, unknown>> {
  // The claim already counted this attempt. A critic that keeps failing (API
  // down, output always unreadable) hands the draft to Erez instead of looping.
  if ((rec.critique_attempts ?? 0) > MAX_CRITIQUE_ATTEMPTS) {
    const err = await finishLoopRow(supabase, rec.id, workerId, 'awaiting_critique', {
      status: 'needs_human', worker_id: null,
      draft_error: `critic failed ${MAX_CRITIQUE_ATTEMPTS} times; nothing was exported`,
    })
    return { id: rec.id, status: err ? 'unrecorded' : 'needs_human', error: err ?? undefined }
  }
  const cfg = await readLoopConfig(supabase)
  const snapshot = rec.artifact_snapshot
  let verdict: Verdict
  let model = MODEL_CRITIC
  if (!snapshot || typeof snapshot !== 'object') {
    verdict = { pass: false, issues: [{ severity: 'critical', rule: 'no_draft', detail: 'nothing to review: artifact_snapshot is empty' }], feedback: 'Produce the draft again.' }
  } else {
    const det = deterministicIssues(rec.action_type, snapshot)
    let llm: Verdict
    try {
      const res = await callClaude({
        sourceFn:       'strategist-evaluator',
        runId:          rec.run_id,
        model:          MODEL_CRITIC,
        system:         DRAFT_CRITIC_SYSTEM_PROMPT,
        messages:       [{ role: 'user', content: await buildCritiqueMessage(supabase, rec, await adContext(supabase, rec.action_type)) }],
        maxTokens:      16_000,
        temperature:    0.2,
        timeoutMs:      120_000,
        responseSchema: DRAFT_CRITIC_RESPONSE_SCHEMA,
      })
      model = res.model
      let parsed: unknown = null
      try { parsed = parseClaudeJson(res.text) } catch { /* normaliseVerdict(null) is a reject */ }
      llm = normaliseVerdict(parsed)
    } catch (e) {
      // A failed call is not a verdict. Release the row so the next tick
      // retries; the sweep hands it to Erez after MAX_CRITIQUE_ATTEMPTS.
      const msg = e instanceof Error ? e.message : String(e)
      await finishLoopRow(supabase, rec.id, workerId, 'awaiting_critique', { worker_id: null, draft_error: `critic call failed: ${msg.slice(0, 500)}` })
      return { id: rec.id, status: 'retry', error: msg }
    }
    verdict = { pass: llm.pass, issues: [...det, ...llm.issues], feedback: llm.feedback }
  }

  const revision = rec.revision_count ?? 0
  const next = nextStateAfterCritique(verdict, revision, cfg.max_revisions)
  const entry = { at: new Date().toISOString(), revision, pass: passes(verdict), issues: verdict.issues, feedback: verdict.feedback, model }
  const patch: Record<string, unknown> = {
    status: next,
    critique_log: [...(Array.isArray(rec.critique_log) ? rec.critique_log : []), entry],
    worker_id: null,
    draft_error: next === 'needs_human' ? `rejected after ${revision} revision(s); nothing was exported` : null,
  }
  if (next === 'revising') {
    patch.last_feedback = feedbackForDrafter(verdict)
    patch.revision_count = revision + 1
    patch.critique_attempts = 0
  }
  const notMoved = await finishLoopRow(supabase, rec.id, workerId, 'awaiting_critique', patch)
  if (notMoved) return { id: rec.id, status: 'unrecorded', error: notMoved }
  return { id: rec.id, status: next, issues: verdict.issues.length }
}

export async function critiqueDrafts(supabase: SupabaseClient): Promise<Record<string, unknown>> {
  const workerId = `critic-${crypto.randomUUID().slice(0, 8)}`
  const swept = await sweepStaleLoop(supabase)
  const recs = await claimLoopRows(supabase, 'awaiting_critique', workerId, BATCH)
  if (recs.length === 0) return { ok: true, idle: 'no drafts awaiting critique', swept_stale: swept || undefined }
  const results = []
  for (const rec of recs) results.push(await critiqueOne(supabase, rec, workerId))
  return { ok: true, critiqued: results.length, swept_stale: swept || undefined, results }
}
