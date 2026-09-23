import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Film, Search, Loader2, AlertCircle, CheckCircle2, Clock, Send, X, RotateCcw, ExternalLink, Smartphone } from 'lucide-react'
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
  {id: 'reel', label: 'פוסט (Reel)', hint: 'נשאר בפיד, עם כיתוב'},
  {id: 'story', label: 'סטורי', hint: 'נעלם אחרי 24 שעות, בלי כיתוב'},
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
  const [format, setFormat] = useState<ReelFormat>('reel')
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
          format: opts.format ?? 'reel',
          ...(opts.facts ? { facts: opts.facts } : {}),
          requested_via: 'dashboard',
        },
      })
      if (e) throw e
      setPicked(null)
      setBadge('')
      setFormat('reel')
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

  return (
    <div className="space-y-8 fade-up">
      <div>
        <h2 className="text-2xl font-display font-semibold text-surface-900 flex items-center gap-2">
          <Film size={22} /> רילס מוצרים
        </h2>
        <p className="text-sm text-surface-400 mt-1">
          בוחרים קפה, הרילס נוצר אוטומטית מנתוני המוצר באתר, ומתפרסם רק אחרי אישור.
        </p>
      </div>

      {error && (
        <div className="card bg-red-50 border-red-200 flex gap-3">
          <AlertCircle className="text-red-500 shrink-0 mt-0.5" size={18} />
          <p className="text-sm text-red-800 flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600" aria-label="סגור"><X size={16} /></button>
        </div>
      )}

      {/* Create */}
      <section className="card space-y-4">
        <h3 className="font-semibold text-surface-800">רילס חדש</h3>
        <div className="relative">
          <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="חיפוש קפה..."
            className="w-full pr-9 pl-3 py-2.5 text-sm rounded-xl border border-surface-200 bg-white focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-400 placeholder:text-surface-300"
          />
        </div>

        {loading ? (
          <p className="text-sm text-surface-400 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> טוען מוצרים...</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-80 overflow-y-auto">
            {filtered.map(p => (
              <div key={p.woo_id} className={`flex items-center gap-3 p-2 rounded-xl border ${picked?.woo_id === p.woo_id ? 'border-brand-400 bg-brand-50' : 'border-surface-100'}`}>
                {p.image_url && <img src={p.image_url} alt="" className="w-12 h-12 rounded-lg object-cover bg-surface-50" />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-surface-800 truncate">{decode(p.name)}</p>
                  {p.price && <p className="text-xs text-surface-400">₪{p.price}</p>}
                </div>
                <button
                  onClick={() => setPicked(p)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-surface-900 text-white hover:bg-surface-700 shrink-0"
                >
                  צור רילס
                </button>
              </div>
            ))}
            {filtered.length === 0 && <p className="text-sm text-surface-400">לא נמצאו מוצרי קפה במלאי.</p>}
          </div>
        )}

        {picked && (
          <div className="rounded-xl border border-brand-200 bg-brand-50 p-4 space-y-3">
            <p className="text-sm text-surface-800">
              יצירת רילס ל<strong>{decode(picked.name)}</strong>
            </p>
            <div className="flex gap-2">
              {FORMATS.map(f => (
                <button
                  key={f.id}
                  onClick={() => setFormat(f.id)}
                  className={`flex-1 text-right px-3 py-2 rounded-lg border text-sm transition ${
                    format === f.id ? 'border-brand-400 bg-white text-surface-900' : 'border-surface-200 bg-white/50 text-surface-500 hover:bg-white'
                  }`}
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    {f.id === 'story' ? <Smartphone size={14} /> : <Film size={14} />}
                    {f.label}
                  </span>
                  <span className="block text-xs text-surface-400 mt-0.5">{f.hint}</span>
                </button>
              ))}
            </div>
            <label className="block text-xs text-surface-500">
              תגית (לא חובה), למשל "מהדורה מוגבלת"
              <input
                type="text"
                value={badge}
                maxLength={24}
                onChange={e => setBadge(e.target.value)}
                className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-surface-200 bg-white focus:outline-none focus:ring-2 focus:ring-brand-300"
              />
            </label>
            <p className="text-xs text-surface-400">
              המחיר, המשקל והקלייה נלקחים מהאתר. תווי הטעם והמקור נשלפים מתיאור המוצר, ורק מה שכתוב שם מופיע בסרטון.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => requestReel(picked, { badge, format })}
                disabled={busy === `create-${picked.woo_id}`}
                className="text-sm px-4 py-2 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 flex items-center gap-2"
              >
                {busy === `create-${picked.woo_id}` ? <Loader2 size={14} className="animate-spin" /> : <Film size={14} />}
                {format === 'story' ? 'צור סטורי' : 'צור רילס'}
              </button>
              <button onClick={() => { setPicked(null); setBadge(''); setFormat('reel') }} className="text-sm px-4 py-2 rounded-lg text-surface-500 hover:bg-surface-100">
                ביטול
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Reels */}
      <section className="space-y-4">
        <h3 className="font-semibold text-surface-800">הרילס שלי</h3>
        {tasks.length === 0 && !loading && <p className="text-sm text-surface-400">עוד לא נוצרו רילס.</p>}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {tasks.map(t => (
            <ReelCard
              key={t.id}
              task={t}
              busy={busy}
              onPublish={caption => publish(t, caption)}
              onReject={() => reject(t)}
              onRerender={() => rerender(t)}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function ReelCard({ task, busy, onPublish, onReject, onRerender }: {
  task: ReelTask
  busy: string | null
  onPublish: (caption: string) => void
  onReject: () => void
  onRerender: () => void
}) {
  const rd = task.result_data ?? {}
  const [caption, setCaption] = useState(rd.caption ?? '')
  useEffect(() => { setCaption(rd.caption ?? '') }, [rd.caption])

  const name = task.brief_data.product_name ?? rd.facts?.titleEn ?? `מוצר ${task.brief_data.woo_id}`
  const kind: ReelFormat = rd.media_type ?? task.brief_data.format ?? 'reel'
  const kindLabel = kind === 'story' ? 'סטורי' : 'פוסט (Reel)'
  const published = !!rd.published_via_ui_at
  const rejected = !!rd.rejected_via_ui_at
  const awaitingReview = task.status === 'completed' && rd.review_required && !published && !rejected

  const chip = (() => {
    if (published) return { cls: 'bg-green-50 text-green-800', icon: CheckCircle2, label: 'פורסם' }
    if (rejected) return { cls: 'bg-surface-100 text-surface-600', icon: X, label: 'נדחה' }
    if (task.status === 'failed') return { cls: 'bg-red-50 text-red-800', icon: AlertCircle, label: 'נכשל' }
    if (task.status === 'completed') return { cls: 'bg-amber-50 text-amber-800', icon: Clock, label: 'ממתין לאישור' }
    if (task.status === 'processing') return { cls: 'bg-blue-50 text-blue-800', icon: Loader2, label: 'נוצר עכשיו (כ-2 דקות)' }
    return { cls: 'bg-blue-50 text-blue-800', icon: Loader2, label: 'בתור' }
  })()
  const ChipIcon = chip.icon

  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-surface-800 truncate">{name}</p>
          <p className="text-xs text-surface-400">{kindLabel} · {new Date(task.created_at).toLocaleString('he-IL')}{task.brief_data.badge ? ` · ${task.brief_data.badge}` : ''}</p>
        </div>
        <span className={`text-xs px-2 py-1 rounded-full flex items-center gap-1 shrink-0 ${chip.cls}`}>
          <ChipIcon size={12} className={chip.icon === Loader2 ? 'animate-spin' : ''} /> {chip.label}
        </span>
      </div>

      {rd.video_url && (
        <video src={rd.video_url} controls playsInline className="w-full max-h-[480px] rounded-xl bg-black" />
      )}

      {task.status === 'failed' && (
        <p className="text-xs text-red-700 bg-red-50 rounded-lg p-2">{task.error_msg ?? 'היצירה נכשלה'}</p>
      )}

      {awaitingReview && kind === 'story' && (
        <p className="text-xs text-surface-400">סטורי מתפרסם בלי כיתוב, אינסטגרם מתעלם ממנו.</p>
      )}

      {awaitingReview && kind !== 'story' && (
        <label className="block text-xs text-surface-500">
          כיתוב לפוסט
          <textarea
            value={caption}
            onChange={e => setCaption(e.target.value)}
            rows={4}
            dir="auto"
            className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-surface-200 bg-white focus:outline-none focus:ring-2 focus:ring-brand-300"
          />
        </label>
      )}

      <div className="flex flex-wrap gap-2">
        {awaitingReview && (
          <>
            <button
              onClick={() => onPublish(caption)}
              disabled={busy === `publish-${task.id}`}
              className="text-sm px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5"
            >
              {busy === `publish-${task.id}` ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {kind === 'story' ? 'פרסם כסטורי' : 'פרסם לאינסטגרם'}
            </button>
            <button onClick={onReject} disabled={!!busy} className="text-sm px-3 py-1.5 rounded-lg text-surface-600 hover:bg-surface-100 disabled:opacity-50">
              דחה
            </button>
          </>
        )}
        {(task.status === 'failed' || rejected || awaitingReview) && (
          <button onClick={onRerender} disabled={!!busy} className="text-sm px-3 py-1.5 rounded-lg text-surface-600 hover:bg-surface-100 disabled:opacity-50 flex items-center gap-1.5">
            <RotateCcw size={14} /> צור מחדש
          </button>
        )}
        {published && rd.ig_permalink && (
          <a href={rd.ig_permalink} target="_blank" rel="noreferrer" className="text-sm px-3 py-1.5 rounded-lg text-brand-700 hover:bg-brand-50 flex items-center gap-1.5">
            <ExternalLink size={14} /> צפייה באינסטגרם
          </a>
        )}
      </div>
    </div>
  )
}
