// Approvals inbox: everything the agents are waiting on Erez for, in one list.
//
// Sources (the same queues the daily approval email and NeedsYou count):
//   • strategic_recommendations  proposed / ready_for_review / needs_human
//   • campaigns                  status='draft'   (email drafts, never sent from here)
//   • seo_tasks                  result_data.review_required = true (IG posts, visuals, tech SEO)
//   • strategist_signals         status='open'    (bugs, capability requests, ideas)
//
// Every item can be approved, rejected with a reason, or handed to the agent
// chat ("guide") with its context prefilled. Rejecting never deletes: rows get a
// dismissed/declined/archived status or review_required=false plus the reason,
// so anything can be restored. Publishing an Instagram post is the only action
// that goes live, and it asks for confirmation first (same call as the task queue).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, X, MessageSquare, RefreshCw, ExternalLink } from 'lucide-react'
import { supabase } from '../../lib/supabase'

type Kind = 'rec' | 'campaign' | 'task' | 'signal'

export interface InboxItem {
  key:      string          // `${kind}:${id}`
  kind:     Kind
  id:       string
  group:    string          // section heading
  title:    string
  detail:   string
  status:   string
  created:  string
  imageUrl?: string
  link?:    string
  raw:      Record<string, any>
}

const DAY = 86_400_000
const IG_CONTAINER_TTL_MS = 23 * 3600 * 1000   // Meta expires prepared containers after ~24h

function ageLabel(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / DAY)
  return d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`
}

async function loadInbox(): Promise<InboxItem[]> {
  const [recs, camps, tasks, sigs] = await Promise.all([
    supabase.from('strategic_recommendations').select('*')
      .in('status', ['proposed', 'ready_for_review', 'needs_human']).order('created_at', { ascending: false }).limit(200),
    supabase.from('campaigns').select('id, subject, preheader, created_at, campaign_type, status')
      .eq('status', 'draft').order('created_at', { ascending: false }).limit(200),
    supabase.from('seo_tasks').select('id, task_type, task_subtype, brief_data, result_data, created_at, status')
      .eq('result_data->>review_required', 'true').order('created_at', { ascending: false }).limit(500),
    // '*' so the inbox also works before the innovation_pitch columns exist.
    supabase.from('strategist_signals').select('*')
      .eq('status', 'open').order('created_at', { ascending: false }).limit(200),
  ])
  // Surface a failed source instead of silently showing an emptier inbox.
  const failed = [['recommendations', recs], ['email drafts', camps], ['content tasks', tasks], ['agent requests', sigs]]
    .filter(([, r]) => (r as { error: unknown }).error).map(([n]) => n)
  if (failed.length) throw new Error(`Could not load: ${failed.join(', ')}. Refresh to retry.`)
  const out: InboxItem[] = []
  for (const r of (recs.data ?? []) as any[]) {
    const group = r.status === 'proposed' ? 'Strategist ideas: approve to draft'
      : r.status === 'ready_for_review' ? 'Strategist drafts: passed review' : 'Strategist drafts: did not pass review'
    out.push({ key: `rec:${r.id}`, kind: 'rec', id: r.id, group, title: r.title, status: r.status, created: r.created_at,
      detail: [r.action_type !== 'none' ? `[${r.action_type}]` : '', r.rationale ?? '', r.draft_error ?? ''].filter(Boolean).join(' '), raw: r })
  }
  for (const c of (camps.data ?? []) as any[]) {
    out.push({ key: `campaign:${c.id}`, kind: 'campaign', id: String(c.id), group: 'Email drafts (not sent)', title: c.subject || '(no subject)',
      detail: c.preheader ?? '', status: c.status, created: c.created_at, link: '/marketing?tab=history', raw: c })
  }
  for (const t of (tasks.data ?? []) as any[]) {
    const rd = t.result_data ?? {}, bd = t.brief_data ?? {}
    const label = t.task_type === 'instagram_post' ? 'Instagram posts' : t.task_type === 'visual_generation' ? 'Images' : t.task_type === 'technical_seo' ? 'Technical SEO' : t.task_type
    out.push({ key: `task:${t.id}`, kind: 'task', id: t.id, group: `${label}: waiting for review`,
      title: bd.caption_he?.slice(0, 120) || bd.keyword || bd.scene_brief?.slice(0, 120) || t.task_subtype || t.task_type,
      detail: rd.review_reason ?? rd.qa_summary ?? '', status: t.status, created: t.created_at,
      imageUrl: rd.image_url ?? rd.carousel_slides?.[0]?.image_url, raw: t })
  }
  for (const s of (sigs.data ?? []) as any[]) {
    out.push({ key: `signal:${s.id}`, kind: 'signal', id: s.id,
      group: s.kind === 'innovation_pitch' ? 'Innovation pitches: new tools and methods' : `Agent requests: ${s.kind.replace('_', ' ')}`, title: s.title,
      detail: [s.detail ?? '', s.leverage ? `Payoff: ${s.leverage}` : ''].filter(Boolean).join(' '), status: s.status, created: s.created_at, raw: s })
  }
  return out
}

/** The task's result_data as it is NOW, so an update never overwrites what a
 *  worker wrote after the inbox loaded, and a task someone already handled
 *  (in another tab) is not acted on twice. */
async function freshResultData(id: string): Promise<Record<string, any>> {
  const { data, error } = await supabase.from('seo_tasks').select('result_data').eq('id', id).single()
  if (error) throw error
  const rd = (data?.result_data ?? {}) as Record<string, any>
  if (rd.review_required !== true) throw new Error('This item was already handled (in another tab or by an agent). Refresh the inbox.')
  return rd
}

/** Reject = leave every queue with the reason recorded. Never a DELETE. */
async function rejectItem(it: InboxItem, reason: string): Promise<void> {
  const now = new Date().toISOString()
  let res
  if (it.kind === 'rec') {
    res = await supabase.from('strategic_recommendations').update({ status: 'dismissed', draft_error: `rejected by Erez: ${reason}`, updated_at: now }).eq('id', it.id).eq('status', it.status)
  } else if (it.kind === 'campaign') {
    res = await supabase.from('campaigns').update({ status: 'archived' }).eq('id', it.id).eq('status', 'draft')
  } else if (it.kind === 'task') {
    const rd = await freshResultData(it.id)
    res = await supabase.from('seo_tasks').update({ result_data: { ...rd, review_required: false, rejected_via_ui_at: now, reject_reason: reason } }).eq('id', it.id)
  } else {
    res = await supabase.from('strategist_signals').update({ status: 'declined', decline_reason: reason, updated_at: now }).eq('id', it.id).eq('status', 'open')
  }
  if (res.error) throw res.error
}

/** Approve = the item's existing "yes" (never publishes, except IG which confirms). */
async function approveItem(it: InboxItem): Promise<void> {
  const now = new Date().toISOString()
  if (it.kind === 'rec') {
    // proposed → executor drafts it; ready_for_review → you handled it; needs_human → draft it anyway
    const next = it.status === 'proposed' ? 'approved' : it.status === 'ready_for_review' ? 'drafted' : 'exporting'
    const { error } = await supabase.from('strategic_recommendations').update({ status: next, updated_at: now }).eq('id', it.id).eq('status', it.status)
    if (error) throw error
  } else if (it.kind === 'signal') {
    const { error } = await supabase.from('strategist_signals').update({ status: 'approved', updated_at: now }).eq('id', it.id).eq('status', 'open')
    if (error) throw error
  } else if (it.kind === 'task') {
    // Ask first, THEN read: the dialog can stay open for minutes, and the
    // fresh read must reflect the state at the moment we act.
    if (it.raw.task_type === 'instagram_post' && !window.confirm('Publish this post LIVE to @minuto_cafe now? It goes public immediately.')) return
    const rd = await freshResultData(it.id)
    if (it.raw.task_type === 'instagram_post') {
      if (!rd.ig_creation_id) throw new Error('No staged Instagram container on this post, nothing to publish.')
      const { data, error } = await supabase.functions.invoke('meta-publish', { body: { action: 'publish', creation_id: rd.ig_creation_id } })
      if (error) throw error
      if (data && data.success === false) throw new Error(data.error ?? 'meta-publish returned success:false')
      const { error: upErr } = await supabase.from('seo_tasks').update({ result_data: { ...rd, review_required: false, published_via_ui_at: now,
        ig_media_id: data?.media_id ?? rd.ig_media_id ?? null, ig_permalink: data?.permalink ?? rd.ig_permalink ?? null } }).eq('id', it.id)
      if (upErr) throw upErr
    } else {
      const { error } = await supabase.from('seo_tasks').update({ result_data: { ...rd, review_required: false, accepted_via_ui_at: now } }).eq('id', it.id)
      if (error) throw error
    }
  }
}

function approveLabel(it: InboxItem): string | null {
  if (it.kind === 'campaign') return null            // reviewed and sent from Marketing
  if (it.kind === 'rec') return it.status === 'proposed' ? 'Approve' : it.status === 'ready_for_review' ? 'Done' : 'Draft it anyway'
  if (it.kind === 'task' && it.raw.task_type === 'instagram_post') {
    const fresh = Date.now() - new Date(it.raw.result_data?.prepared_at ?? it.created).getTime() < IG_CONTAINER_TTL_MS
    return it.raw.result_data?.ig_creation_id && fresh ? 'Publish' : null   // expired container: only reject makes sense
  }
  return 'Accept'
}

const METRIC_LABEL: Record<string, string> = {
  bean_revenue: 'bean revenue', orders: 'orders', repeat_purchase_rate: 'repeat purchase rate',
  roas: 'ROAS', cpa: 'cost per acquisition', email_ctr: 'email click rate', organic_sessions: 'organic sessions',
}

/** Only http(s) links are rendered as links: sources come from web research. */
function safeHref(u: unknown): string | null {
  try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null } catch { return null }
}

function PitchDetails({ s }: { s: Record<string, any> }) {
  const steps: unknown[] = Array.isArray(s.implementation_steps) ? s.implementation_steps : []
  const sources: Array<Record<string, unknown>> = Array.isArray(s.sources) ? s.sources : []
  return (
    <div className="mt-1.5 text-[12px] text-surface-700 space-y-1" dir="auto">
      <div className="flex flex-wrap gap-x-3 text-surface-500">
        {s.check_metric && <span>Should move: <b>{Object.prototype.hasOwnProperty.call(METRIC_LABEL, String(s.check_metric)) ? METRIC_LABEL[String(s.check_metric)] : String(s.check_metric)}</b></span>}
        {s.effort && <span>Effort: {String(s.effort)}</span>}
        {s.cost_estimate && <span>Cost: {String(s.cost_estimate)}</span>}
      </div>
      {steps.length > 0 && (
        <ol className="list-decimal pl-4">{steps.slice(0, 8).map((x, i) => <li key={i}>{String(x)}</li>)}</ol>
      )}
      {sources.length > 0 && (
        <div className="flex flex-wrap gap-x-3">
          {sources.slice(0, 5).map((src, i) => {
            const href = safeHref(src?.url)
            const label = String(src?.title ?? src?.url ?? 'source').slice(0, 80) + (src?.published ? ` (${String(src.published).slice(0, 10)})` : '')
            return href
              ? <a key={i} href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-700 underline">{label}</a>
              : <span key={i}>{label}</span>
          })}
        </div>
      )}
    </div>
  )
}

export function guidePrompt(it: InboxItem): string {
  return `About this item waiting for my approval (${it.group}, ${ageLabel(it.created)}):\n"${it.title}"\n${it.detail ? it.detail.slice(0, 400) + '\n' : ''}\nMy guidance: `
}

export default function ApprovalInbox({ onGuide }: { onGuide: (text: string) => void }) {
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try { setError(null); setItems(await loadInbox()); setSelected(new Set()) }
    catch (e: any) { setError(e?.message ?? String(e)) }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const groups = useMemo(() => {
    const m = new Map<string, InboxItem[]>()
    for (const it of items ?? []) { const arr = m.get(it.group); if (arr) arr.push(it); else m.set(it.group, [it]) }
    return [...m.entries()]
  }, [items])

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    try { await fn() }
    catch (e: any) { window.alert(e?.message ?? String(e)) }
    // Always reload: a bulk reject that fails half-way has still changed rows.
    finally { await refresh(); setBusy(false) }
  }
  const reject = (list: InboxItem[]) => {
    const reason = window.prompt(`Reject ${list.length} item(s)? They leave every queue (nothing is deleted).\n\nReason:`, 'Not relevant any more')
    if (!reason) return
    run(async () => { for (const it of list) await rejectItem(it, reason) })
  }
  const toggle = (key: string) => setSelected(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  const toggleGroup = (list: InboxItem[]) => setSelected(s => {
    const n = new Set(s); const all = list.every(i => n.has(i.key))
    for (const i of list) all ? n.delete(i.key) : n.add(i.key)
    return n
  })
  const chosen = (items ?? []).filter(i => selected.has(i.key))

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-surface-200 bg-white shrink-0">
        <span className="text-sm font-semibold text-surface-900">Waiting for you: {items?.length ?? '…'}</span>
        <button onClick={refresh} disabled={busy} className="ml-auto inline-flex items-center gap-1 text-xs text-surface-600 hover:text-surface-900 disabled:opacity-50"><RefreshCw size={12} /> refresh</button>
        {chosen.length > 0 && (
          <button onClick={() => reject(chosen)} disabled={busy} className="inline-flex items-center gap-1 text-xs text-red-700 hover:text-red-900 disabled:opacity-50"><X size={12} /> reject {chosen.length} selected</button>
        )}
      </div>
      {error && <div className="px-4 py-2 text-xs text-red-700">{error}</div>}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-5">
        {items && items.length === 0 && <div className="text-sm text-surface-500">Nothing is waiting for you.</div>}
        {groups.map(([group, list]) => (
          <section key={group}>
            <div className="flex items-center gap-2 mb-2">
              <input type="checkbox" aria-label={`select all in ${group}`} checked={list.every(i => selected.has(i.key))} onChange={() => toggleGroup(list)} />
              <h3 className="text-xs font-semibold uppercase tracking-wide text-surface-500">{group} ({list.length})</h3>
            </div>
            <ul className="space-y-2">
              {list.map(it => {
                const ok = approveLabel(it)
                return (
                  <li key={it.key} className="rounded-lg border border-surface-200 p-3 text-sm bg-white">
                    <div className="flex items-start gap-2">
                      <input type="checkbox" className="mt-1" aria-label="select" checked={selected.has(it.key)} onChange={() => toggle(it.key)} />
                      {it.imageUrl && <img src={it.imageUrl} alt="" className="w-14 h-14 object-cover rounded shrink-0" loading="lazy" />}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-surface-900 break-words" dir="auto">{it.title}</div>
                        {it.detail && <div className="text-[12px] text-surface-600 mt-0.5 line-clamp-3" dir="auto">{it.detail}</div>}
                        {it.kind === 'signal' && it.raw.kind === 'innovation_pitch' && <PitchDetails s={it.raw} />}
                        <div className="text-[11px] text-surface-400 mt-1">{ageLabel(it.created)}</div>
                        <div className="flex flex-wrap items-center gap-3 mt-2">
                          {ok && <button onClick={() => run(() => approveItem(it))} disabled={busy} className="inline-flex items-center gap-1 text-xs text-green-700 hover:text-green-900 disabled:opacity-50"><Check size={12} /> {ok}</button>}
                          <button onClick={() => reject([it])} disabled={busy} className="inline-flex items-center gap-1 text-xs text-red-700 hover:text-red-900 disabled:opacity-50"><X size={12} /> Reject</button>
                          <button onClick={() => onGuide(guidePrompt(it))} className="inline-flex items-center gap-1 text-xs text-brand-700 hover:text-brand-900"><MessageSquare size={12} /> Guide the agent</button>
                          {it.link && <a href={it.link} className="inline-flex items-center gap-1 text-xs text-surface-600 hover:text-surface-900"><ExternalLink size={12} /> open</a>}
                        </div>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
