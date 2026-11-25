// The weekly release (Phase 2): publishes the site changes the owner approved
// for the release ('queued' in site_change_log), once a week, one change per
// page, oldest approval first. Each write goes through handle-seo-chat's
// writeValue — the same read → back up → write → log path as "publish now",
// so every released change can be undone. Nothing here approves anything: it
// only publishes rows an admin already approved (approved_by is kept).
//
// Switch: ops_profile 'seo_weekly_release' (enabled:false → never runs).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { getChange } from '../_shared/site_change_log.ts'
import { localNow, pickRelease, releaseDue, releaseSettings, type QueuedChange } from '../_shared/site_release.ts'
import { writeValue } from '../handle-seo-chat/site_changes.ts'

export interface ReleaseReport {
  ran: boolean
  reason?: string
  release_date?: string
  dry_run?: boolean
  release_id?: string
  published?: string[]
  deferred?: string[]
  failed?: Array<{ change_id: string; error: string }>
}

/**
 * Runs the release if one is due (or always, with force — used for the dry-run
 * test). A real release happens at most once per release date: the unique
 * index on site_releases(release_date) for real runs is claimed before any write.
 */
type Deps = { getChange: typeof getChange; writeValue: typeof writeValue }
// deno-lint-ignore no-explicit-any
type Db = SupabaseClient | { from(t: string): any }

export async function runRelease(supabase: Db, opts: { dryRun?: boolean; force?: boolean; now?: Date } = {}, deps: Deps = { getChange, writeValue }): Promise<ReleaseReport> {
  const { data: cfg } = await supabase.from('ops_profile').select('value').eq('key', 'seo_weekly_release').maybeSingle()
  const s = releaseSettings(cfg?.value)
  const now = opts.now ?? new Date()
  const dryRun = opts.dryRun === true
  const date = opts.force ? localNow(now, s.tz).date : releaseDue(now, s)
  if (!date) return { ran: false, reason: s.enabled ? 'not release time' : 'weekly release is switched off' }

  if (!dryRun) {
    const { data: done } = await supabase.from('site_releases').select('id').eq('release_date', date).eq('dry_run', false).limit(1)
    if (done?.length) return { ran: false, reason: `already released on ${date}` }
  }

  const { data: rows, error } = await supabase.from('site_change_log').select('id, target_type, target_id, approved_at').eq('status', 'queued').order('approved_at', { ascending: true })
  if (error) throw new Error(`read queue: ${error.message}`)
  const plan = pickRelease((rows ?? []) as QueuedChange[])

  // Claim the release before writing anything, so two ticks cannot both release.
  const { data: rel, error: relErr } = await supabase.from('site_releases')
    .insert({ release_date: date, dry_run: dryRun, deferred: plan.defer.map((c) => c.id) }).select('id').single()
  if (relErr) {
    if (!dryRun && /duplicate key|unique/i.test(relErr.message)) return { ran: false, reason: `already released on ${date}` }
    throw new Error(`record release: ${relErr.message}`)
  }
  const releaseId = (rel as { id: string }).id
  if (dryRun) return { ran: true, dry_run: true, release_date: date, release_id: releaseId, published: plan.publish.map((c) => c.id), deferred: plan.defer.map((c) => c.id), failed: [] }

  const published: string[] = [], failed: Array<{ change_id: string; error: string }> = []
  for (const c of plan.publish) {
    const row = await deps.getChange(c.id)
    if (!row || row.status !== 'queued') continue // cancelled or published in the meantime
    try {
      const w = await deps.writeValue(row, row.after, { change_id: row.id, approved_by: row.approved_by ?? 'service' })
      if (w.ok) published.push(row.id)
      else failed.push({ change_id: row.id, error: w.error })
    } catch (e) {
      failed.push({ change_id: row.id, error: e instanceof Error ? e.message : String(e) })
    }
  }
  if (published.length) await supabase.from('site_change_log').update({ release_id: releaseId }).in('id', published)
  await supabase.from('site_releases').update({ published, failed }).eq('id', releaseId)
  return { ran: true, dry_run: false, release_date: date, release_id: releaseId, published, deferred: plan.defer.map((c) => c.id), failed }
}
