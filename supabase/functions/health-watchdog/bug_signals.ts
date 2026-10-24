// ============================================================================
// File runtime-sentinel bugs into strategist_signals for the fixer agent.
// ============================================================================
//
// The fixer (.github/workflows/fixer-agent.yml) claims APPROVED bug_reports.
// The watchdog files them as 'open' — the same awaiting-review state the
// strategist and the chat use — so a human still approves every fix before an
// agent touches code. (The table's CHECK allows open / approved / building /
// shipped / declined / needs_human; there is no 'pending'.)
//
// The watchdog runs daily and a bug persists for days, so dedupe is the whole
// job here. dedupe_key = "watchdog:<key>:<YYYY-MM-DD>"; before inserting we look
// for ANY earlier row with the same "watchdog:<key>:" prefix and skip while it is
//   open / approved / building / needs_human   — already in someone's hands
//   shipped  < SHIPPED_QUIET_DAYS ago           — a fix PR exists; deploys are
//                                                manual, give it time to land
//   declined < DECLINED_QUIET_DAYS ago          — a decline is an answer
// After those windows the same bug may be filed again — a bug that comes back
// after its fix shipped is a regression, and that is worth saying.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import type { BugSignalDraft } from './runtime_sentinel.ts'

export const SHIPPED_QUIET_DAYS = 7
export const DECLINED_QUIET_DAYS = 14
const IN_FLIGHT = new Set(['open', 'approved', 'building', 'needs_human'])

export interface PriorSignal { id: string; status: string; updated_at: string | null; created_at: string }

/** Pure: should a new signal be filed given the most recent prior one with the same key? */
export function shouldFile(prior: PriorSignal | null, now = Date.now()): { file: boolean; reason: string } {
  if (!prior) return { file: true, reason: 'new' }
  if (IN_FLIGHT.has(prior.status)) return { file: false, reason: `already ${prior.status} (${prior.id})` }
  const days = (now - new Date(prior.updated_at ?? prior.created_at).getTime()) / 86_400_000
  if (prior.status === 'shipped' && days < SHIPPED_QUIET_DAYS) return { file: false, reason: `fix shipped ${days.toFixed(1)}d ago (${prior.id})` }
  if (prior.status === 'declined' && days < DECLINED_QUIET_DAYS) return { file: false, reason: `declined ${days.toFixed(1)}d ago (${prior.id})` }
  return { file: true, reason: prior.status === 'shipped' ? `regression — recurred after fix shipped (${prior.id})` : `re-raise after ${prior.status}` }
}

export const signalKeyPrefix = (key: string) => `watchdog:${key}:`

export interface FiledResult { key: string; filed: boolean; reason: string; signal_id?: string }

/** Never throws: a failed signal write must not take down the alert email. */
export async function fileBugSignals(supabase: SupabaseClient, drafts: BugSignalDraft[]): Promise<FiledResult[]> {
  const results: FiledResult[] = []
  const today = new Date().toISOString().slice(0, 10)
  for (const d of drafts) {
    try {
      const { data: prior, error: priorErr } = await supabase
        .from('strategist_signals')
        .select('id, status, updated_at, created_at')
        .like('dedupe_key', `${signalKeyPrefix(d.key)}%`)
        .order('created_at', { ascending: false })
        .limit(1)
      if (priorErr) { results.push({ key: d.key, filed: false, reason: `dedupe lookup failed: ${priorErr.message}` }); continue }

      const decision = shouldFile((prior?.[0] ?? null) as PriorSignal | null)
      if (!decision.file) { results.push({ key: d.key, filed: false, reason: decision.reason }); continue }

      const { data, error } = await supabase
        .from('strategist_signals')
        .insert({
          kind:       'bug_report',
          title:      `Automated Watchdog: ${d.title}`.slice(0, 300),
          detail:     d.detail,
          evidence:   { ...d.evidence, source: 'health-watchdog', filed_reason: decision.reason },
          status:     'open',
          dedupe_key: `${signalKeyPrefix(d.key)}${today}`,
        })
        .select('id')
        .single()
      if (error) { results.push({ key: d.key, filed: false, reason: `insert failed: ${error.message}` }); continue }
      results.push({ key: d.key, filed: true, reason: decision.reason, signal_id: (data as { id: string }).id })
    } catch (e: any) {
      results.push({ key: d.key, filed: false, reason: `threw: ${e?.message ?? e}` })
    }
  }
  return results
}
