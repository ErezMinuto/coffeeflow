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
//   { action: 'faq_task.approve',    task_id, edited_faq? }   (a technical_seo FAQ proposal)
//
// Writes go through the same functions as before (set-post-faq,
// set-product-faq, update-product-description) or, for post content and
// featured images, through _shared/site_io.ts here — every one saves the old
// value first (_shared/site_change_log.ts).

import { releaseSettings } from '../_shared/site_release.ts'
import {
  beginChange, finishChange, getChange, proposeChange, rejectChange, undoBlocker,
  type ChangeContext, type ChangeRow, queueChange } from '../_shared/site_change_log.ts'
import {
  cleanFaq, isProductStatus, pickPostFields, pickSeoFields, readPost, readPostFaq, readProduct, readProductStatus,
  readSeoMeta, readTermDescription, seoSubset, siteEnv, writePostFields, writeProductStatus, writeSeoMeta,
  writeTermDescription, readProductShortDescription, writeProductShortDescription } from '../_shared/site_io.ts'

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
export async function readCurrent(row: Pick<ChangeRow, 'target_type' | 'target_id' | 'after'>): Promise<unknown> {
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
