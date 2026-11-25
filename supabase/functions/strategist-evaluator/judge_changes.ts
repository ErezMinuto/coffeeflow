// Phase 3: judge applied site changes against what they were expected to do.
// Runs in the daily strategist-evaluator tick. Two steps:
//   1. baseline — for each applied change without one: the page's Search
//      Console numbers (latest 28-day window), the site's total clicks, and
//      GA4 organic sessions for the 28 days before it went live;
//   2. judge — once a full 28-day window after the change exists and its check
//      date has passed: the same numbers after, a verdict (change_judge.ts),
//      a lesson in seo_learnings, and for a loss (file_undo on) an undo
//      proposal in the approvals inbox. Never writes to the live site itself.
// A merge (bundle_id) is judged once, on its redirect step, by the page kept
// and the retired page TOGETHER: the retired page losing its clicks is the
// point of a merge, not a loss. Its other steps are marked as part of it.
// Switch: ops_profile 'seo_change_judge' (enabled:false → does nothing).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { checkDate, combineStats, judge, pageStatsIndex, statsFor, type Verdict } from '../_shared/change_judge.ts'
import { proposeChange } from '../_shared/site_change_log.ts'
import { selectAll } from '../_shared/select_all.ts'
import { pageKey } from '../strategist-brain/seo_audit_analysis.ts'

type Qp = { page: string; clicks: number; impressions: number; position: number }
// deno-lint-ignore no-explicit-any
type Db = SupabaseClient | { from(t: string): any }

export interface JudgeReport { ran: boolean; reason?: string; dry_run?: boolean; baselines?: number; judged?: Array<{ change_id: string; verdict: Verdict; note: string }>; undo_proposals?: number; waiting?: number }

const day = (iso: string) => iso.slice(0, 10)
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10)

async function window(supabase: Db, end: string): Promise<Qp[]> {
  return await selectAll<Qp>((from, to) => supabase.from('gsc_query_page').select('page, clicks, impressions, position').eq('period_days', 28).eq('period_end', end).order('query').order('page').range(from, to), { label: 'gsc window', maxRows: 150_000 })
}

/**
 * GA4 organic sessions and conversions for the pages being judged: ONE read of
 * the whole span (earliest baseline to today), kept per page per day for just
 * those pages, then summed for any date range without another query.
 */
async function organicReader(supabase: Db, keys: ReadonlySet<string>, from: string, to: string) {
  const byKey = new Map<string, Array<[string, number, number]>>()
  const rows = await selectAll<{ date: string; page_path: string; sessions: number; conversions: number }>((f, t) => supabase.from('ga4_pages_daily').select('date, page_path, sessions, conversions').eq('channel_group', 'Organic Search').gte('date', from).lte('date', to).order('date').order('page_path').range(f, t), { label: 'ga4 span', maxRows: 300_000 })
  for (const r of rows) {
    const k = pageKey(r.page_path)
    if (!keys.has(k)) continue
    const list = byKey.get(k) ?? []; list.push([r.date, Number(r.sessions) || 0, Number(r.conversions) || 0]); byKey.set(k, list)
  }
  return (key: string, a: string, b: string) => {
    let sessions = 0, conversions = 0
    for (const [d, s, c] of byKey.get(key) ?? []) if (d >= a && d <= b) { sessions += s; conversions += c }
    return { sessions, conversions }
  }
}

export async function judgeChanges(supabase: Db, opts: { dryRun?: boolean; today?: string } = {}, deps: { proposeChange: typeof proposeChange } = { proposeChange }): Promise<JudgeReport> {
  const { data: cfg } = await supabase.from('ops_profile').select('value').eq('key', 'seo_change_judge').maybeSingle()
  const v = (cfg?.value ?? {}) as { enabled?: unknown; file_undo?: unknown }
  const dryRun = opts.dryRun === true
  if (v.enabled !== true && !dryRun) return { ran: false, reason: 'change judging is switched off' }
  const today = opts.today ?? new Date().toISOString().slice(0, 10)

  const { data: ends } = await supabase.from('gsc_query_page').select('period_end').eq('period_days', 28).order('period_end', { ascending: false }).limit(1)
  const latestEnd: string | undefined = ends?.[0]?.period_end
  if (!latestEnd) return { ran: false, reason: 'no Search Console per-page window yet' }

  const { data: rows, error } = await supabase.from('site_change_log').select('id, target_type, target_id, target_url, target_title, reason, applied_at, before, before_source, after, baseline, undo_of, bundle_id')
    .eq('status', 'applied').is('judged_at', null).is('undo_of', null).not('applied_at', 'is', null).not('target_url', 'is', null).order('applied_at', { ascending: true }).limit(200)
  if (error) throw new Error(`read applied changes: ${error.message}`)
  const changes = (rows ?? []) as Array<Record<string, any>>
  if (!changes.length) return { ran: true, dry_run: dryRun, baselines: 0, judged: [], undo_proposals: 0, waiting: 0 }

  // The pages each change is judged on: its own, plus the page kept for a merge's redirect.
  const pagesOf = (c: Record<string, any>): string[] => (c.target_type === 'redirect' && typeof c.after === 'string' ? [pageKey(c.target_url), pageKey(c.after)] : [pageKey(c.target_url)])
  const keys = new Set(changes.flatMap(pagesOf))
  const earliest = changes.reduce((m, c) => (day(c.applied_at) < m ? day(c.applied_at) : m), today)
  const organic = await organicReader(supabase, keys, addDays(earliest, -28), today)
  const latest = await window(supabase, latestEnd)
  const siteLatest = latest.reduce((s, r) => s + (Number(r.clicks) || 0), 0)
  const idx = pageStatsIndex(latest, pageKey) // one pass over the window, then cheap lookups per change
  let baselines = 0, undoCount = 0, waiting = 0
  const judged: JudgeReport['judged'] = []

  const statsOf = (c: Record<string, any>) => combineStats(pagesOf(c).map((k) => statsFor(idx, k)))
  const organicOf = (c: Record<string, any>, a: string, b: string) => pagesOf(c).map((k) => organic(k, a, b)).reduce((x, y) => ({ sessions: x.sessions + y.sessions, conversions: x.conversions + y.conversions }), { sessions: 0, conversions: 0 })

  for (const c of changes) {
    const key = pageKey(c.target_url), applied = day(c.applied_at)
    if (c.bundle_id && c.target_type !== 'redirect') {
      // Judged with its merge, on the redirect step.
      if (!dryRun) await supabase.from('site_change_log').update({ result: { part_of_merge: c.bundle_id }, judged_at: new Date().toISOString() }).eq('id', c.id)
      continue
    }
    // 1. Baseline (from the latest window when first seen: it ends at or before the change, give or take a week).
    let baseline = c.baseline as Record<string, any> | null
    if (!baseline) {
      baseline = { window_end: latestEnd, page: statsOf(c), pages: pagesOf(c), site_clicks: siteLatest, ga4_28d_before: organicOf(c, addDays(applied, -28), addDays(applied, -1)) }
      baselines++
      if (!dryRun) await supabase.from('site_change_log').update({ baseline }).eq('id', c.id)
    }
    // 2. Judge once a full 28-day window after the change exists and the check date has passed.
    const due = checkDate(c.reason, c.applied_at)
    if (due > today || latestEnd < addDays(applied, 28) || baseline.window_end >= latestEnd) { waiting++; continue }
    const after = { window_end: latestEnd, page: statsOf(c), pages: pagesOf(c), site_clicks: siteLatest, ga4_28d_after: organicOf(c, applied, addDays(applied, 27)) }
    const j = judge(baseline.page, after.page, Number(baseline.site_clicks) || 0, siteLatest)
    judged.push({ change_id: c.id, verdict: j.verdict, note: j.note })
    if (dryRun) continue
    await supabase.from('site_change_log').update({ result: { ...after, ...j }, verdict: j.verdict, judged_at: new Date().toISOString() }).eq('id', c.id)
    const label = c.bundle_id ? `merge of ${c.target_title || key} into ${decodeURI(String(c.after))} (both pages counted together)` : `${c.target_type} on ${c.target_title || key}`
    if (j.verdict === 'win' || j.verdict === 'loss') {
      await supabase.from('seo_learnings').insert({
        scope: 'site_change', created_by: 'change-judge',
        insight: `${j.verdict === 'win' ? 'Worked' : 'Did not work'}: ${label}. ${j.note}; clicks ${baseline.page.clicks} → ${after.page.clicks}, position ${baseline.page.position ?? '-'} → ${after.page.position ?? '-'} (site trend ×${j.site_factor}).`,
        evidence_log: [{ change_id: c.id, verdict: j.verdict, before: baseline.page, after: after.page, site_factor: j.site_factor }],
      })
    }
    // A merge is undone as a whole from the inbox; no single-step undo proposal for it.
    if (j.verdict === 'loss' && v.file_undo === true && !c.bundle_id && c.before != null && c.before_source !== 'none') {
      const { data: open } = await supabase.from('site_change_log').select('id').eq('target_type', c.target_type).eq('target_id', c.target_id).in('status', ['proposed', 'queued']).limit(1)
      if (!open?.length) {
        await deps.proposeChange({ target_type: c.target_type, target_id: c.target_id, target_url: c.target_url, target_title: c.target_title, after: c.before, source_fn: 'strategist-evaluator', requested_by: 'change judge',
          reason: `Why: change ${c.id} (${label}) was judged a loss on ${today}: ${j.note}; clicks ${baseline.page.clicks} → ${after.page.clicks} with the site trend ×${j.site_factor}.\nExpected: restoring the previous version recovers the page's clicks.\nCheck on: ${addDays(today, 28)}` })
        undoCount++
      }
    }
  }
  return { ran: true, dry_run: dryRun, baselines, judged, undo_proposals: undoCount, waiting }
}
