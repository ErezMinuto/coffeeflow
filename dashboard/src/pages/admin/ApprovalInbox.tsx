// Approvals inbox: everything the agents are waiting on Erez for, in one list.
//
// Sources (the same queues the daily approval email and NeedsYou count):
//   • strategic_recommendations  proposed / ready_for_review / needs_human
//   • campaigns                  status='draft'   (email drafts, never sent from here)
//   • seo_tasks                  result_data.review_required = true (IG posts, visuals, tech SEO)
//   • strategist_signals         status='open'    (bugs, capability requests, ideas)
//   • site_change_log            status='proposed' (live site edits filed by the agent chat)
//
// Every item can be approved, rejected with a reason, or handed to the agent
// chat ("guide") with its context prefilled. Rejecting never deletes: rows get a
// dismissed/declined/archived status or review_required=false plus the reason,
// so anything can be restored. Three actions go live, and each asks for
// confirmation first: publishing an Instagram post, approving a site change, and
// adding a proposed FAQ to its page. Site changes are backed up and can be undone
// from the "recent site changes" list at the bottom (SEO agent build plan, Phase 0).

import { toast } from 'sonner'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Check, X, MessageSquare, ExternalLink, ChevronLeft, AlertCircle, Undo2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { PanelHead, RefreshButton, LoadingRows, Empty, Tag } from './seoUi'
import { ImageLightbox } from '../../components/shared/ImageLightbox'

type Kind = 'rec' | 'campaign' | 'task' | 'signal' | 'change'

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
  imageUrls?: string[]     // every image to show full size (a carousel's slides)
  link?:    string
  targetUrl?: string        // the live page this item is about (external, opens in a new tab)
  raw:      Record<string, any>
}

/** Hebrew slugs arrive percent-encoded; show them readable. Never throws on a malformed sequence. */
function readableUrl(u: string): string { try { return decodeURIComponent(u) } catch { return u } }

const clip = (s: unknown, n = 120) => { const x = String(s ?? '').trim(); return x.length > n ? x.slice(0, n) + '…' : x }

const DESTINATION_LABEL: Record<string, string> = { ig_post: 'אינסטגרם', blog_banner: 'באנר לבלוג' }

const SIGNAL_KIND_LABEL: Record<string, string> = { capability_request: 'בקשת יכולת', bug_report: 'דיווח על תקלה', feature_idea: 'רעיון לפיצ׳ר' }

/** What a waiting seo_task IS, in words: each task type keeps its meaning in different fields. */
// Every image a task produced, for the full-size viewer: a carousel's slides
// in order, else the single image.
function taskImages(t: Record<string, any>): string[] {
  const slides = Array.isArray(t.result_data?.carousel_slides) ? t.result_data.carousel_slides : []
  const urls = slides.map((s: any) => s?.image_url).filter((u: unknown): u is string => typeof u === 'string' && u.length > 0)
  if (urls.length) return urls
  return typeof t.result_data?.image_url === 'string' && t.result_data.image_url ? [t.result_data.image_url] : []
}

function describeTask(t: Record<string, any>): { group: string; title: string; detail: string; targetUrl?: string } {
  const rd = t.result_data ?? {}, bd = t.brief_data ?? {}
  if (t.task_type === 'technical_seo') {
    const subtype = rd.subtype ?? bd.subtype ?? t.task_subtype
    const url = safeHref(rd.target_post_url ?? bd.target_post_url) ?? undefined
    const page = rd.article_title || (url ? readableUrl(new URL(url).pathname) : 'מאמר בבלוג')
    if (subtype === 'faq_injection') {
      const n = Array.isArray(rd.proposed_faq) ? rd.proposed_faq.length : rd.faq_count ?? 0
      const visits = rd.rationale_signal?.ga4_organic_sessions_30d ?? bd.rationale_signal?.ga4_organic_sessions_30d
      return { group: 'SEO טכני', targetUrl: url,
        title: `הצעת FAQ למאמר: ${clip(page)}`,
        detail: `הסוכן כתב ${n} שאלות ותשובות להוספה למאמר כקטע FAQ עם סכמת FAQ` +
          (visits != null ? ` (לעמוד היו ${visits} ביקורים אורגניים ב-30 הימים האחרונים).` : '.') +
          (rd.faq_written ? ' כבר מופיע בעמוד החי.' : ' עדיין לא בעמוד החי.') }
    }
    return { group: 'SEO טכני', targetUrl: url, title: `SEO טכני (${subtype ?? 'סוג לא ידוע'}): ${clip(page)}`, detail: rd.review_reason ?? t.rationale ?? '' }
  }
  if (t.task_type === 'instagram_post') {
    const kind = rd.media_type === 'story' || bd.media_type === 'story' ? 'סטורי אינסטגרם' : rd.media_type === 'carousel' || bd.media_type === 'carousel' ? 'קרוסלה באינסטגרם' : 'פוסט אינסטגרם'
    return { group: 'פוסטים לאינסטגרם', title: `${kind}: ${clip(bd.caption_he ?? rd.caption) || '(ללא כיתוב)'}`,
      detail: [rd.qa_flagged === true ? 'התמונה לא עברה את בקרת האיכות האוטומטית.' : '', rd.review_reason ?? ''].filter(Boolean).join(' ') || 'מוכן באינסטגרם וממתין לפרסום.' }
  }
  if (t.task_type === 'visual_generation') {
    const dest = DESTINATION_LABEL[String(bd.destination ?? rd.destination)] ?? String(bd.destination ?? rd.destination ?? 'תמונה')
    const c = rd.qa_last_critique ?? {}
    const text = (x: unknown) => typeof x === 'string' ? x : JSON.stringify(x)
    const problems = [...(Array.isArray(c.issues) ? c.issues.map(text) : []), ...(Array.isArray(c.missing) ? c.missing.map((m: unknown) => `חסר: ${text(m)}`) : [])]
    return { group: 'תמונות', targetUrl: safeHref(rd.wp_edit_url) ?? undefined,
      title: `תמונה עבור ${dest}: ${clip(bd.scene_brief ?? bd.caption_he ?? bd.shot_type) || '(ללא תדריך)'}`,
      detail: rd.review_reason ?? (problems.length ? `נכשלה בבקרת האיכות האוטומטית: ${clip(problems.join('; '), 300)}` : rd.attach_skipped_reason ?? rd.qa_summary ?? '') }
  }
  return { group: String(t.task_type), title: clip(bd.title ?? bd.keyword ?? bd.caption_he ?? bd.scene_brief ?? t.rationale) || String(t.task_subtype ?? t.task_type),
    detail: rd.review_reason ?? rd.qa_summary ?? t.rationale ?? '' }
}

// Bookkeeping fields that mean nothing to a reviewer.
const HIDDEN_KEYS = new Set(['tokens', 'meta_response', 'render_response', 'qa_attempts', 'review_required', 'ig_creation_id', 'ig_media_id',
  'carousel_children', 'requested_strategy', 'publish_strategy', 'auto_publish_overridden', 'render_function', 'original_render_mode', 'proposed_faq', 'written_faq'])

function humanKey(k: string): string { return k.replace(/_/g, ' ') }

function Value({ v }: { v: unknown }) {
  if (v == null || v === '') return <span className="text-surface-400">אין</span>
  const href = typeof v === 'string' ? safeHref(v) : null
  if (href) return <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-600 underline underline-offset-2 break-all">{readableUrl(v as string)}</a>
  if (Array.isArray(v)) {
    if (v.every(x => typeof x !== 'object' || x === null)) return <span>{v.map(String).join(', ')}</span>
    return <ol className="list-decimal ps-4">{v.slice(0, 10).map((x, i) => <li key={i}><Value v={x} /></li>)}</ol>
  }
  if (typeof v === 'object') return <Fields obj={v as Record<string, unknown>} />
  return <span className="whitespace-pre-wrap break-words">{String(v)}</span>
}

function Fields({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj).filter(([k, v]) => !HIDDEN_KEYS.has(k) && v != null && v !== '')
  if (!entries.length) return <span className="text-surface-400">אין</span>
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
      {entries.map(([k, v]) => <Fragment key={k}><dt className="text-surface-500 font-mono text-[11.5px] pt-px" dir="ltr">{humanKey(k)}</dt><dd className="min-w-0" dir="auto"><Value v={v} /></dd></Fragment>)}
    </dl>
  )
}

function FaqList({ faq }: { faq: unknown }) {
  const list = (Array.isArray(faq) ? faq : []) as Array<{ q?: unknown; a?: unknown }>
  if (!list.length) return null
  return (
    <ol className="list-decimal ps-4 space-y-1.5" dir="rtl">
      {list.map((p, i) => <li key={i}><div className="font-medium text-surface-900">{String(p?.q ?? '')}</div><div className="text-surface-500">{String(p?.a ?? '')}</div></li>)}
    </ol>
  )
}

/** Expandable full brief + result of a task, readable rather than raw JSON. */
function TaskDetails({ t }: { t: Record<string, any> }) {
  const rd = t.result_data ?? {}
  return (
    <details className="mt-1 text-[12.5px] leading-relaxed text-surface-700">
      <summary className="inline-flex items-center gap-1 min-h-8 text-surface-500 hover:text-surface-800 select-none">
        <ChevronLeft size={14} aria-hidden="true" className="chev" /> פרטים
      </summary>
      <div className="mt-1 mb-1 space-y-2.5 rounded-lg border border-surface-200 bg-surface-50 p-3">
        {t.rationale && <div><span className="text-surface-500">למה הסוכן יצר את זה: </span><span dir="auto">{String(t.rationale)}</span></div>}
        {Array.isArray(rd.proposed_faq) && <div><div className="text-surface-500 mb-1">FAQ מוצע (בדיוק מה שיעלה לעמוד):</div><FaqList faq={rd.proposed_faq} /></div>}
        {Array.isArray(rd.written_faq) && <div><div className="text-surface-500 mb-1">FAQ שנכתב לעמוד:</div><FaqList faq={rd.written_faq} /></div>}
        <div><div className="text-surface-500 mb-1">מה הסוכן התבקש לעשות</div><Fields obj={t.brief_data ?? {}} /></div>
        <div><div className="text-surface-500 mb-1">מה הוא הפיק</div><Fields obj={rd} /></div>
      </div>
    </details>
  )
}

const hasUnpublishedFaq = (it: InboxItem) => Array.isArray(it.raw.result_data?.proposed_faq) && it.raw.result_data.proposed_faq.length > 0 && !it.raw.result_data?.faq_written

/** One line under the buttons saying what Accept really does for this task type. */
function acceptNote(it: InboxItem): string | null {
  if (it.kind === 'change') return 'אישור מעלה את השינוי לאתר החי (עם בקשת אישור לפני). הגרסה הקודמת נשמרת, ואפשר לבטל מ"שינויים אחרונים באתר".'
  if (it.kind !== 'task') return null
  if (it.raw.task_type === 'technical_seo') return hasUnpublishedFaq(it)
    ? 'הוספה לעמוד מעלה את השאלות והתשובות שבפרטים לעמוד החי (עם בקשת אישור לפני). ה-FAQ הקודם נשמר, ואפשר לבטל מ"שינויים אחרונים באתר". לשינוי הניסוח: הנחיה לסוכן.'
    : 'סימון כנבדק רק מוציא את הפריט מהתיבה, ושום דבר אחר לא רץ.'
  if (it.raw.task_type === 'visual_generation') return 'סימון כנבדק רק מנקה את סימון האיכות. התמונה לא מצורפת ולא מתפרסמת בשום מקום.'
  if (it.raw.task_type === 'instagram_post') return 'פרסום מעלה את הפוסט ל-@minuto_cafe (עם בקשת אישור לפני).'
  return 'אישור רק מוציא את הפריט מהתיבה, ושום דבר אחר לא רץ.'
}

const DAY = 86_400_000
const IG_CONTAINER_TTL_MS = 23 * 3600 * 1000   // Meta expires prepared containers after ~24h

function ageLabel(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / DAY)
  return d <= 0 ? 'היום' : d === 1 ? 'אתמול' : `לפני ${d} ימים`
}

async function loadInbox(): Promise<InboxItem[]> {
  const [recs, camps, tasks, sigs] = await Promise.all([
    supabase.from('strategic_recommendations').select('*')
      .in('status', ['proposed', 'ready_for_review', 'needs_human']).order('created_at', { ascending: false }).limit(200),
    supabase.from('campaigns').select('id, subject, preheader, created_at, campaign_type, status')
      .eq('status', 'draft').order('created_at', { ascending: false }).limit(200),
    supabase.from('seo_tasks').select('id, task_type, task_subtype, brief_data, result_data, rationale, created_at, status')
      .eq('result_data->>review_required', 'true').order('created_at', { ascending: false }).limit(500),
    // '*' so the inbox also works before the innovation_pitch columns exist.
    supabase.from('strategist_signals').select('*')
      .eq('status', 'open').order('created_at', { ascending: false }).limit(200),
  ])
  // Surface a failed source instead of silently showing an emptier inbox.
  const failed = [['המלצות', recs], ['טיוטות מייל', camps], ['משימות תוכן', tasks], ['בקשות הסוכן', sigs]]
    .filter(([, r]) => (r as { error: unknown }).error).map(([n]) => n)
  if (failed.length) throw new Error(`לא ניתן לטעון: ${failed.join(', ')}. כדאי לרענן ולנסות שוב.`)
  const out: InboxItem[] = []
  // Proposed live-site changes. Optional source: before its migration the
  // table doesn't exist, and the rest of the inbox must still load.
  const changes = await supabase.from('site_change_log').select('*')
    .eq('status', 'proposed').order('created_at', { ascending: false }).limit(200)
  for (const c of (changes.error ? [] : changes.data ?? []) as any[]) {
    out.push({ key: `change:${c.id}`, kind: 'change', id: c.id, group: 'שינויים באתר החי: ממתינים לאישור',
      title: `${CHANGE_LABEL[c.target_type] ?? c.target_type}: ${clip(c.target_title || (c.target_url ? readableUrl(c.target_url) : `#${c.target_id}`))}`,
      detail: c.reason ?? '', status: c.status, created: c.created_at, targetUrl: safeHref(c.target_url) ?? undefined, raw: c })
  }
  for (const r of (recs.data ?? []) as any[]) {
    const group = r.status === 'proposed' ? 'רעיונות של האסטרטג: אישור יוצר טיוטה'
      : r.status === 'ready_for_review' ? 'טיוטות של האסטרטג: עברו בדיקה' : 'טיוטות של האסטרטג: לא עברו בדיקה'
    out.push({ key: `rec:${r.id}`, kind: 'rec', id: r.id, group, title: r.title, status: r.status, created: r.created_at,
      detail: [r.action_type !== 'none' ? `[${r.action_type}]` : '', r.rationale ?? '', r.draft_error ?? ''].filter(Boolean).join(' '), raw: r })
  }
  for (const c of (camps.data ?? []) as any[]) {
    out.push({ key: `campaign:${c.id}`, kind: 'campaign', id: String(c.id), group: 'טיוטות מייל (לא נשלחו)', title: c.subject || '(ללא נושא)',
      detail: c.preheader ?? '', status: c.status, created: c.created_at, link: '/marketing?tab=history', raw: c })
  }
  for (const t of (tasks.data ?? []) as any[]) {
    const d = describeTask(t)
    out.push({ key: `task:${t.id}`, kind: 'task', id: t.id, group: `${d.group}: ממתינים לבדיקה`,
      title: d.title, detail: d.detail, status: t.status, created: t.created_at,
      targetUrl: d.targetUrl, imageUrl: t.result_data?.image_url ?? t.result_data?.carousel_slides?.[0]?.image_url,
      imageUrls: taskImages(t), raw: t })
  }
  for (const s of (sigs.data ?? []) as any[]) {
    out.push({ key: `signal:${s.id}`, kind: 'signal', id: s.id,
      group: s.kind === 'innovation_pitch' ? 'הצעות חדשנות: כלים ושיטות חדשים' : `בקשות הסוכן: ${SIGNAL_KIND_LABEL[s.kind] ?? s.kind.replace('_', ' ')}`, title: s.title,
      detail: [s.detail ?? '', s.leverage ? `תועלת: ${s.leverage}` : ''].filter(Boolean).join(' '), status: s.status, created: s.created_at, raw: s })
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
  if (rd.review_required !== true) throw new Error('הפריט הזה כבר טופל (בלשונית אחרת או על ידי סוכן). כדאי לרענן את התיבה.')
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
  } else if (it.kind === 'change') {
    await siteAction({ action: 'site_change.reject', change_id: it.id, reason })
    return
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
  if (it.kind === 'change') {
    if (!window.confirm('להעלות את השינוי הזה לאתר החי עכשיו? הגרסה הקודמת נשמרת ואפשר לבטל.')) return
    await siteAction({ action: 'site_change.approve', change_id: it.id })
    toast.success('השינוי עלה לאתר')
    return
  }
  if (it.kind === 'task' && it.raw.task_type === 'technical_seo' && hasUnpublishedFaq(it)) {
    if (!window.confirm('להוסיף את ה-FAQ לעמוד החי עכשיו? ה-FAQ הקודם (אם יש) נשמר ואפשר לבטל.')) return
    await freshResultData(it.id)
    await siteAction({ action: 'faq_task.approve', task_id: it.id })
    toast.success('ה-FAQ עלה לעמוד. אם WP Rocket שומר עותק במטמון, צריך לנקות אותו כדי לראות.')
    return
  }
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
    if (it.raw.task_type === 'instagram_post' && !window.confirm('לפרסם את הפוסט עכשיו ב-@minuto_cafe? הוא עולה לאוויר מיד.')) return
    const rd = await freshResultData(it.id)
    if (it.raw.task_type === 'instagram_post') {
      if (!rd.ig_creation_id) throw new Error('אין לפוסט הזה פוסט מוכן באינסטגרם, אז אין מה לפרסם.')
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
  if (it.kind === 'rec') return it.status === 'proposed' ? 'אישור' : it.status === 'ready_for_review' ? 'טופל' : 'ליצור טיוטה בכל זאת'
  if (it.kind === 'task' && it.raw.task_type === 'instagram_post') {
    const fresh = Date.now() - new Date(it.raw.result_data?.prepared_at ?? it.created).getTime() < IG_CONTAINER_TTL_MS
    return it.raw.result_data?.ig_creation_id && fresh ? 'פרסום' : null   // expired container: only reject makes sense
  }
  if (it.kind === 'change') return 'אישור והעלאה'
  if (it.kind === 'task' && it.raw.task_type === 'technical_seo' && hasUnpublishedFaq(it)) return 'הוספה לעמוד'
  // These only clear the review flag; the label must not suggest a fix is applied.
  if (it.kind === 'task' && (it.raw.task_type === 'technical_seo' || it.raw.task_type === 'visual_generation')) return 'סימון כנבדק'
  return 'אישור'
}

const METRIC_LABEL: Record<string, string> = {
  bean_revenue: 'הכנסות מפולים', orders: 'הזמנות', repeat_purchase_rate: 'שיעור רכישה חוזרת',
  roas: 'ROAS', cpa: 'עלות לרכישה', email_ctr: 'שיעור הקלקה במייל', organic_sessions: 'ביקורים אורגניים',
}

/** Only http(s) links are rendered as links: sources come from web research. */
function safeHref(u: unknown): string | null {
  try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null } catch { return null }
}

function PitchDetails({ s }: { s: Record<string, any> }) {
  const steps: unknown[] = Array.isArray(s.implementation_steps) ? s.implementation_steps : []
  const sources: Array<Record<string, unknown>> = Array.isArray(s.sources) ? s.sources : []
  return (
    <div className="mt-1.5 text-[12.5px] leading-relaxed text-surface-700 space-y-1">
      <div className="flex flex-wrap gap-x-3 text-surface-500">
        {s.check_metric && <span>אמור להזיז: <b className="font-medium text-surface-700">{Object.prototype.hasOwnProperty.call(METRIC_LABEL, String(s.check_metric)) ? METRIC_LABEL[String(s.check_metric)] : String(s.check_metric)}</b></span>}
        {s.effort && <span>מאמץ: <span dir="auto">{String(s.effort)}</span></span>}
        {s.cost_estimate && <span>עלות: <span dir="auto">{String(s.cost_estimate)}</span></span>}
      </div>
      {steps.length > 0 && (
        <ol className="list-decimal ps-4" dir="auto">{steps.slice(0, 8).map((x, i) => <li key={i}>{String(x)}</li>)}</ol>
      )}
      {sources.length > 0 && (
        <div className="flex flex-wrap gap-x-3">
          {sources.slice(0, 5).map((src, i) => {
            const href = safeHref(src?.url)
            const label = String(src?.title ?? src?.url ?? 'מקור').slice(0, 80) + (src?.published ? ` (${String(src.published).slice(0, 10)})` : '')
            return href
              ? <a key={i} href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-brand-600 underline underline-offset-2" dir="auto">{label}</a>
              : <span key={i} dir="auto">{label}</span>
          })}
        </div>
      )}
    </div>
  )
}

const CHANGE_LABEL: Record<string, string> = {
  post_faq: 'FAQ במאמר', product_faq: 'FAQ במוצר', product_description: 'תיאור מוצר',
  post_content: 'תוכן מאמר', post_featured_image: 'תמונה ראשית למאמר',
}
const CHANGE_STATUS: Record<string, string> = { applied: 'עלה לאתר', undone: 'בוטל', failed: 'נכשל', rejected: 'נדחה', applying: 'בתהליך' }

/** Approve / reject / undo a live site change. Signed-in admin only: the
 *  function refuses anything else, so the click itself is the approval. */
export async function siteAction(body: Record<string, unknown>): Promise<Record<string, any>> {
  const { data, error } = await supabase.functions.invoke('handle-seo-chat', { body })
  if (error) {
    let detail: Record<string, any> = {}
    try { detail = await (error as any).context?.json?.() ?? {} } catch { /* no body */ }
    const e = new Error(detail.error ?? error.message) as Error & { detail?: Record<string, any> }
    e.detail = detail
    throw e
  }
  if (data && data.ok === false) throw new Error(data.error ?? 'הפעולה נכשלה')
  return data ?? {}
}

/** The value a change writes (or wrote), readable. */
function ChangeValue({ type, v }: { type: string; v: unknown }) {
  if (type === 'post_faq' || type === 'product_faq') {
    return Array.isArray(v) && v.length ? <FaqList faq={v} /> : <span className="text-surface-400">ללא FAQ</span>
  }
  if (type === 'post_featured_image') return <span className="num">{Number(v) ? `מדיה #${Number(v)}` : 'ללא תמונה'}</span>
  if (type === 'post_content' && v && typeof v === 'object') return <Fields obj={v as Record<string, unknown>} />
  return <div className="whitespace-pre-wrap break-words max-h-64 overflow-y-auto" dir="auto">{String(v ?? '')}</div>
}

function ChangeDetails({ c }: { c: Record<string, any> }) {
  return (
    <details className="mt-1 text-[12.5px] leading-relaxed text-surface-700">
      <summary className="inline-flex items-center gap-1 min-h-8 text-surface-500 hover:text-surface-800 select-none">
        <ChevronLeft size={14} aria-hidden="true" className="chev" /> פרטים
      </summary>
      <div className="mt-1 mb-1 space-y-2.5 rounded-lg border border-surface-200 bg-surface-50 p-3">
        <div><div className="text-surface-500 mb-1">מה יעלה לאתר</div><ChangeValue type={c.target_type} v={c.after} /></div>
        {c.before != null && <div><div className="text-surface-500 mb-1">מה היה לפני</div><ChangeValue type={c.target_type} v={c.before} /></div>}
        {c.requested_by && <div className="text-surface-500">ביקש: <span dir="auto">{String(c.requested_by)}</span></div>}
      </div>
    </details>
  )
}

/** Changes made to the live site in the last 30 days, each with an Undo. */
function RecentChanges({ busy, run }: { busy: boolean; run: (fn: () => Promise<void>) => void }) {
  const [rows, setRows] = useState<Record<string, any>[] | null>(null)
  const [missing, setMissing] = useState(false)
  const load = useCallback(async () => {
    const since = new Date(Date.now() - 30 * DAY).toISOString()
    const { data, error } = await supabase.from('site_change_log').select('*')
      .in('status', ['applied', 'undone', 'failed']).gte('created_at', since)
      .order('created_at', { ascending: false }).limit(100)
    if (error) { setMissing(true); setRows([]); return }
    setRows(data ?? [])
  }, [])
  useEffect(() => { load() }, [load, busy])
  if (missing || !rows || rows.length === 0) return null

  const undo = (c: Record<string, any>) => run(async () => {
    if (!window.confirm('לבטל את השינוי ולהחזיר את הגרסה הקודמת לאתר?')) return
    try {
      await siteAction({ action: 'site_change.undo', change_id: c.id })
    } catch (e: any) {
      if (!e?.detail?.can_force) throw e
      if (!window.confirm(`${e.message}\n\nלבטל בכל זאת? השינוי המאוחר יותר יימחק.`)) return
      await siteAction({ action: 'site_change.undo', change_id: c.id, force: true })
    }
    toast.success('השינוי בוטל והגרסה הקודמת חזרה לאתר')
  })

  return (
    <section className="border-t border-surface-200">
      <h3 className="flex items-center min-h-[44px] px-4 bg-surface-50 border-b border-surface-200 text-[13px] font-semibold text-surface-700">שינויים אחרונים באתר (30 יום)</h3>
      <ul className="divide-y divide-surface-200">
        {rows.map(c => (
          <li key={c.id} className="px-4 pt-3 pb-2">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0 text-[14px] leading-snug text-surface-900 break-words" dir="auto">
                {CHANGE_LABEL[c.target_type] ?? c.target_type}: {clip(c.target_title || (c.target_url ? readableUrl(c.target_url) : `#${c.target_id}`))}
              </div>
              <Tag tone={c.status === 'failed' ? 'warn' : undefined}>{CHANGE_STATUS[c.status] ?? c.status}</Tag>
              <span className="text-[12px] text-surface-400 shrink-0 pt-0.5">{ageLabel(c.created_at)}</span>
            </div>
            {(c.reason || c.error) && <div className="text-[13px] text-surface-500 mt-1 line-clamp-2" dir="auto">{c.error ?? c.reason}</div>}
            <ChangeDetails c={c} />
            {c.status === 'applied' && c.before_source !== 'none' && (
              <div className="-ms-2.5"><button type="button" onClick={() => undo(c)} disabled={busy} className="act"><Undo2 size={16} aria-hidden="true" /> ביטול השינוי</button></div>
            )}
          </li>
        ))}
      </ul>
    </section>
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
  const [viewing, setViewing] = useState<{ images: string[]; label: string } | null>(null)

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
    catch (e: any) { toast.error(e?.message ?? String(e)) }
    // Always reload: a bulk reject that fails half-way has still changed rows.
    finally { await refresh(); setBusy(false) }
  }
  const reject = (list: InboxItem[]) => {
    const reason = window.prompt(`לדחות ${list.length === 1 ? 'פריט אחד' : `${list.length} פריטים`}? הם יוצאים מכל התורים (שום דבר לא נמחק).\n\nסיבה:`, 'Not relevant any more')
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
      <PanelHead
        title={<>ממתינים לאישור{items && items.length > 0 && <Tag tone="warn"><span className="num">{items.length}</span></Tag>}</>}
      >
        {chosen.length > 0 && (
          <button type="button" onClick={() => reject(chosen)} disabled={busy} className="act danger">
            <X size={16} aria-hidden="true" /> דחיית <span className="num">{chosen.length}</span> שנבחרו
          </button>
        )}
        <RefreshButton onClick={refresh} disabled={busy} title="רענון התיבה" />
      </PanelHead>
      {error && (
        <div className="px-4 pt-3 shrink-0">
          <div className="notice notice-danger" role="alert">
            <AlertCircle size={16} aria-hidden="true" className="notice-icon" />
            <span>{error}</span>
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {items === null && !error && <LoadingRows rows={4} label="טוען את התיבה" />}
        {items && items.length === 0 && (
          <Empty>
            <Check size={18} aria-hidden="true" className="mx-auto mb-2 text-ok" />
            אין כרגע שום דבר שממתין לאישור.
          </Empty>
        )}
        {groups.map(([group, list]) => {
          const allChosen = list.every(i => selected.has(i.key))
          return (
            <section key={group} className="border-b border-surface-200 last:border-b-0">
              <label className="sticky top-0 z-[1] flex items-center gap-3 min-h-[44px] px-4 bg-surface-50 border-b border-surface-200 cursor-pointer">
                <input type="checkbox" aria-label={`בחירת הכול ב${group}`} checked={allChosen} onChange={() => toggleGroup(list)} />
                <h3 className="text-[13px] font-semibold text-surface-700 min-w-0 truncate">{group}</h3>
                <span className="text-[12.5px] text-surface-500 num">{list.length}</span>
              </label>
              <ul className="divide-y divide-surface-200">
                {list.map(it => {
                  const ok = approveLabel(it)
                  const note = acceptNote(it)
                  return (
                    <li key={it.key} className={`px-4 pt-3 pb-2 transition-colors ${selected.has(it.key) ? 'bg-brand-50' : ''}`}>
                      <div className="flex items-start gap-3">
                        <input type="checkbox" className="mt-[3px] shrink-0" aria-label={`בחירה: ${it.title}`} checked={selected.has(it.key)} onChange={() => toggle(it.key)} />
                        {it.imageUrl && (
                          <button
                            type="button"
                            onClick={() => setViewing({ images: it.imageUrls?.length ? it.imageUrls : [it.imageUrl!], label: it.title })}
                            className="relative shrink-0 rounded-md cursor-zoom-in focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
                            aria-label={`הצגת התמונה בגודל מלא: ${it.title}`}
                          >
                            <img src={it.imageUrl} alt="" className="w-14 h-14 object-cover rounded-md border border-surface-200" loading="lazy" />
                            {(it.imageUrls?.length ?? 0) > 1 && (
                              <span className="absolute bottom-0.5 end-0.5 rounded bg-black/70 px-1 text-[10.5px] leading-4 text-white num">{it.imageUrls!.length}</span>
                            )}
                          </button>
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start gap-3">
                            <div className="flex-1 min-w-0 text-[14px] font-medium leading-snug text-surface-900 break-words" dir="auto">{it.title}</div>
                            <span className="text-[12px] text-surface-400 shrink-0 pt-0.5">{ageLabel(it.created)}</span>
                          </div>
                          {it.detail && (() => {
                            // Strategist items start with "[action_type] ": show it as a tag so
                            // the bracketed English token doesn't flip the Hebrew line's direction.
                            const m = it.kind === 'rec' ? /^\[([a-z_]+)\] ?/.exec(it.detail) : null
                            const rest = m ? it.detail.slice(m[0].length) : it.detail
                            return (
                              <>
                                {m && <div className="mt-1"><Tag mono>{m[1]}</Tag></div>}
                                {rest && <div className="text-[13px] leading-relaxed text-surface-500 mt-1 line-clamp-3" dir="auto">{rest}</div>}
                              </>
                            )
                          })()}
                          {it.targetUrl && (
                            <a href={it.targetUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-brand-600 underline-offset-2 hover:underline mt-1 break-all">
                              <ExternalLink size={12} aria-hidden="true" className="shrink-0" /> <span dir="auto">{readableUrl(it.targetUrl)}</span>
                            </a>
                          )}
                          {it.kind === 'signal' && it.raw.kind === 'innovation_pitch' && <PitchDetails s={it.raw} />}
                          {it.kind === 'task' && <TaskDetails t={it.raw} />}
                          {it.kind === 'change' && <ChangeDetails c={it.raw} />}
                          <div className="flex flex-wrap items-center gap-0.5 mt-1 -ms-2.5">
                            {ok && <button type="button" onClick={() => run(() => approveItem(it))} disabled={busy} className="act primary"><Check size={16} aria-hidden="true" /> {ok}</button>}
                            <button type="button" onClick={() => reject([it])} disabled={busy} className="act danger"><X size={16} aria-hidden="true" /> דחייה</button>
                            <button type="button" onClick={() => onGuide(guidePrompt(it))} className="act"><MessageSquare size={16} aria-hidden="true" /> הנחיה לסוכן</button>
                            {it.link && <a href={it.link} className="act"><ExternalLink size={16} aria-hidden="true" /> פתיחה</a>}
                          </div>
                          {note && <div className="text-[12.5px] leading-relaxed text-surface-500 mb-1">{note}</div>}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
        {items && <RecentChanges busy={busy} run={run} />}
      </div>
      {viewing && <ImageLightbox images={viewing.images} label={viewing.label} onClose={() => setViewing(null)} />}
    </div>
  )
}
