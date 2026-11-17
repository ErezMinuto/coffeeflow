import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, X, Eye, ThumbsUp, Loader2, Flag, AlertTriangle, Check, ChevronLeft, ExternalLink, FlaskConical } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { PanelHead, RefreshButton, LoadingRows, Empty, Tag, Status, stamp, type Tone } from './seoUi'

// Left-panel: live pending-task queue.
//
// Subscribes to seo_tasks via Supabase realtime so when the chat handler
// (or the cron orchestrator) inserts/updates rows, the panel reflects
// without a manual refresh. We keep the row list capped at 50 so a stuck
// queue doesn't slow the panel.

export interface SeoTaskRow {
  id:              string
  task_type:       string
  task_subtype:    string | null
  status:          'pending' | 'processing' | 'completed' | 'failed'
  brief_data:      Record<string, unknown>
  rationale:       string | null
  created_at:      string
  scheduled_for:   string
  error_msg:       string | null
  result_data:     Record<string, unknown> | null
  // A/B experiment membership. Null on manually queued and non-experiment
  // tasks; set by the orchestrator when a task is one arm of a cohort.
  experiment_id:   string | null
  variation_label: string | null
  // An instagram_post's image task. Comes with select('*').
  parent_task_id?: string | null
}

interface Props {
  onTaskAction?: (action: 'view' | 'approve' | 'cancel', task: SeoTaskRow) => void
}

// Queue state as a dot + word. Waiting is neutral, running is olive, done
// is green, failed is red. Attention (review / QA flagged) gets its own tag.
const TASK_STATUS: Record<SeoTaskRow['status'], { tone: Tone; label: string }> = {
  pending:    { tone: 'neutral', label: 'בתור' },
  processing: { tone: 'brand',   label: 'בביצוע' },
  completed:  { tone: 'ok',      label: 'הושלמה' },
  failed:     { tone: 'danger',  label: 'נכשלה' },
}

// Readable names for task types; unknown types show as they are.
const TASK_TYPE_LABEL: Record<string, string> = {
  instagram_post:     'פוסט אינסטגרם',
  visual_generation:  'יצירת תמונה',
  text_generation:    'כתיבת תוכן',
  technical_seo:      'SEO טכני',
  deep_research:      'מחקר מעמיק',
  dynamic_experiment: 'ניסוי',
  mission:            'משימה מתמשכת',
}
const taskLabel = (type: string) => (Object.prototype.hasOwnProperty.call(TASK_TYPE_LABEL, type) ? TASK_TYPE_LABEL[type] : type)

// Hebrew labels for the one-click reject reasons. The stored reason stays the
// English value: the art director reads it back verbatim.
const REJECT_REASON_LABEL: Record<string, string> = {
  'Wrong room / furniture':      'חדר או ריהוט לא נכונים',
  'Unrealistic machine':         'מכונה לא מציאותית',
  'Bad hands':                   'ידיים לא טבעיות',
  'Bad beans or light':          'פולים או תאורה לא טובים',
  'Logo or text on the machine': 'לוגו או טקסט על המכונה',
  'Looks staged or AI':          'נראה מבוים או מלאכותי',
}

export default function SeoTaskQueue({ onTaskAction }: Props) {
  const [tasks, setTasks]   = useState<SeoTaskRow[]>([])
  const [loading, setLoading] = useState(true)
  const [viewing, setViewing] = useState<SeoTaskRow | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null)
  // Every rendered attempt of the image behind the post being reviewed, so
  // the owner can choose which one goes out, not only the last.
  // issues = the structural/brand checks that attempt failed (art director
  // veto list); shown in red so a broken image is a one-click reject.
  const [attemptChoices, setAttemptChoices] = useState<Array<{ attempt: number; image_url: string; issues: string[] }>>([])

  useEffect(() => {
    setAttemptChoices([])
    if (!viewing || viewing.task_type !== 'instagram_post' || !viewing.parent_task_id) return
    let stale = false
    supabase.from('seo_tasks').select('result_data').eq('id', viewing.parent_task_id).maybeSingle()
      .then(({ data }) => {
        if (stale) return
        const attempts = ((data?.result_data as Record<string, unknown> | null)?.qa_attempts ?? []) as Array<{ attempt?: number; image_url?: string; critique?: { issues?: unknown } }>
        const seen = new Set<string>()
        const choices = attempts
          .filter(a => typeof a.image_url === 'string' && a.image_url && !seen.has(a.image_url) && seen.add(a.image_url))
          .map(a => ({
            attempt: Number(a.attempt ?? 0),
            image_url: a.image_url as string,
            issues: Array.isArray(a.critique?.issues) ? (a.critique!.issues as unknown[]).map(String) : [],
          }))
        setAttemptChoices(choices)
      })
    return () => { stale = true }
  }, [viewing?.id, viewing?.parent_task_id, viewing?.task_type])
  const cancelledRef = useRef(false)

  // Stable loader the realtime sub, polling interval, manual button, and
  // mount-time effect can all share. Wrapped in useCallback so the
  // realtime cleanup doesn't have to depend on a fresh function ref.
  const load = useCallback(async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    const { data } = await supabase
      .from('seo_tasks')
      .select('*')
      .gte('created_at', sevenDaysAgo)
      .order('created_at', { ascending: false })
      .limit(50)
    if (cancelledRef.current) return
    setTasks((data ?? []) as SeoTaskRow[])
    setLoading(false)
    setLastRefreshedAt(new Date())
  }, [])

  // Initial load + realtime subscription + 20s polling fallback. The
  // realtime channel ONLY fires if seo_tasks is in the supabase_realtime
  // publication (migration 20260528_seo_tasks_realtime_publication.sql);
  // even with that in place, polling is a cheap belt-and-suspenders that
  // catches the case where the channel drops or the user's network blips.
  // 20s feels live without flooding PostgREST.
  useEffect(() => {
    cancelledRef.current = false
    load()

    const channel = supabase
      .channel('seo_tasks_queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seo_tasks' }, () => {
        load()
      })
      .subscribe()

    const pollInterval = setInterval(() => {
      load()
    }, 20_000)

    return () => {
      cancelledRef.current = true
      clearInterval(pollInterval)
      supabase.removeChannel(channel)
    }
  }, [load])

  async function handleManualRefresh() {
    setRefreshing(true)
    try { await load() } finally { setRefreshing(false) }
  }

  async function handleCancel(t: SeoTaskRow) {
    const reason = window.prompt(`לבטל את המשימה "${taskLabel(t.task_type)}"?\n\nסיבה:`, 'No longer needed')
    if (!reason) return
    setBusy(t.id)
    try {
      const { error } = await supabase
        .from('seo_tasks')
        .update({ status: 'failed', error_msg: `[ui-cancel] ${reason}`, locked_until: null })
        .eq('id', t.id)
      if (error) throw error
      onTaskAction?.('cancel', t)
    } catch (e) {
      console.error('[SeoTaskQueue] cancel failed:', e)
      toast.error('הביטול נכשל. הפרטים בקונסול.')
    } finally {
      setBusy(null)
    }
  }

  async function handleApprove(t: SeoTaskRow) {
    if (t.task_type !== 'dynamic_experiment') return
    if (!window.confirm(`לאשר את הניסוי "${t.task_subtype ?? t.task_type}"?`)) return
    setBusy(t.id)
    try {
      const { error } = await supabase
        .from('seo_tasks')
        .update({
          status:       'completed',
          result_data:  { approved_via_ui_at: new Date().toISOString() },
          completed_at: new Date().toISOString(),
          locked_until: null,
        })
        .eq('id', t.id)
      if (error) throw error
      onTaskAction?.('approve', t)
    } catch (e) {
      console.error('[SeoTaskQueue] approve failed:', e)
      toast.error('האישור נכשל. הפרטים בקונסול.')
    } finally {
      setBusy(null)
    }
  }

  // Approve & publish an instagram_post: meta-publish already PREPAREd a
  // container (ig_creation_id) when the worker ran; publishing just calls
  // action='publish' with that id, which pushes the post LIVE to @minuto_cafe.
  // This is the human-approval gate — nothing reaches IG without this click.
  async function handlePublishIg(t: SeoTaskRow) {
    const rd = (t.result_data ?? {}) as Record<string, any>
    const creationId = rd.ig_creation_id as string | undefined
    if (!creationId) {
      toast.warning('אין למשימה הזו פוסט מוכן באינסטגרם (ig_creation_id), אז אין מה לפרסם. ייתכן שצריך להכין את הפוסט מחדש.')
      return
    }
    if (!window.confirm('לפרסם את הפוסט עכשיו ב-@minuto_cafe? הוא עולה לאוויר מיד.')) return
    setBusy(t.id)
    try {
      const { data, error } = await supabase.functions.invoke('meta-publish', {
        body: { action: 'publish', creation_id: creationId },
      })
      if (error) throw error
      if (data && data.success === false) throw new Error(data.error ?? 'meta-publish returned success:false')
      const updated = {
        ...rd,
        review_required:      false,
        published_via_ui_at:  new Date().toISOString(),
        ig_media_id:          (data?.media_id as string | undefined) ?? rd.ig_media_id ?? null,
        ig_permalink:         (data?.permalink as string | undefined) ?? rd.ig_permalink ?? null,
      }
      const { error: upErr } = await supabase.from('seo_tasks').update({ result_data: updated }).eq('id', t.id)
      if (upErr) throw upErr
      setViewing(v => (v && v.id === t.id ? { ...v, result_data: updated } : v))
      onTaskAction?.('approve', t)
    } catch (e: any) {
      console.error('[SeoTaskQueue] IG publish failed:', e)
      toast.error(`הפרסום נכשל: ${e?.message ?? e}`)
    } finally {
      setBusy(null)
    }
  }

  // Reject an instagram_post — clears review_required so it leaves the
  // review queue, records the reason. The prepared container is simply left
  // to expire on Meta's side (no publish call), so nothing goes live.
  // An Instagram image task (visual_generation) has no approve button of its
  // own: the post that uses it does. Open that post's review (with Approve &
  // Publish), from the loaded list or, if it fell outside it, from the DB.
  async function openPostFor(t: SeoTaskRow) {
    const loaded = tasks.find(c => c.task_type === 'instagram_post' && c.parent_task_id === t.id)
    if (loaded) { setViewing(loaded); return }
    const { data, error } = await supabase
      .from('seo_tasks').select('*')
      .eq('task_type', 'instagram_post').eq('parent_task_id', t.id)
      .order('created_at', { ascending: false }).limit(1)
    if (error) { toast.error(`לא ניתן לטעון את הפוסט: ${error.message}`); return }
    if (!data?.length) { toast.warning('עדיין אין פוסט אינסטגרם שמשתמש בתמונה הזו.'); return }
    setViewing(data[0] as SeoTaskRow)
  }

  // Choose a different attempt for an IG post: stage a NEW Instagram container
  // with that image and the post's caption (meta-publish 'prepare', nothing
  // goes live), then point the post at it. Approve & Publish then publishes
  // the chosen image. The old container is left to expire on Meta's side.
  async function handleUseAttempt(t: SeoTaskRow, imageUrl: string, attempt: number) {
    const rd = (t.result_data ?? {}) as Record<string, any>
    const brief = (t.brief_data ?? {}) as Record<string, any>
    const mediaType = (rd.media_type as string) ?? (brief.media_type as string) ?? 'feed_image'
    const type = mediaType === 'story' ? 'story' : mediaType === 'feed_image' ? 'feed' : null
    if (!type) { toast.warning(`בחירת תמונה לא נתמכת בפוסטים מסוג ${mediaType}.`); return }
    const caption = (rd.caption as string) ?? (brief.caption_he as string) ?? ''
    if (!window.confirm(`להשתמש בניסיון ${attempt} ל${type === 'story' ? 'סטורי' : 'פוסט'} הזה? הוא יוכן לבדיקה, ושום דבר לא עולה לאוויר לפני לחיצה על "אישור ופרסום".`)) return
    setBusy(t.id)
    try {
      const { data, error } = await supabase.functions.invoke('meta-publish', {
        body: { action: 'prepare', type, image_url: imageUrl, caption },
      })
      if (error) throw error
      const creationId = data?.creation_id as string | undefined
      if (!creationId) throw new Error(data?.error ?? 'meta-publish returned no creation_id')
      const updated = {
        ...rd,
        image_url:        imageUrl,
        ig_creation_id:   creationId,
        chosen_attempt:   attempt,
        chosen_via_ui_at: new Date().toISOString(),
      }
      const { error: upErr } = await supabase.from('seo_tasks').update({ result_data: updated }).eq('id', t.id)
      if (upErr) throw upErr
      setViewing(v => (v && v.id === t.id ? { ...v, result_data: updated } : v))
    } catch (e: any) {
      console.error('[SeoTaskQueue] choose attempt failed:', e)
      toast.error(`לא ניתן להכין את התמונה: ${e?.message ?? e}`)
    } finally {
      setBusy(null)
    }
  }

  // One-click reject reasons (owner + Gemini, 2026-11-13). The reason is
  // read back by the art director (ownerVerdicts) before its next brief.
  const REJECT_REASONS = ['Wrong room / furniture', 'Unrealistic machine', 'Bad hands', 'Bad beans or light', 'Logo or text on the machine', 'Looks staged or AI']
  const [rejecting, setRejecting] = useState(false)
  const [rejectNote, setRejectNote] = useState('')
  useEffect(() => { setRejecting(false); setRejectNote('') }, [viewing?.id])

  async function handleRejectIg(t: SeoTaskRow, reasonIn: string) {
    const reason = reasonIn.trim()
    if (!reason) return
    const rd = (t.result_data ?? {}) as Record<string, any>
    setBusy(t.id)
    try {
      const updated = { ...rd, review_required: false, rejected_via_ui_at: new Date().toISOString(), reject_reason: reason }
      const { error } = await supabase.from('seo_tasks').update({ result_data: updated }).eq('id', t.id)
      if (error) throw error
      setViewing(v => (v && v.id === t.id ? { ...v, result_data: updated } : v))
      onTaskAction?.('cancel', t)
    } catch (e: any) {
      console.error('[SeoTaskQueue] IG reject failed:', e)
      toast.error('הדחייה נכשלה. הפרטים בקונסול.')
    } finally {
      setBusy(null)
    }
  }

  // The dialog is a hand-rolled modal: Escape closes it, focus starts on the
  // close button, and the page behind it does not scroll.
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!viewing) return
    closeRef.current?.focus({ focusVisible: false } as FocusOptions)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setViewing(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [viewing?.id])

  return (
    // `min-h-0` on the flex column + the scroll div is the standard
    // flex-overflow trap fix: without it, children's natural content
    // height pushes the column past h-full and `overflow-y-auto` never
    // kicks in (because there's nothing to overflow against).
    <aside className="h-full flex flex-col min-h-0" aria-label="תור משימות">
      <PanelHead
        title="תור משימות"
        meta={
          <span title={lastRefreshedAt ? `רענון אחרון ${lastRefreshedAt.toLocaleTimeString('he-IL')}. מתרענן אוטומטית כל 20 שניות ובזמן אמת.` : 'משימות מ-7 הימים האחרונים, החדשות למעלה'}>
            {loading ? "7 ימים אחרונים" : `${tasks.length} משימות · 7 ימים`}
          </span>
        }
      >
        <RefreshButton onClick={handleManualRefresh} disabled={refreshing} spinning={refreshing} title="רענון עכשיו" />
      </PanelHead>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <LoadingRows rows={4} />
        ) : tasks.length === 0 ? (
          <Empty>אין משימות מהשבוע האחרון. הסוכן מתכנן משימות פעמיים בשבוע.</Empty>
        ) : (
          <ul className="divide-y divide-surface-200">
            {tasks.map(t => {
              const status = TASK_STATUS[t.status] ?? TASK_STATUS.pending
              // HITL flag set by seo-worker-visual when the QA loop caps
              // without passing. The image is attached best-effort but
              // a human should review and decide whether to re-queue.
              const reviewRequired = t.result_data?.review_required === true
              const qaFlagged = t.task_type === 'instagram_post' && t.result_data?.qa_flagged === true
              return (
                <li key={t.id} className="px-4 pt-3 pb-2 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-50 transition-colors">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-medium text-surface-900 truncate">
                        {taskLabel(t.task_type)}
                        {t.task_subtype && <span className="mr-1.5 font-mono text-[11.5px] font-normal text-surface-500" dir="ltr">{t.task_subtype}</span>}
                      </div>
                    </div>
                    <Status tone={status.tone} label={status.label} />
                  </div>
                  {(reviewRequired || qaFlagged) && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {reviewRequired && (
                        <Tag tone="warn" title="בקרת האיכות לא עברה אחרי 3 ניסיונות. צריך לבדוק את התמונה">
                          <Flag size={12} aria-hidden="true" /> לבדיקה
                        </Tag>
                      )}
                      {qaFlagged && (
                        <Tag tone="danger" title="בקרת האיכות פסלה את התמונה והיא לא נשלחה במייל. כדאי לבדוק היטב לפני פרסום">
                          <AlertTriangle size={12} aria-hidden="true" /> נפסלה בבקרה
                        </Tag>
                      )}
                    </div>
                  )}
                  {t.rationale && (
                    <div className="text-[13px] leading-relaxed text-surface-500 mt-1 line-clamp-2" dir="auto">{t.rationale}</div>
                  )}
                  {t.error_msg && (
                    <div className="text-[13px] leading-relaxed text-danger mt-1 line-clamp-2" dir="auto">{t.error_msg}</div>
                  )}
                  <div className="text-[12px] text-surface-400 mt-1 num flex items-center gap-1.5" dir="ltr">
                    <span>{stamp(t.created_at)}</span><span aria-hidden="true">·</span><span className="font-mono">{t.id.slice(0, 8)}</span>
                  </div>
                  <div className="mt-1 -ms-2.5 flex flex-wrap items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => setViewing(t)}
                      className={`act ${t.task_type === 'instagram_post' && reviewRequired ? 'primary' : ''}`}
                      title={t.task_type === 'instagram_post' ? 'בדיקת הפוסט, אישור ופרסום' : 'צפייה בתדריך'}
                    ><Eye size={16} aria-hidden="true" /> {t.task_type === 'instagram_post' ? 'בדיקה' : 'תדריך'}</button>
                    {t.task_type === 'visual_generation' && (t.brief_data as Record<string, unknown>)?.destination === 'ig_post' && (
                      <button
                        type="button"
                        onClick={() => openPostFor(t)}
                        className={`act ${reviewRequired ? 'primary' : ''}`}
                        title="פתיחת פוסט האינסטגרם שמשתמש בתמונה הזו, לאישור ופרסום או לדחייה"
                      ><ThumbsUp size={16} aria-hidden="true" /> לפוסט</button>
                    )}
                    {t.task_type === 'dynamic_experiment' && t.status === 'pending' && (
                      <button
                        type="button"
                        onClick={() => handleApprove(t)}
                        disabled={busy === t.id}
                        className="act primary"
                        title="אישור הניסוי"
                      ><Check size={16} aria-hidden="true" /> אישור</button>
                    )}
                    {(t.status === 'pending' || t.status === 'processing') && (
                      <button
                        type="button"
                        onClick={() => handleCancel(t)}
                        disabled={busy === t.id}
                        className="act danger"
                        title="ביטול המשימה"
                      ><X size={16} aria-hidden="true" /> ביטול</button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {viewing && (
        <div
          className="scrim fixed inset-0 flex items-center justify-center z-50 p-3 sm:p-6"
          onClick={() => setViewing(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="seo-task-dialog-title"
            className="dialog bg-white rounded-[10px] border border-surface-200 max-w-2xl w-full max-h-[85dvh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <header className="min-h-[56px] ps-5 pe-2 py-2 border-b border-surface-200 flex items-center gap-3 shrink-0">
              <div className="flex-1 min-w-0">
                <div id="seo-task-dialog-title" className="text-[15px] font-semibold text-surface-900 truncate">
                  {taskLabel(viewing.task_type)}
                  {viewing.task_subtype && <span className="mr-1.5 font-mono text-[12px] font-normal text-surface-500" dir="ltr">{viewing.task_subtype}</span>}
                </div>
                <div className="text-[11.5px] text-surface-400 font-mono truncate" dir="ltr">{viewing.id}</div>
              </div>
              <button ref={closeRef} type="button" onClick={() => setViewing(null)} className="icon-btn" aria-label="סגירה"><X size={18} aria-hidden="true" /></button>
            </header>
            <div className="flex-1 overflow-y-auto p-5 space-y-5 text-[13px]">
              {viewing.rationale && (
                <div>
                  <div className="text-[13px] font-semibold text-surface-700 mb-1">למה הסוכן יצר את המשימה</div>
                  <div className="text-[14px] leading-relaxed text-surface-900" dir="auto">{viewing.rationale}</div>
                </div>
              )}

              {/* INSTAGRAM PREVIEW — the actual post as it will appear: image(s)
                  + final caption (Hebrew, RTL). Approve & Publish pushes the
                  pre-staged container live; Reject drops it. Only for
                  instagram_post tasks; everything else falls through to the
                  generic brief view below. */}
              {viewing.task_type === 'instagram_post' && (() => {
                const rd       = (viewing.result_data ?? {}) as Record<string, any>
                const brief    = (viewing.brief_data ?? {}) as Record<string, any>
                const caption  = (rd.caption as string) ?? (brief.caption_he as string) ?? ''
                const carousel = Array.isArray(rd.carousel_children) ? (rd.carousel_children as string[]) : []
                const single   = (rd.image_url as string) ?? ''
                const images   = carousel.length > 0 ? carousel : (single ? [single] : [])
                const published = Boolean(rd.ig_permalink)
                const rejected  = Boolean(rd.rejected_via_ui_at)
                const canPublish = !published && !rejected && Boolean(rd.ig_creation_id)
                const mediaType = (rd.media_type as string) ?? (brief.media_type as string) ?? 'feed_image'
                // A/B ARM WARNING. Approving only one arm of an experiment
                // voids it: the evaluator needs two live arms to compare, and
                // with one it records nothing. Historically 17 of 22 arms were
                // prepared and never approved, which is why the self-optimizing
                // loop produced zero winners in three months.
                //
                // Siblings come from the already-loaded 7-day task list. Arms of
                // one experiment are emitted in the same orchestrator run, so
                // they are in the window together; if an older sibling has aged
                // out the count simply reads low, never wrong-high.
                const armSiblings = viewing.experiment_id
                  ? tasks.filter(t => t.experiment_id === viewing.experiment_id && t.task_type === 'instagram_post')
                  : []
                const isArm = armSiblings.length > 1
                const armsLive = armSiblings.filter(t => Boolean((t.result_data as Record<string, any> | null)?.ig_permalink)).length
                return (
                  <div className="space-y-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <div className="text-[13px] font-semibold text-surface-700 me-1">תצוגה מקדימה לאינסטגרם</div>
                      <Tag mono>{mediaType}{carousel.length > 0 ? ` · ${carousel.length} slides` : ''}</Tag>
                      {published ? (
                        <Tag tone="ok"><CheckCircle2 size={12} aria-hidden="true" /> פורסם</Tag>
                      ) : rejected ? (
                        <Tag tone="danger">נדחה</Tag>
                      ) : rd.review_required === true ? (
                        <Tag tone="warn"><Flag size={12} aria-hidden="true" /> ממתין לבדיקה</Tag>
                      ) : null}
                      {rd.qa_flagged === true && (
                        <Tag tone="danger" title="בקרת האיכות פסלה את התמונה אחרי 3 ניסיונות, והיא לא נשלחה במייל"><AlertTriangle size={12} aria-hidden="true" /> נפסלה בבקרה</Tag>
                      )}
                      {isArm && (
                        <Tag>
                          <FlaskConical size={12} aria-hidden="true" /> ניסוי A/B{viewing.variation_label ? <>: <bdi>{viewing.variation_label}</bdi></> : ''}
                        </Tag>
                      )}
                    </div>

                    {isArm && !published && !rejected && (
                      <div className="notice notice-warn">
                        <FlaskConical size={16} aria-hidden="true" className="notice-icon" />
                        <div>
                          <div className="font-semibold">הפוסט הזה הוא גרסה אחת מתוך {armSiblings.length} בניסוי A/B.</div>
                          <div className="mt-0.5 text-surface-700">
                            פרסום של חלק מהגרסאות בלבד מבטל את הניסוי: הסוכן לא יכול להשוות גרסה מול כלום, ולכן לא נרשמת למידה. {armsLive === 0
                              ? 'אף גרסה עוד לא באוויר.'
                              : `${armsLive} מתוך ${armSiblings.length} גרסאות כבר באוויר.`}{' '}
                            צריך לפרסם את <b>כל</b> הגרסאות, או לדחות את כולן.
                          </div>
                        </div>
                      </div>
                    )}

                    {(() => {
                      const shown = attemptChoices.find(c => c.image_url === single)
                      return shown && shown.issues.length > 0 ? (
                        <div className="notice notice-danger">
                          <AlertTriangle size={16} aria-hidden="true" className="notice-icon" />
                          <div className="min-w-0">
                            <div className="font-semibold">בעיה מבנית בתמונה הזו</div>
                            <ul className="list-disc ps-4 mt-1 text-surface-700" dir="auto">
                              {shown.issues.map((x, i) => <li key={i}>{x.split(' → no: ').pop()}</li>)}
                            </ul>
                          </div>
                        </div>
                      ) : null
                    })()}

                    {images.length > 0 ? (
                      <div className={carousel.length > 0 ? 'flex gap-2 overflow-x-auto pb-1' : ''}>
                        {images.map((src, i) => (
                          <a key={i} href={src} target="_blank" rel="noreferrer" className="shrink-0 block">
                            <img
                              src={src}
                              alt={carousel.length > 0 ? `שקופית ${i + 1}` : 'תמונת הפוסט'}
                              className="max-h-80 rounded-lg border border-surface-200 object-contain bg-surface-50"
                              loading="lazy"
                            />
                          </a>
                        ))}
                      </div>
                    ) : (
                      <div className="text-surface-500">עדיין אין תמונה. משימת הוויזואל עוד לא רונדרה.</div>
                    )}

                    {canPublish && carousel.length === 0 && attemptChoices.length > 1 && (
                      <div className="space-y-1.5">
                        <div className="text-[12.5px] text-surface-500">כל הניסיונות. אפשר לבחור את התמונה שתפורסם:</div>
                        <div className="flex gap-2 overflow-x-auto pb-1">
                          {attemptChoices.map(c => {
                            const current = c.image_url === single
                            return (
                              <div key={c.image_url} className={`shrink-0 rounded-[10px] border p-1.5 ${current ? 'border-brand-600 bg-brand-50' : 'border-surface-200 bg-white'}`}>
                                <a href={c.image_url} target="_blank" rel="noreferrer" className="block">
                                  <img src={c.image_url} alt={`ניסיון ${c.attempt}`} className="h-40 rounded-md object-contain bg-surface-50" loading="lazy" />
                                </a>
                                {c.issues.length > 0 && (
                                  <div className="mt-1 max-w-[9rem] text-[12px] leading-snug text-danger flex items-start gap-1" title={c.issues.join('\n')} dir="auto">
                                    <AlertTriangle size={12} aria-hidden="true" className="shrink-0 mt-0.5" /><span className="line-clamp-3">{c.issues[0].split(' → no: ').pop()}</span>
                                  </div>
                                )}
                                <div className="mt-1 flex items-center justify-between gap-2 text-[12.5px]">
                                  <span className="text-surface-700 num">ניסיון {c.attempt}</span>
                                  {current ? (
                                    <Tag tone="brand">בפוסט</Tag>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => handleUseAttempt(viewing, c.image_url, c.attempt)}
                                      disabled={busy === viewing.id}
                                      className="act primary -me-1.5"
                                    >בחירה</button>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {caption && (
                      <div dir="rtl" className="bg-surface-50 border border-surface-200 rounded-lg p-3 text-[14px] leading-relaxed text-surface-900 whitespace-pre-wrap break-words">
                        {caption}
                      </div>
                    )}

                    {canPublish && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => handlePublishIg(viewing)}
                          disabled={busy === viewing.id}
                          className="btn-primary"
                          title="פרסום הפוסט עכשיו ב-@minuto_cafe"
                        >
                          {busy === viewing.id ? <Loader2 size={16} aria-hidden="true" className="animate-spin" /> : <ThumbsUp size={16} aria-hidden="true" />} אישור ופרסום
                        </button>
                        <button
                          type="button"
                          onClick={() => setRejecting(r => !r)}
                          disabled={busy === viewing.id}
                          aria-expanded={rejecting}
                          className="btn-danger"
                          title="דחייה, בלי פרסום"
                        >
                          <X size={16} aria-hidden="true" /> דחייה
                        </button>
                      </div>
                    )}
                    {canPublish && rejecting && (
                      <div className="rounded-[10px] border border-surface-200 bg-surface-50 p-3 space-y-2.5">
                        <div className="text-[13px] font-medium text-surface-900">מה הסיבה? לחיצה אחת דוחה, והפוסט לא יפורסם:</div>
                        <div className="flex flex-wrap gap-1.5">
                          {REJECT_REASONS.map(r => (
                            <button
                              key={r}
                              type="button"
                              onClick={() => handleRejectIg(viewing, rejectNote.trim() ? `${r}: ${rejectNote.trim()}` : r)}
                              disabled={busy === viewing.id}
                              className="chip"
                            >{REJECT_REASON_LABEL[r] ?? r}</button>
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <input
                            id="ig-reject-note"
                            value={rejectNote}
                            onChange={e => setRejectNote(e.target.value)}
                            placeholder="פירוט (לא חובה), או סיבה אחרת"
                            aria-label="פירוט סיבת הדחייה"
                            dir="auto"
                            className="field flex-1 h-[38px] py-0"
                          />
                          <button
                            type="button"
                            onClick={() => handleRejectIg(viewing, rejectNote)}
                            disabled={busy === viewing.id || !rejectNote.trim()}
                            className="btn-danger shrink-0"
                          >דחייה עם הסיבה</button>
                        </div>
                      </div>
                    )}
                    {published && rd.ig_permalink && (
                      <a href={rd.ig_permalink as string} target="_blank" rel="noreferrer" className="act primary -ms-2.5">
                        <ExternalLink size={16} aria-hidden="true" /> צפייה באינסטגרם
                      </a>
                    )}
                    {rejected && rd.reject_reason && (
                      <div className="text-[13px] text-danger">נדחה: <span dir="auto">{rd.reject_reason as string}</span></div>
                    )}
                  </div>
                )
              })()}

              <div>
                <div className="text-[13px] font-semibold text-surface-700 mb-1.5">תדריך</div>
                <pre className="code overflow-x-auto">
{JSON.stringify(viewing.brief_data, null, 2)}
                </pre>
              </div>
              {viewing.result_data && Array.isArray((viewing.result_data as any).qa_attempts) && (viewing.result_data as any).qa_attempts.length > 0 && (
                <div>
                  <div className="text-[13px] font-semibold text-surface-700 mb-2 flex items-center gap-1.5 flex-wrap">
                    <span>ניסיונות בקרת איכות <span className="num font-normal text-surface-500">({(viewing.result_data as any).qa_attempts.length})</span></span>
                    {(viewing.result_data as any).review_required && (
                      <Tag tone="warn"><Flag size={12} aria-hidden="true" /> צריך בדיקה אנושית</Tag>
                    )}
                    {(viewing.result_data as any).qa_passed && (
                      <Tag tone="ok"><CheckCircle2 size={12} aria-hidden="true" /> עבר</Tag>
                    )}
                  </div>
                  <div className="rounded-[10px] border border-surface-200 divide-y divide-surface-200 overflow-hidden">
                    {((viewing.result_data as any).qa_attempts as Array<{
                      attempt: number
                      image_url: string
                      critique: { passes: boolean; missing: string[]; issues: string[]; suggested_adjustment: string }
                    }>).map(a => (
                      <div key={a.attempt} className="flex gap-3 p-2">
                        <a href={a.image_url} target="_blank" rel="noreferrer" className="shrink-0 block">
                          <img
                            src={a.image_url}
                            alt={`ניסיון ${a.attempt}`}
                            className="w-24 h-24 sm:w-28 sm:h-28 rounded-md object-cover bg-surface-100"
                            loading="lazy"
                          />
                        </a>
                        <div className="flex-1 min-w-0 text-[12.5px] leading-relaxed py-0.5">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-semibold text-surface-900 num">ניסיון {a.attempt}</span>
                            {a.critique.passes
                              ? <Status tone="ok" label="עבר" />
                              : <Status tone="danger" label="נכשל" />}
                          </div>
                          {a.critique.missing?.length > 0 && (
                            <div className="text-surface-700 mb-0.5" dir="auto">
                              <span className="font-medium text-danger">חסר: </span>{a.critique.missing.join(', ')}
                            </div>
                          )}
                          {a.critique.issues?.length > 0 && (
                            <div className="text-surface-700 mb-0.5" dir="auto">
                              <span className="font-medium text-warn">בעיות: </span>{a.critique.issues.join(' · ')}
                            </div>
                          )}
                          {a.critique.suggested_adjustment && (
                            <div className="text-surface-500" dir="auto">
                              <span className="font-medium">בניסיון הבא: </span>{a.critique.suggested_adjustment}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {viewing.result_data && (
                <details>
                  <summary className="inline-flex items-center gap-1.5 min-h-9 text-[13px] text-surface-500 hover:text-surface-800">
                    <ChevronLeft size={14} aria-hidden="true" className="chev" /> נתוני תוצאה גולמיים (result_data)
                  </summary>
                  <pre className="code overflow-x-auto mt-1">
{JSON.stringify(viewing.result_data, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
