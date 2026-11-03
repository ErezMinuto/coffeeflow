// Strategist closed loop: shared rules for the executor, the critic
// (strategist-evaluator action=critique_draft) and the async drafting workers.
// Plan: docs/plans/2026-11-02-strategist-closed-loop.md, Part A.
//
//   approved → drafting → awaiting_critique ─ pass ─▶ exporting → ready_for_review
//                              │  reject, revisions left ─▶ revising → drafting
//                              └─ reject, none left ─────▶ needs_human (nothing exported)
//
// Everything here is pure or a single fenced UPDATE, so the state rules are
// unit-tested in strategist_loop_test.ts rather than discovered in prod.

import { adCopyBrandViolation, namesResellerBrand } from '../seo-agent/services/brandGuard.ts'

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any }

export type LoopActionType = 'email_campaign' | 'content_blog' | 'content_ig' | 'ad_meta' | 'ad_google'

// Action types whose draft → critique → export path is implemented in code.
// The ops_profile switch can only turn the loop on for a type listed here.
export const LOOP_IMPLEMENTED: ReadonlySet<string> = new Set<LoopActionType>([
  'email_campaign',
  'content_blog',
  'content_ig',
  'ad_meta',
  'ad_google',
])

// An async drafter (writer / IG worker) holds the recommendation in 'drafting'
// while its task runs. Past this the sweep fails the row (the task is stuck).
export const ASYNC_DRAFT_HOURS = 3

export interface LoopConfig {
  critique:                 Partial<Record<LoopActionType, boolean>>
  auto_approve:             Partial<Record<LoopActionType, boolean>>
  max_revisions:            number
  max_auto_approve_per_run: number
}

export const LOOP_OFF: LoopConfig = { critique: {}, auto_approve: {}, max_revisions: 2, max_auto_approve_per_run: 0 }

/** Read the switches. A missing key, a failed read or a malformed value all
 *  mean "loop off", so code that ships before its migration behaves as today. */
export async function readLoopConfig(supabase: Db): Promise<LoopConfig> {
  try {
    const { data, error } = await supabase.from('ops_profile').select('value').eq('key', 'strategist_loop').maybeSingle()
    if (error || !data?.value || typeof data.value !== 'object') return LOOP_OFF
    const v = data.value as Record<string, unknown>
    const bools = (o: unknown) => {
      const out: Partial<Record<LoopActionType, boolean>> = {}
      if (o && typeof o === 'object') for (const [k, b] of Object.entries(o)) if (b === true) out[k as LoopActionType] = true
      return out
    }
    const maxRev = Number(v.max_revisions)
    const maxAuto = Number(v.max_auto_approve_per_run)
    return {
      critique:                 bools(v.critique),
      auto_approve:             bools(v.auto_approve),
      // Clamp: the plan caps revisions at 2; a typo must not open an endless loop.
      max_revisions:            Number.isFinite(maxRev) ? Math.min(Math.max(Math.trunc(maxRev), 0), 2) : 2,
      max_auto_approve_per_run: Number.isFinite(maxAuto) ? Math.min(Math.max(Math.trunc(maxAuto), 0), 10) : 0,
    }
  } catch {
    return LOOP_OFF
  }
}

export function critiqueOn(cfg: LoopConfig, actionType: string): boolean {
  return LOOP_IMPLEMENTED.has(actionType) && cfg.critique[actionType as LoopActionType] === true
}

/** Auto-approve needs the critic on too: skipping the planning gate is only
 *  acceptable because a critic stands between the draft and Erez. */
export function autoApproveOn(cfg: LoopConfig, actionType: string): boolean {
  return critiqueOn(cfg, actionType) && cfg.auto_approve[actionType as LoopActionType] === true
}

// ── Critic verdicts ──────────────────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low'
export interface CritiqueIssue { severity: Severity; rule: string; detail: string }
export interface Verdict { pass: boolean; issues: CritiqueIssue[]; feedback: string }

const SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high', 'medium', 'low'])

/** Normalise whatever the model returned. Anything unreadable is a reject:
 *  a critic we cannot understand has not approved anything. */
export function normaliseVerdict(raw: unknown): Verdict {
  if (!raw || typeof raw !== 'object') {
    return { pass: false, issues: [{ severity: 'high', rule: 'critic_output', detail: 'critic returned no readable verdict' }], feedback: '' }
  }
  const r = raw as Record<string, unknown>
  const issues: CritiqueIssue[] = Array.isArray(r.issues)
    ? r.issues.flatMap((i): CritiqueIssue[] => {
        if (!i || typeof i !== 'object') return []
        const o = i as Record<string, unknown>
        const sev = String(o.severity ?? '').toLowerCase()
        return [{
          // Unknown severity counts as high: the safe reading of "something is wrong".
          severity: (SEVERITIES.has(sev) ? sev : 'high') as Severity,
          rule:     String(o.rule ?? 'unspecified').slice(0, 80),
          detail:   String(o.detail ?? '').slice(0, 600),
        }]
      })
    : []
  return { pass: r.pass === true, issues, feedback: typeof r.feedback === 'string' ? r.feedback.slice(0, 3000) : '' }
}

/** PASS only if the critic said pass AND no critical/high issue was raised by
 *  either the critic or the deterministic checks. {pass:true, issues:[critical]}
 *  is a contradiction and reads as a reject. */
export function passes(v: Verdict): boolean {
  return v.pass === true && !v.issues.some(i => i.severity === 'critical' || i.severity === 'high')
}

export type NextState = 'exporting' | 'revising' | 'needs_human'

export function nextStateAfterCritique(v: Verdict, revisionCount: number, maxRevisions: number): NextState {
  if (passes(v)) return 'exporting'
  return revisionCount < maxRevisions ? 'revising' : 'needs_human'
}

/** Feedback handed to the drafter: the critic's own words plus every blocking
 *  issue, so a terse critic still tells the drafter what to fix. */
export function feedbackForDrafter(v: Verdict): string {
  const blocking = v.issues.filter(i => i.severity === 'critical' || i.severity === 'high')
  const lines = blocking.map(i => `- [${i.rule}] ${i.detail}`)
  return [v.feedback.trim(), lines.length ? `Must fix:\n${lines.join('\n')}` : ''].filter(Boolean).join('\n\n').slice(0, 3000)
}

// ── Deterministic brand checks (run before the LLM; cannot be argued with) ──

/** Collect every string in a JSON value, skipping keys that are not copy
 *  (URLs, ids, HTML that duplicates the plain-text body). */
export function copyStrings(value: unknown, out: string[] = [], key = ''): string[] {
  // snake_case (DB rows) and camelCase (generate-campaign output) alike.
  if (/^(html_?content|html|url|permalink|id|ids|negative_?keywords?)$|_?url$|Url$|_ids?$|Ids?$/i.test(key)) return out
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) copyStrings(v, out, key)
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) copyStrings(v, out, k)
  return out
}

const RE_EM_DASH = /—|\s–\s/
// Minuto roasts WEEKLY. Catches "קולים כל בוקר", "נקלה מדי יום", "קלוי היום" style claims.
const RE_DAILY_ROAST = /(קול[הים]*|קלוי[הים]*|נקל[הים]*|קלייה|קולה)[^.\n]{0,25}(כל בוקר|כל יום|מדי יום|מדי בוקר|יומי|יומיומ)|(כל בוקר|כל יום|מדי יום|מדי בוקר)[^.\n]{0,25}(קול[הים]*|קלוי[הים]*|נקל[הים]*|קלייה)/
// Brand descriptor is "בית קלייה"; "מקלה" was rejected even as a synonym.
const RE_MAKLA = /(^|[^א-ת])(ה|ב|ל|מ|ו)?מקל[הת](?![א-ת])/
// Retail bag is 330g. A 250g bag claim is a factual error.
const RE_250G = /250\s*(גרם|ג['׳]|g\b|gr\b)/i

export function deterministicIssues(actionType: string, snapshot: unknown): CritiqueIssue[] {
  const issues: CritiqueIssue[] = []
  const text = copyStrings(snapshot).join('\n')
  if (RE_EM_DASH.test(text)) issues.push({ severity: 'high', rule: 'no_em_dash', detail: 'Copy contains an em/en dash. Use a comma instead (Hebrew AI tell).' })
  if (RE_DAILY_ROAST.test(text)) issues.push({ severity: 'high', rule: 'weekly_roasting', detail: 'Copy claims daily roasting. Minuto roasts weekly: "קולים פולים טריים בכל שבוע".' })
  if (RE_MAKLA.test(text)) issues.push({ severity: 'high', rule: 'brand_naming', detail: 'Uses "מקלה". The descriptor is "בית קלייה".' })
  if (RE_250G.test(text)) issues.push({ severity: 'high', rule: 'bag_size_330g', detail: 'Mentions a 250g bag. The retail bag is 330g (also 1kg).' })
  if (actionType === 'content_blog') {
    // Blog prose may MENTION green coffee educationally; reseller brands never.
    if (namesResellerBrand(text)) issues.push({ severity: 'critical', rule: 'reseller_brand', detail: 'Names Veneto, a reseller brand Minuto never promotes.' })
  } else {
    const hit = adCopyBrandViolation(snapshot, 'draft')
    if (hit) issues.push({ severity: 'critical', rule: 'brand_guard', detail: `${hit.path}: ${hit.why} ("${hit.text}")` })
  }
  return issues
}

// ── Hand-back from an async drafting worker ──────────────────────────────────

/** An async worker (writer / IG) finished generating a strategist draft: store
 *  it and queue it for the critic. Fenced on status='drafting' so a row that was
 *  swept or dismissed meanwhile is left alone. Returns null on success. */
export async function handBackForCritique(supabase: Db, recId: string, snapshot: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabase
    .from('strategic_recommendations')
    .update({
      status: 'awaiting_critique', artifact_snapshot: snapshot,
      worker_id: null, locked_until: null, updated_at: new Date().toISOString(),
    })
    .eq('id', recId)
    .eq('status', 'drafting')
    .select('id')
    .maybeSingle()
  if (error) return error.message
  return data ? null : 'recommendation is no longer drafting (swept, dismissed or already handed back)'
}
