import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Film, Search, Loader2, AlertCircle, Check, ChevronLeft, Send, X, RotateCcw, ExternalLink, Smartphone, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'

// Product reels: pick a coffee, render a vertical Reel, review it, publish it.
//
// Clicking "צור רילס" inserts a seo_tasks row (task_type='reel_render'). A DB trigger
// dispatches the GitHub "Render reel" workflow, which renders with Remotion and writes
// result_data.video_url back with review_required=true (migration
// 20260917_reel_render_dispatch.sql, .github/workflows/render-reel.yml).
// Publishing is a separate, explicit click that calls meta-publish (publish_now/reel).

interface Product {
  woo_id: number
  name: string
  price: string | null
  image_url: string | null
  categories: string[] | null
}

interface ReelTask {
  id: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  brief_data: { woo_id?: number; badge?: string | null; product_name?: string; format?: ReelFormat; facts?: Record<string, unknown> }
  result_data: {
    media_type?: ReelFormat
    video_url?: string
    caption?: string
    facts?: { titleEn?: string; notes?: string[]; price?: number; grams?: number | null }
    review_required?: boolean
    published_via_ui_at?: string
    ig_permalink?: string | null
    rejected_via_ui_at?: string
    render_run_url?: string
  } | null
  error_msg: string | null
  attempts: number
  created_at: string
}

type ReelFormat = 'reel' | 'story'

const COFFEE_CATEGORY = 'פולי קפה'
const FORMATS: Array<{id: ReelFormat; label: string; hint: string}> = [
  {id: 'story', label: 'סטורי', hint: 'נעלם אחרי 24 שעות, בלי כיתוב'},
  {id: 'reel', label: 'פוסט (Reel)', hint: 'נשאר בפיד, עם כיתוב'},
]

const decode = (s: string) => {
  const el = document.createElement('textarea')
  el.innerHTML = s
  return el.value
}

export default function ReelsPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [tasks, setTasks] = useState<ReelTask[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Product | null>(null)
  const [badge, setBadge] = useState('')
  const [format, setFormat] = useState<ReelFormat>('story')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  const loadTasks = useCallback(async () => {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    const { data, error: e } = await supabase
      .from('seo_tasks')
      .select('id, status, brief_data, result_data, error_msg, attempts, created_at')
      .eq('task_type', 'reel_render')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(30)
    if (!alive.current) return
    if (e) setError(e.message)
    else setTasks((data ?? []) as ReelTask[])
  }, [])

  useEffect(() => {
    alive.current = true
    ;(async () => {
      const { data, error: e } = await supabase
        .from('woo_products')
        .select('woo_id, name, price, image_url, categories')
        .eq('stock_status', 'instock')
        .not('image_url', 'is', null)
        .order('name')
      if (!alive.current) return
      if (e) setError(e.message)
      const seen = new Set<number>()
      const coffees = ((data ?? []) as Product[]).filter(p => {
        if (seen.has(p.woo_id)) return false
        seen.add(p.woo_id)
        // Reels are for roasted specialty beans only (brand rule); the renderer enforces it too.
        return (p.categories ?? []).some(c => c.includes(COFFEE_CATEGORY))
      })
      setProducts(coffees)
      await loadTasks()
      setLoading(false)
    })()

    const channel = supabase
      .channel('reel_tasks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'seo_tasks' }, () => { loadTasks() })
      .subscribe()
    const poll = setInterval(loadTasks, 15_000)
    return () => {
      alive.current = false
      clearInterval(poll)
      supabase.removeChannel(channel)
    }
  }, [loadTasks])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? products.filter(p => decode(p.name).toLowerCase().includes(q)) : products
  }, [products, query])

  async function requestReel(product: Product, opts: { badge?: string; format?: ReelFormat; facts?: Record<string, unknown> } = {}) {
    setBusy(`create-${product.woo_id}`)
    setError(null)
    try {
      const { error: e } = await supabase.from('seo_tasks').insert({
        task_type: 'reel_render',
        status: 'pending',
        rationale: 'Reel requested from the dashboard',
        brief_data: {
          woo_id: product.woo_id,
          product_name: decode(product.name),
          badge: opts.badge?.trim() || null,
          format: opts.format ?? 'story',
          ...(opts.facts ? { facts: opts.facts } : {}),
          requested_via: 'dashboard',
        },
      })
      if (e) throw e
      setPicked(null)
      setBadge('')
      setFormat('story')
      await loadTasks()
    } catch (e: any) {
      setError(`יצירת הרילס נכשלה: ${e?.message ?? e}`)
    } finally {
      setBusy(null)
    }
  }

  async function saveResult(task: ReelTask, patch: Partial<NonNullable<ReelTask['result_data']>>) {
    const updated = { ...(task.result_data ?? {}), ...patch }
    const { error: e } = await supabase.from('seo_tasks').update({ result_data: updated }).eq('id', task.id)
    if (e) throw e
    setTasks(ts => ts.map(t => (t.id === task.id ? { ...t, result_data: updated } : t)))
  }

  async function publish(task: ReelTask, caption: string) {
    const video = task.result_data?.video_url
    if (!video) return
    const kind: ReelFormat = task.result_data?.media_type ?? task.brief_data.format ?? 'reel'
    const what = kind === 'story' ? 'הסטורי' : 'הרילס'
    if (!window.confirm(`לפרסם את ${what} עכשיו ב-@minuto_cafe? הוא יעלה לאוויר מיד.`)) return
    setBusy(`publish-${task.id}`)
    setError(null)
    try {
      await saveResult(task, { caption })
      const { data, error: e } = await supabase.functions.invoke('meta-publish', {
        // Instagram ignores captions on stories, so only a feed reel sends one.
        body: { action: 'publish_now', type: kind, video_url: video, caption: kind === 'story' ? undefined : caption },
      })
      if (e) throw e
      if (data && data.success === false) throw new Error(data.error ?? 'meta-publish returned success:false')
      await saveResult(task, {
        caption,
        review_required: false,
        published_via_ui_at: new Date().toISOString(),
        ig_permalink: (data?.permalink as string | undefined) ?? null,
      })
    } catch (e: any) {
      setError(`הפרסום נכשל: ${e?.message ?? e}. אם אינסטגרם עדיין מעבד את הסרטון, כדאי לבדוק בפרופיל לפני שמנסים שוב.`)
    } finally {
      setBusy(null)
    }
  }

  async function reject(task: ReelTask) {
    if (!window.confirm('לדחות את הרילס? הוא לא יפורסם.')) return
    setBusy(`reject-${task.id}`)
    try {
      await saveResult(task, { review_required: false, rejected_via_ui_at: new Date().toISOString() })
    } catch (e: any) {
      setError(`הדחייה נכשלה: ${e?.message ?? e}`)
    } finally {
      setBusy(null)
    }
  }

  async function remove(task: ReelTask) {
    const published = !!task.result_data?.published_via_ui_at
    const msg = published
      ? 'למחוק את הרילס מהרשימה? הפוסט שכבר עלה לאינסטגרם לא יימחק משם.'
      : 'למחוק את הרילס? אי אפשר לבטל את זה.'
    if (!window.confirm(msg)) return
    setBusy(`delete-${task.id}`)
    setError(null)
    try {
      // .select() so an RLS-filtered delete (0 rows) surfaces instead of passing silently.
      const { data, error: e } = await supabase.from('seo_tasks').delete().eq('id', task.id).select('id')
      if (e) throw e
      if (!data?.length) throw new Error('אין הרשאה למחוק את הרילס הזה')
      setTasks(ts => ts.filter(t => t.id !== task.id))
    } catch (e: any) {
      setError(`המחיקה נכשלה: ${e?.message ?? e}`)
    } finally {
      setBusy(null)
    }
  }

  function rerender(task: ReelTask) {
    const product = products.find(p => p.woo_id === task.brief_data.woo_id)
    if (!product) {
      setError('המוצר כבר לא ברשימת הקפה במלאי, אי אפשר לרנדר מחדש.')
      return
    }
    requestReel(product, {
      badge: task.brief_data.badge ?? undefined,
      format: task.result_data?.media_type ?? task.brief_data.format ?? 'reel',
      facts: task.brief_data.facts,
    })
  }

  // On phones the form opens below a scrolling list; bring it into view when a coffee is picked.
  const pickedRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (picked) pickedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [picked?.woo_id])

  return (
    <div className="fade-up space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-surface-900">רילס מוצרים</h1>
        <p className="text-sm text-surface-500 mt-1">
          בוחרים קפה, הרילס נוצר אוטומטית מנתוני המוצר באתר, ומתפרסם רק אחרי אישור.
        </p>
      </header>

      {error && (
        <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-[#B42318]/15 bg-[#FDF1EF] px-3.5 py-3">
          <AlertCircle size={16} aria-hidden="true" className="text-[#B42318] shrink-0 mt-0.5" />
          <p className="text-sm text-surface-900 flex-1 min-w-0 break-words">{error}</p>
          <button
            onClick={() => setError(null)}
            aria-label="סגירת ההודעה"
            className="grid place-items-center w-8 h-8 -my-1.5 -me-1.5 rounded-md text-surface-500 hover:bg-black/5 hover:text-surface-900 transition-colors shrink-0"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Create */}
      <section aria-labelledby="reels-new" className="bg-white border border-surface-200 rounded-[10px]">
        <div className="flex items-center justify-between gap-3 min-h-[52px] px-[18px] border-b border-surface-200">
          <h2 id="reels-new" className="text-[15px] text-surface-900">רילס חדש</h2>
          {!loading && <span className="text-[13px] text-surface-500 num">{products.length} סוגי קפה במלאי</span>}
        </div>

        <div className="p-[18px] space-y-3">
          <div className="relative">
            <Search size={16} aria-hidden="true" className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="חיפוש קפה…"
              aria-label="חיפוש קפה"
              className={`${FIELD} pr-9`}
            />
          </div>

          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" aria-busy="true" aria-label="טוען מוצרים">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="flex items-center gap-3 p-2 rounded-lg border border-surface-200">
                  <span className="w-11 h-11 rounded-md bg-surface-100" />
                  <span className="h-3 w-2/5 rounded bg-surface-100" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-surface-500 py-6 text-center">
              {query.trim() ? `אין קפה שמתאים ל"${query.trim()}".` : 'לא נמצאו מוצרי קפה במלאי.'}
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-80 overflow-y-auto overscroll-contain -m-1 p-1">
              {filtered.map(p => {
                const selected = picked?.woo_id === p.woo_id
                return (
                  <button
                    key={p.woo_id}
                    type="button"
                    onClick={() => setPicked(p)}
                    aria-pressed={selected}
                    className={`flex items-center gap-3 p-2 pe-3 rounded-lg border text-right transition-[background-color,border-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.98] ${
                      selected ? 'border-brand-600 bg-brand-100' : 'border-surface-200 bg-white hover:bg-surface-50 hover:border-surface-300'
                    }`}
                  >
                    {p.image_url
                      ? <img src={p.image_url} alt="" loading="lazy" className="w-11 h-11 rounded-md object-cover bg-surface-100 shrink-0" />
                      : <span className="w-11 h-11 rounded-md bg-surface-100 shrink-0" />}
                    <span className="flex-1 min-w-0">
                      <span className={`block text-sm truncate ${selected ? 'text-brand-700 font-medium' : 'text-surface-900'}`}>{decode(p.name)}</span>
                      {p.price && <span className="block text-[13px] text-surface-500 num">₪{p.price}</span>}
                    </span>
                    {selected
                      ? <Check size={16} aria-hidden="true" className="text-brand-600 shrink-0" />
                      : <ChevronLeft size={16} aria-hidden="true" className="text-surface-400 shrink-0" />}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {picked && (
          <div ref={pickedRef} className="border-t border-surface-200 bg-surface-50 rounded-b-[10px] p-[18px] space-y-4 scroll-mb-4">
            <p className="text-sm text-surface-700">
              רילס חדש ל<strong className="font-semibold text-surface-900">{decode(picked.name)}</strong>
            </p>

            <fieldset>
              <legend className="text-[13px] font-medium text-surface-700 mb-1.5">פורמט</legend>
              <div className="grid grid-cols-2 gap-2">
                {FORMATS.map(f => {
                  const on = format === f.id
                  return (
                    <label
                      key={f.id}
                      className={`cursor-pointer rounded-lg border px-3 py-2.5 transition-[background-color,border-color] duration-150 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-brand-600/25 ${
                        on ? 'border-brand-600 bg-white' : 'border-surface-300 bg-white/60 hover:bg-white'
                      }`}
                    >
                      <input
                        type="radio"
                        name="reel-format"
                        value={f.id}
                        checked={on}
                        onChange={() => setFormat(f.id)}
                        className="sr-only"
                      />
                      <span className={`flex items-center gap-1.5 text-sm font-medium ${on ? 'text-brand-700' : 'text-surface-900'}`}>
                        {f.id === 'story' ? <Smartphone size={16} aria-hidden="true" /> : <Film size={16} aria-hidden="true" />}
                        {f.label}
                      </span>
                      <span className="block text-[13px] text-surface-500 mt-0.5">{f.hint}</span>
                    </label>
                  )
                })}
              </div>
            </fieldset>

            <div>
              <label htmlFor="reel-badge" className="block text-[13px] font-medium text-surface-700 mb-1.5">
                תגית <span className="font-normal text-surface-500">(לא חובה), למשל "מהדורה מוגבלת"</span>
              </label>
              <input
                id="reel-badge"
                type="text"
                value={badge}
                maxLength={24}
                onChange={e => setBadge(e.target.value)}
                className={`${FIELD} sm:max-w-xs`}
              />
            </div>

            <p className="text-[13px] text-surface-500 leading-relaxed">
              המחיר, המשקל והקלייה נלקחים מהאתר. תווי הטעם והמקור נשלפים מתיאור המוצר, ורק מה שכתוב שם מופיע בסרטון.
            </p>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => requestReel(picked, { badge, format })}
                disabled={busy === `create-${picked.woo_id}`}
                className="btn-primary"
              >
                {busy === `create-${picked.woo_id}` ? <Loader2 size={16} aria-hidden="true" className="animate-spin" /> : <Film size={16} aria-hidden="true" />}
                {format === 'story' ? 'יצירת סטורי' : 'יצירת רילס'}
              </button>
              <button onClick={() => { setPicked(null); setBadge(''); setFormat('story') }} className="btn-secondary">
                ביטול
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Reels */}
      <section aria-labelledby="reels-mine" className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="reels-mine" className="text-[17px] text-surface-900">הרילס שלי</h2>
          <span className="text-[13px] text-surface-500">30 הימים האחרונים</span>
        </div>
        {tasks.length === 0 && !loading && (
          <div className="bg-white border border-surface-200 rounded-[10px] px-6 py-10 text-center">
            <Film size={20} aria-hidden="true" className="mx-auto text-surface-400" />
            <p className="text-sm text-surface-700 mt-2">עוד לא נוצרו רילס.</p>
            <p className="text-[13px] text-surface-500 mt-0.5">בחירת קפה למעלה יוצרת את הראשון.</p>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          {tasks.map(t => (
            <ReelCard
              key={t.id}
              task={t}
              busy={busy}
              onPublish={caption => publish(t, caption)}
              onReject={() => reject(t)}
              onRerender={() => rerender(t)}
              onDelete={() => remove(t)}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function ReelCard({ task, busy, onPublish, onReject, onRerender, onDelete }: {
  task: ReelTask
  busy: string | null
  onPublish: (caption: string) => void
  onReject: () => void
  onRerender: () => void
  onDelete: () => void
}) {
  const rd = task.result_data ?? {}
  const [caption, setCaption] = useState(rd.caption ?? '')
  useEffect(() => { setCaption(rd.caption ?? '') }, [rd.caption])

  const name = task.brief_data.product_name ?? rd.facts?.titleEn ?? `מוצר ${task.brief_data.woo_id}`
  const kind: ReelFormat = rd.media_type ?? task.brief_data.format ?? 'reel'
  const kindLabel = kind === 'story' ? 'סטורי' : 'פוסט (Reel)'
  const requested = task.brief_data.format
  // A render that came back in a different format than requested must not publish quietly.
  const formatMismatch = !!rd.video_url && !!requested && requested !== kind
  const published = !!rd.published_via_ui_at
  const rejected = !!rd.rejected_via_ui_at
  const awaitingReview = task.status === 'completed' && rd.review_required && !published && !rejected

  const chip: { tone: keyof typeof TAG_TONE; label: string; note?: string } = (() => {
    if (published) return { tone: 'ok', label: 'פורסם' }
    if (rejected) return { tone: 'neutral', label: 'נדחה' }
    if (task.status === 'failed') return { tone: 'danger', label: 'נכשל' }
    if (task.status === 'completed') return { tone: 'warn', label: 'ממתין לאישור' }
    if (task.status === 'processing') return { tone: 'brand', label: 'בעבודה', note: 'הסרטון נוצר עכשיו, בערך 2 דקות.' }
    return { tone: 'neutral', label: 'בתור', note: 'ממתין לתחילת הרינדור.' }
  })()

  const deleting = busy === `delete-${task.id}`

  return (
    <article className="bg-white border border-surface-200 rounded-[10px] flex flex-col min-w-0">
      <header className="flex items-start justify-between gap-3 px-[18px] pt-4 pb-3">
        <div className="min-w-0">
          <h3 className="text-[15px] text-surface-900 truncate">{name}</h3>
          <p className="text-[13px] text-surface-500 mt-0.5 num">
            {kindLabel} · {new Date(task.created_at).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}
            {task.brief_data.badge ? ` · ${task.brief_data.badge}` : ''}
          </p>
        </div>
        <StatusTag tone={chip.tone} label={chip.label} spinning={task.status === 'processing' && !published && !rejected} />
      </header>

      {chip.note && !rd.video_url && (
        <p className="px-[18px] pb-4 -mt-1 text-[13px] text-surface-500">{chip.note}</p>
      )}

      {rd.video_url && (
        <div className="mx-[18px] mb-3 rounded-lg bg-surface-100 py-3">
          <video
            src={rd.video_url}
            controls
            playsInline
            preload="metadata"
            className="block mx-auto h-[420px] max-h-[62vh] max-w-full aspect-[9/16] rounded-md bg-surface-900 object-contain"
          />
        </div>
      )}

      {(task.status === 'failed' || formatMismatch || (awaitingReview && kind === 'story')) && (
        <div className="px-[18px] pb-3 space-y-2">
          {task.status === 'failed' && (
            <Notice tone="danger">{task.error_msg ?? 'היצירה נכשלה'}</Notice>
          )}
          {formatMismatch && (
            <Notice tone="warn">
              הוזמן {requested === 'story' ? 'סטורי' : 'פוסט'} אבל הסרטון נוצר כ{kindLabel}. כדאי ליצור מחדש לפני פרסום.
            </Notice>
          )}
          {awaitingReview && kind === 'story' && (
            <p className="text-[13px] text-surface-500">סטורי מתפרסם בלי כיתוב, אינסטגרם מתעלם ממנו.</p>
          )}
        </div>
      )}

      {awaitingReview && kind !== 'story' && (
        <div className="px-[18px] pb-3">
          <label htmlFor={`caption-${task.id}`} className="block text-[13px] font-medium text-surface-700 mb-1.5">כיתוב לפוסט</label>
          <textarea
            id={`caption-${task.id}`}
            value={caption}
            onChange={e => setCaption(e.target.value)}
            rows={4}
            dir="auto"
            className={`${FIELD} h-auto py-2 leading-relaxed resize-y`}
          />
        </div>
      )}

      {/* Nothing to do while a render is running, so no empty action bar. */}
      {task.status !== 'processing' && (
      <div className="mt-auto flex flex-wrap items-center gap-2 px-[18px] py-3 border-t border-surface-200">
        {awaitingReview && (
          <>
            <button
              onClick={() => onPublish(caption)}
              disabled={busy === `publish-${task.id}` || formatMismatch}
              className="btn-primary"
            >
              {busy === `publish-${task.id}` ? <Loader2 size={16} aria-hidden="true" className="animate-spin" /> : <Send size={16} aria-hidden="true" />}
              {kind === 'story' ? 'פרסום כסטורי' : 'פרסום לאינסטגרם'}
            </button>
            <button onClick={onReject} disabled={!!busy} className="btn-secondary">
              דחייה
            </button>
          </>
        )}
        {(task.status === 'failed' || rejected || awaitingReview) && (
          <button onClick={onRerender} disabled={!!busy} className={awaitingReview ? BTN_QUIET : 'btn-secondary'}>
            <RotateCcw size={16} aria-hidden="true" /> יצירה מחדש
          </button>
        )}
        {published && rd.ig_permalink && (
          <a href={rd.ig_permalink} target="_blank" rel="noreferrer" className="btn-secondary">
            <ExternalLink size={16} aria-hidden="true" /> צפייה באינסטגרם
          </a>
        )}
        {/* Delete is never offered while rendering (the bar is hidden then): the workflow
            would finish into a row that no longer exists. */}
          <button
            onClick={onDelete}
            disabled={!!busy}
            aria-label={`מחיקת הרילס של ${name}`}
            title="מחיקה"
            className={`${BTN_QUIET_DANGER} ms-auto w-[38px] px-0`}
          >
            {deleting ? <Loader2 size={16} aria-hidden="true" className="animate-spin" /> : <Trash2 size={16} aria-hidden="true" />}
          </button>
      </div>
      )}
    </article>
  )
}

// ── Local pieces ─────────────────────────────────────────────────────────

const FIELD =
  'w-full h-[38px] px-3 text-sm rounded-lg border border-surface-300 bg-white text-surface-900 placeholder:text-surface-400 ' +
  'transition-[border-color,box-shadow] duration-150 focus:outline-none focus:border-brand-600 focus:ring-[3px] focus:ring-brand-600/20'

const BTN_BASE =
  'inline-flex items-center justify-center gap-2 h-[38px] px-3 rounded-lg text-sm font-medium whitespace-nowrap ' +
  'transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97] ' +
  'disabled:opacity-50 disabled:cursor-not-allowed'

// Ghost: secondary actions that shouldn't compete with publish.
const BTN_QUIET = `${BTN_BASE} text-surface-700 hover:bg-surface-100 hover:text-surface-900`

// Delete stays quiet at rest and turns red only when pointed at.
const BTN_QUIET_DANGER = `${BTN_BASE} text-surface-700 hover:bg-[#FDF1EF] hover:text-[#B42318]`

const TAG_TONE = {
  ok:      { tag: 'bg-[#EEF3E8] text-[#3F6B2A]', dot: 'bg-[#3F6B2A]' },
  warn:    { tag: 'bg-[#FCF5E8] text-[#A15C07]', dot: 'bg-[#D9921C]' },
  danger:  { tag: 'bg-[#FDF1EF] text-[#B42318]', dot: 'bg-[#B42318]' },
  brand:   { tag: 'bg-brand-100 text-brand-700', dot: 'bg-brand-600' },
  neutral: { tag: 'bg-surface-100 text-surface-700', dot: 'bg-surface-400' },
} as const

function StatusTag({ tone, label, spinning }: { tone: keyof typeof TAG_TONE; label: string; spinning?: boolean }) {
  const t = TAG_TONE[tone]
  return (
    <span className={`inline-flex items-center gap-1.5 h-[22px] px-2 rounded-md text-xs font-semibold whitespace-nowrap shrink-0 ${t.tag}`}>
      {spinning
        ? <Loader2 size={12} aria-hidden="true" className="animate-spin" />
        : <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} aria-hidden="true" />}
      {label}
    </span>
  )
}

function Notice({ tone, children }: { tone: 'warn' | 'danger'; children: React.ReactNode }) {
  const cls = tone === 'danger'
    ? 'bg-[#FDF1EF] border-[#B42318]/15 text-[#B42318]'
    : 'bg-[#FCF5E8] border-[#A15C07]/15 text-[#A15C07]'
  return <p className={`rounded-lg border px-3 py-2 text-[13px] leading-relaxed break-words ${cls}`}>{children}</p>
}
