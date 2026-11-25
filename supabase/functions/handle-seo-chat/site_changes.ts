// Approval and undo for live site changes (SEO agent build plan, Phase 0).
//
// The admin chat no longer writes live content itself. Its tools file a
// 'proposed' row in public.site_change_log, and the owner approves or rejects
// it in the dashboard's approvals inbox. That click arrives here as a
// structured request (no model involved), so an approval can only come from a
// signed-in admin, never from the model deciding it heard a "yes".
//
// Requests (POST to handle-seo-chat, admin Clerk token required):
//   { action: 'site_change.approve', change_id }
//   { action: 'site_change.reject',  change_id, reason }
//   { action: 'site_change.undo',    change_id, force? }
//   A change that is one step of a merge (bundle_id) is approved, rejected,
//   published and undone together with the other steps: applied in bundle_seq
//   order, stopping at the first failure; undone in reverse order.
//   { action: 'faq_task.approve',    task_id, edited_faq? }   (a technical_seo FAQ proposal)
//
// Writes go through the same functions as before (set-post-faq,
// set-product-faq, update-product-description) or, for post content and
// featured images, through _shared/site_io.ts here — every one saves the old
// value first (_shared/site_change_log.ts).

import { releaseSettings } from '../_shared/site_release.ts'
import {
  beginChange, finishChange, getBundle, getChange, proposeChange, rejectChange, undoBlocker,
  type ChangeContext, type ChangeRow, queueChange } from '../_shared/site_change_log.ts'
import {
  cleanFaq, isProductStatus, pickPostFields, pickSeoFields, readPost, readPostFaq, readProduct, readProductStatus,
  readSeoMeta, readTermDescription, seoSubset, siteEnv, writePostFields, writeProductStatus, writeSeoMeta,
  writeTermDescription, readProductShortDescription, writeProductShortDescription,
  isPostStatus, readPostStatus, readRedirect, writePostStatus, writeRedirect } from '../_shared/site_io.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

export const SITE_CHANGE_ACTIONS: ReadonlySet<string> = new Set([
  'site_change.approve', 'site_change.publish_now', 'site_change.reject', 'site_change.undo', 'faq_task.approve',
])

export interface ActionResult { status: number; body: Record<string, unknown> }

const ok = (body: Record<string, unknown>): ActionResult => ({ status: 200, body: { ok: true, ...body } })
const err = (status: number, error: string, extra: Record<string, unknown> = {}): ActionResult => ({ status, body: { ok: false, error, ...extra } })

async function callWriter(fn: string, payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE },
    body: JSON.stringify(payload),
  })
  const json = await res.json().catch(() => ({})) as Record<string, unknown>
  return { ok: res.ok && json.success === true, status: res.status, json }
}

/** The site's current value for a change's target, in the shape the log stores. */
export async function readCurrent(row: Pick<ChangeRow, 'target_type' | 'target_id' | 'after'> & { target_url?: string | null }): Promise<unknown> {
  const env = siteEnv()
  switch (row.target_type) {
    case 'post_faq':            return (await readPostFaq(env, row.target_id)).faq
    case 'product_faq':         return (await readProduct(env, row.target_id)).faq
    case 'product_description': return (await readProduct(env, row.target_id)).description
    case 'post_featured_image': return (await readPost(env, row.target_id)).featured_media
    case 'seo_meta':
    case 'term_seo_meta': {
      const fields = pickSeoFields(row.after) ?? {}
      return seoSubset((await readSeoMeta(env, row.target_type === 'seo_meta' ? 'post' : 'product_cat', row.target_id)).meta, fields)
    }
    case 'term_description': return (await readTermDescription(env, row.target_id)).description
    case 'product_status':   return (await readProductStatus(env, row.target_id)).status
    case 'product_short_description': return (await readProductShortDescription(env, row.target_id)).short_description
    case 'redirect':         return (await readRedirect(env, String((row as { target_url?: string | null }).target_url ?? ''))).target
    case 'post_status':      return (await readPostStatus(env, row.target_id)).status
    case 'post_content': {
      const p = await readPost(env, row.target_id)
      return pickPostFields(p, (row.after ?? {}) as Record<string, unknown>)
    }
  }
}

/**
 * The one order every write follows: read the current value, save it
 * (beginChange; no backup → no write), write, read back what the site stored,
 * finishChange. `read` returns the backup; `write` returns the stored value.
 */
async function loggedWrite(
  row: Pick<ChangeRow, 'target_type' | 'target_id' | 'target_url' | 'target_title'>,
  value: unknown,
  read: () => Promise<{ before: unknown; url?: string | null; title?: string | null; source: string }>,
  write: () => Promise<unknown>,
  ctx: ChangeContext,
): Promise<{ ok: true; change_id: string } | { ok: false; error: string; change_id?: string }> {
  let changeId: string
  try {
    const cur = await read()
    changeId = await beginChange({
      target_type: row.target_type, target_id: row.target_id,
      target_url: cur.url || row.target_url, target_title: cur.title || row.target_title,
      before: cur.before, before_source: cur.source, after: value, source_fn: 'handle-seo-chat', ctx,
    })
  } catch (e) {
    return { ok: false, error: `not written: could not back up the current value first (${(e as Error).message})` }
  }
  let stored: unknown
  try {
    stored = await write()
  } catch (e) {
    const error = (e as Error).message
    await finishChange(changeId, { ok: false, error })
    return { ok: false, error, change_id: changeId }
  }
  await finishChange(changeId, { ok: true, after: stored })
  return { ok: true, change_id: changeId }
}

/** Writes `value` to the change's target, logging it under `ctx`. Returns the new change row id. */
export async function writeValue(
  row: Pick<ChangeRow, 'target_type' | 'target_id' | 'target_url' | 'target_title'>,
  value: unknown,
  ctx: ChangeContext,
): Promise<{ ok: true; change_id: string } | { ok: false; error: string; change_id?: string }> {
  const viaWriter = async (fn: string, payload: Record<string, unknown>) => {
    const r = await callWriter(fn, { ...payload, change: ctx })
    return r.ok
      ? { ok: true as const, change_id: String(r.json.change_id ?? '') }
      : { ok: false as const, error: `${fn} failed (${r.status}): ${String(r.json.error ?? JSON.stringify(r.json)).slice(0, 300)}`, change_id: r.json.change_id as string | undefined }
  }
  switch (row.target_type) {
    case 'post_faq':
      return viaWriter('set-post-faq', { post_id: row.target_id, faq: cleanFaq(value) })
    case 'product_faq':
      return viaWriter('set-product-faq', { product_id: row.target_id, faq: cleanFaq(value) })
    case 'product_description':
      if (typeof value !== 'string') return { ok: false, error: 'product description value must be text' }
      return viaWriter('update-product-description', { product_id: row.target_id, description: value })
    case 'seo_meta':
    case 'term_seo_meta': {
      const fields = pickSeoFields(value)
      if (!fields) return { ok: false, error: 'SEO value must be { title?, description?, focus_keyword? } with text values' }
      const env = siteEnv(), kind = row.target_type === 'seo_meta' ? 'post' as const : 'product_cat' as const
      return await loggedWrite(row, value, async () => {
        const cur = await readSeoMeta(env, kind, row.target_id)
        return { before: seoSubset(cur.meta, fields), url: cur.url, title: cur.name, source: 'wp_plugin' }
      }, async () => seoSubset((await writeSeoMeta(env, kind, row.target_id, fields)).meta, fields), ctx)
    }
    case 'term_description': {
      if (typeof value !== 'string') return { ok: false, error: 'category text must be text' }
      const env = siteEnv()
      return await loggedWrite(row, value, async () => {
        const cur = await readTermDescription(env, row.target_id)
        return { before: cur.description, url: row.target_url, title: cur.name, source: 'woo_rest' }
      }, async () => (await writeTermDescription(env, row.target_id, value)).description, ctx)
    }
    case 'product_status': {
      if (!isProductStatus(value)) return { ok: false, error: 'product status must be publish, draft, pending or private' }
      const env = siteEnv()
      return await loggedWrite(row, value, async () => {
        const cur = await readProductStatus(env, row.target_id)
        return { before: cur.status, url: cur.permalink || row.target_url, title: cur.name, source: 'woo_rest' }
      }, async () => await writeProductStatus(env, row.target_id, value), ctx)
    }
    case 'product_short_description': {
      if (typeof value !== 'string') return { ok: false, error: 'product short description must be text' }
      const env = siteEnv()
      return await loggedWrite(row, value, async () => {
        const cur = await readProductShortDescription(env, row.target_id)
        return { before: cur.short_description, url: cur.permalink || row.target_url, title: cur.name, source: 'woo_rest' }
      }, async () => await writeProductShortDescription(env, row.target_id, value), ctx)
    }
    case 'redirect': {
      // value: the absolute URL to send the page to, or null to remove the redirect (undo).
      const source = row.target_url
      if (!source) return { ok: false, error: 'a redirect needs the address of the page it moves (target_url)' }
      if (value !== null && typeof value !== 'string') return { ok: false, error: 'redirect value must be the target address, or null to remove it' }
      const env = siteEnv()
      if (typeof value === 'string') {
        // Never send visitors to a page that is not live (checked again at the moment of writing).
        const r = await env.fetchFn(value, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'MinutoSeoChanges/1.0' } })
        await r.body?.cancel()
        if (r.status !== 200) return { ok: false, error: `not written: the redirect target answers ${r.status}, not 200 (${decodeURI(value)})` }
      }
      return await loggedWrite(row, value, async () => {
        const cur = await readRedirect(env, source)
        return { before: cur.target, url: source, title: row.target_title, source: 'wp_plugin' }
      }, async () => await writeRedirect(env, source, value as string | null), ctx)
    }
    case 'post_status': {
      if (!isPostStatus(value)) return { ok: false, error: 'post status must be publish or draft' }
      const env = siteEnv()
      return await loggedWrite(row, value, async () => {
        const cur = await readPostStatus(env, row.target_id)
        return { before: cur.status, url: row.target_url || cur.link, title: cur.title, source: 'wp_rest' }
      }, async () => await writePostStatus(env, row.target_id, value), ctx)
    }
    case 'post_content':
    case 'post_featured_image': {
      const env = siteEnv()
      let changeId: string
      let fields: { title?: string; content?: string; featured_media?: number }
      try {
        const p = await readPost(env, row.target_id)
        let before: unknown
        if (row.target_type === 'post_featured_image') {
          const id = Number(value)
          if (!Number.isInteger(id) || id < 0) return { ok: false, error: 'featured image value must be a media id' }
          fields = { featured_media: id }
          before = p.featured_media
        } else {
          const v = (value ?? {}) as Record<string, unknown>
          fields = {}
          if (typeof v.title === 'string') fields.title = v.title
          if (typeof v.content === 'string') fields.content = v.content
          if (fields.title === undefined && fields.content === undefined) return { ok: false, error: 'nothing to write (no title or content)' }
          before = pickPostFields(p, fields)
        }
        changeId = await beginChange({
          target_type:   row.target_type,
          target_id:     row.target_id,
          target_url:    p.link || row.target_url,
          target_title:  p.title || row.target_title,
          before,
          before_source: 'wp_rest',
          after:         row.target_type === 'post_featured_image' ? fields.featured_media : value,
          source_fn:     'handle-seo-chat',
          ctx,
        })
      } catch (e) {
        return { ok: false, error: `not written: could not back up the current value first (${(e as Error).message})` }
      }
      try {
        await writePostFields(env, row.target_id, fields)
      } catch (e) {
        const error = (e as Error).message
        await finishChange(changeId, { ok: false, error })
        return { ok: false, error, change_id: changeId }
      }
      let stored: unknown = undefined
      try {
        const p = await readPost(env, row.target_id)
        stored = row.target_type === 'post_featured_image' ? p.featured_media : pickPostFields(p, fields)
      } catch { /* keep `after` as sent */ }
      await finishChange(changeId, { ok: true, after: stored })
      return { ok: true, change_id: changeId }
    }
  }
}

/** Applies a draft-post edit straight away (drafts aren't live), still backed up. */
export async function applyDirect(
  target: { target_type: 'post_content'; target_id: number },
  value: { title?: string; content?: string },
  ctx: ChangeContext,
) {
  return writeValue({ ...target, target_url: null, target_title: null }, value, ctx)
}

export async function handleSiteChangeAction(
  action: string,
  body: Record<string, unknown>,
  approver: string,  // Clerk user id of the signed-in admin
  supabase: { from: (t: string) => any },
): Promise<ActionResult> {
  try {
    if (action === 'faq_task.approve') return await approveFaqTask(body, approver, supabase)

    const changeId = typeof body.change_id === 'string' ? body.change_id : ''
    const row = changeId ? await getChange(changeId) : null
    if (!row) return err(404, 'change not found')
    if (row.bundle_id) return await bundleAction(action, body, approver, supabase, row.bundle_id)

    if (action === 'site_change.reject') {
      const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'rejected in the approvals inbox'
      return (await rejectChange(row.id, approver, reason))
        ? ok({ change_id: row.id, status: 'rejected' })
        : err(409, `this change is ${row.status}, not waiting for approval`)
    }

    // Approve: with the weekly release on, the change joins the queue for the
    // next release; with it off (or publish_now), it is written at once.
    // Publish now: a proposed change, or one already queued, is written at once.
    if (action === 'site_change.approve' || action === 'site_change.publish_now') {
      const now = action === 'site_change.publish_now' || body.publish_now === true
      if (row.status !== 'proposed' && !(now && row.status === 'queued')) return err(409, `this change is ${row.status}, not waiting for approval`)
      if (!now && row.status === 'proposed') {
        const { data } = await supabase.from('ops_profile').select('value').eq('key', 'seo_weekly_release').maybeSingle()
        const rs = releaseSettings(data?.value)
        if (rs.enabled) {
          return (await queueChange(row.id, approver))
            ? ok({ change_id: row.id, status: 'queued', release: { weekday: rs.weekday, hour: rs.hour, tz: rs.tz } })
            : err(409, 'this change is no longer waiting for approval')
        }
      }
      const w = await writeValue(row, row.after, { change_id: row.id, approved_by: row.approved_by ?? approver })
      return w.ok ? ok({ change_id: row.id, status: 'applied' }) : err(502, w.error, { change_id: row.id })
    }

    if (action === 'site_change.undo') {
      const current = await readCurrent(row)
      const blocker = undoBlocker(row, current)
      // A changed page can still be undone deliberately (force), never by accident.
      // The other blockers (not applied, no backup) are absolute.
      const pageChanged = blocker !== null && row.status === 'applied' && row.before_source !== 'none'
      if (blocker && !(pageChanged && body.force === true)) {
        return err(409, blocker, { can_force: pageChanged, current })
      }
      const w = await writeValue(row, row.before, {
        undo_of: row.id, approved_by: approver, requested_by: 'undo',
        reason: `undo of change ${row.id}${body.force === true ? ' (forced: page had changed since)' : ''}`,
      })
      return w.ok ? ok({ change_id: w.change_id, undid: row.id }) : err(502, w.error, { change_id: w.change_id })
    }

    return err(400, `unknown action ${action}`)
  } catch (e) {
    return err(500, (e as Error).message)
  }
}

const PENDING = new Set(['proposed', 'queued'])

/**
 * The steps of a merge go together. Approve/publish: every pending step, in
 * bundle_seq order, stopping at the first failure (the steps after it stay
 * pending, and approving again continues from there). Reject: every pending
 * step. Undo: every applied step, newest first, after checking all of them.
 */
async function bundleAction(action: string, body: Record<string, unknown>, approver: string, supabase: { from: (t: string) => any }, bundleId: string): Promise<ActionResult> {
  const rows = await getBundle(bundleId)
  if (!rows.length) return err(404, 'merge not found')
  const pending = rows.filter((r) => PENDING.has(r.status))

  if (action === 'site_change.reject') {
    if (!pending.length) return err(409, 'no step of this merge is waiting for approval')
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'rejected in the approvals inbox'
    const rejected: string[] = []
    for (const r of pending) if (await rejectChange(r.id, approver, reason)) rejected.push(r.id)
    return ok({ bundle_id: bundleId, rejected, status: 'rejected' })
  }

  if (action === 'site_change.approve' || action === 'site_change.publish_now') {
    if (rows.some((r) => r.status === 'rejected' || r.status === 'undone')) return err(409, 'this merge was rejected or undone; it cannot be applied')
    if (rows.some((r) => r.status === 'applying')) return err(409, 'this merge is being applied right now')
    const now = action === 'site_change.publish_now' || body.publish_now === true
    const proposed = pending.filter((r) => r.status === 'proposed')
    if (!now && proposed.length && proposed.length === pending.length) {
      const { data } = await supabase.from('ops_profile').select('value').eq('key', 'seo_weekly_release').maybeSingle()
      const rs = releaseSettings(data?.value)
      if (rs.enabled) {
        const queued: string[] = []
        for (const r of proposed) if (await queueChange(r.id, approver)) queued.push(r.id)
        return queued.length === proposed.length
          ? ok({ bundle_id: bundleId, queued, status: 'queued', release: { weekday: rs.weekday, hour: rs.hour, tz: rs.tz } })
          : err(409, 'part of this merge is no longer waiting for approval', { queued })
      }
    }
    if (!pending.length) return err(409, 'every step of this merge is already applied')
    if (!now && !proposed.length) return err(409, 'this merge is already approved and waiting for the weekly release')
    const r = await applyBundle(rows, approver)
    return r.ok ? ok({ bundle_id: bundleId, applied: r.applied, status: 'applied' }) : err(502, r.error, { bundle_id: bundleId, applied: r.applied, failed_step: r.failed })
  }

  if (action === 'site_change.undo') {
    const applied = rows.filter((r) => r.status === 'applied').sort((a, b) => Number(b.bundle_seq ?? 0) - Number(a.bundle_seq ?? 0))
    if (!applied.length) return err(409, 'no step of this merge is applied')
    // Check every step first: half an undo would leave the site in a state nobody approved.
    const blocked: Array<{ change_id: string; error: string; can_force: boolean }> = []
    for (const r of applied) {
      const b = undoBlocker(r, await readCurrent(r))
      if (b) blocked.push({ change_id: r.id, error: b, can_force: r.before_source !== 'none' })
    }
    if (blocked.length && !(body.force === true && blocked.every((b) => b.can_force))) {
      return err(409, blocked.map((b) => b.error).join('; '), { can_force: blocked.every((b) => b.can_force), blocked })
    }
    const undone: string[] = []
    for (const r of applied) {
      const w = await writeValue(r, r.before, {
        undo_of: r.id, approved_by: approver, requested_by: 'undo',
        reason: `undo of change ${r.id} (merge ${bundleId})${body.force === true ? ' (forced: page had changed since)' : ''}`,
      })
      if (!w.ok) return err(502, `undo stopped at step ${r.bundle_seq} (${r.target_type}): ${w.error}`, { undone, change_id: w.change_id })
      undone.push(r.id)
    }
    return ok({ bundle_id: bundleId, undid: undone })
  }

  return err(400, `unknown action ${action}`)
}

/** Writes the pending steps of a merge in order; stops at the first failure. */
export async function applyBundle(rows: ChangeRow[], approver: string, deps: { writeValue: typeof writeValue } = { writeValue }): Promise<{ ok: true; applied: string[] } | { ok: false; applied: string[]; failed: string; error: string }> {
  const applied: string[] = []
  for (const r of [...rows].sort((a, b) => Number(a.bundle_seq ?? 0) - Number(b.bundle_seq ?? 0))) {
    if (r.status === 'applied') continue
    if (!PENDING.has(r.status)) return { ok: false, applied, failed: r.id, error: `step ${r.bundle_seq} (${r.target_type}) is ${r.status}` }
    const w = await deps.writeValue(r, r.after, { change_id: r.id, approved_by: r.approved_by ?? approver })
    if (!w.ok) return { ok: false, applied, failed: r.id, error: `step ${r.bundle_seq} (${r.target_type}) failed, the steps after it were not applied: ${w.error}` }
    applied.push(r.id)
  }
  return { ok: true, applied }
}

/** Files a proposal from a technical_seo FAQ task and applies it — the admin's click is the approval. */
async function approveFaqTask(body: Record<string, unknown>, approver: string, supabase: { from: (t: string) => any }): Promise<ActionResult> {
  const taskId = typeof body.task_id === 'string' ? body.task_id.trim() : ''
  if (!taskId) return err(400, 'task_id required')
  const { data: task, error } = await supabase.from('seo_tasks').select('id, task_type, result_data').eq('id', taskId).maybeSingle()
  if (error) return err(500, error.message)
  if (!task) return err(404, 'task not found')
  if (task.task_type !== 'technical_seo') return err(400, `task is ${task.task_type}, not technical_seo`)
  const rd = (task.result_data ?? {}) as Record<string, unknown>
  if (rd.faq_written === true) return err(409, 'this FAQ is already on the live page')
  const faq = cleanFaq(Array.isArray(body.edited_faq) ? body.edited_faq : rd.proposed_faq)
  if (faq.length === 0) return err(400, 'no valid question/answer pairs to write')

  // The chat may already have filed this task's FAQ as a proposal. Approve
  // that one as it stands; with edits, it is superseded by a new proposal.
  if (typeof rd.change_id === 'string') {
    const prior = await getChange(rd.change_id)
    if (prior?.status === 'proposed') {
      if (!Array.isArray(body.edited_faq)) {
        const w = await writeValue(prior, prior.after, { change_id: prior.id, approved_by: approver })
        if (!w.ok) return err(502, w.error, { change_id: prior.id })
        await supabase.from('seo_tasks').update({
          result_data: { ...rd, faq_written: true, review_required: false, written_faq: prior.after, approved_via_ui_at: new Date().toISOString() },
        }).eq('id', taskId)
        return ok({ change_id: prior.id, task_id: taskId, status: 'applied' })
      }
      await rejectChange(prior.id, approver, 'superseded by an edited version')
    }
  }

  let targetId = Number(rd.target_post_id)
  const targetUrl = typeof rd.target_post_url === 'string' ? rd.target_post_url : null
  if (!Number.isInteger(targetId) || targetId <= 0) {
    targetId = targetUrl ? (await resolveWpId(targetUrl)) ?? 0 : 0
    if (!targetId) return err(400, 'the task has no target post id, and its URL could not be resolved')
  }

  const proposal = await proposeChange({
    target_type: 'post_faq', target_id: targetId, target_url: targetUrl,
    target_title: typeof rd.article_title === 'string' ? rd.article_title : null,
    after: faq, source_fn: 'handle-seo-chat', requested_by: 'seo-worker-techseo',
    reason: `FAQ proposal from technical_seo task ${taskId}`,
  })
  const w = await writeValue(proposal, faq, { change_id: proposal.id, approved_by: approver })
  if (!w.ok) return err(502, w.error, { change_id: proposal.id })

  await supabase.from('seo_tasks').update({
    result_data: { ...rd, faq_written: true, review_required: false, written_faq: faq, change_id: proposal.id, approved_via_ui_at: new Date().toISOString() },
  }).eq('id', taskId)
  return ok({ change_id: proposal.id, task_id: taskId, status: 'applied' })
}

/** Blog post (or product) URL → WP id, by its slug. */
export async function resolveWpId(url: string): Promise<number | null> {
  let slug = ''
  try {
    slug = decodeURIComponent(new URL(url).pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() ?? '')
  } catch { return null }
  if (!slug) return null
  const env = siteEnv()
  for (const base of ['posts', 'product']) {
    try {
      const r = await env.fetchFn(`${env.wpUrl}/wp-json/wp/v2/${base}?slug=${encodeURIComponent(slug)}&_fields=id`)
      if (!r.ok) { await r.body?.cancel(); continue }
      const arr = await r.json().catch(() => [])
      if (Array.isArray(arr) && typeof arr[0]?.id === 'number') return arr[0].id
    } catch { /* try the next type */ }
  }
  return null
}
