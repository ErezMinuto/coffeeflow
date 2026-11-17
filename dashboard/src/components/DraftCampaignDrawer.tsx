import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { formatCurrency } from '../lib/utils'
import {
  X, Loader2, ExternalLink, CheckCircle2, AlertTriangle, AlertCircle,
  Users, ShieldCheck, Image as ImageIcon,
} from 'lucide-react'
import { Notice } from './shared/cockpit'

// A theme that came out of the unified_marketing_plan action.
interface Theme {
  name: string
  recommendation: string
  suggested_daily_budget_ils: number
  channel: 'organic' | 'paid' | 'both'
}

// Stable, latin-safe id per theme so meta-ads-draft can dedupe re-clicks.
// (Theme names are Hebrew, so a plain slug collapses to nothing — hash instead.)
function themeId(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) { h = (Math.imul(31, h) + name.charCodeAt(i)) | 0 }
  return `theme_${(h >>> 0).toString(36)}`
}

type Step = 'building' | 'review' | 'creating' | 'done' | 'error'

interface Asset { url: string; label: string; source: 'product' | 'ig' }

// Distinctive words from a theme name, used to match assets to the campaign
// (e.g. "Brazil Fazenda Sertão …" → matches the Sertão product + IG posts).
const STOP = new Set(['the', 'and', 'for', 'hero', 'product', 'amplification', 'single', 'origin', 'campaign', 'audience', ' קפה', 'פולי'])
function keywordsFrom(s: string): string[] {
  return (s.match(/[A-Za-z֐-׿]{3,}/g) ?? []).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w))
}

export function DraftCampaignDrawer({ theme, onClose }: { theme: Theme; onClose: () => void }) {
  const [step, setStep] = useState<Step>('building')
  const [spec, setSpec] = useState<any>(null)
  const [imageUrl, setImageUrl] = useState('')
  const [assets, setAssets] = useState<Asset[]>([])
  const [landingUrl, setLandingUrl] = useState('')
  const [result, setResult] = useState<{ campaign_id: string; edit_url: string; warnings: string[]; existed?: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const ideaId = themeId(theme.name)

  // On open: generate the spec, and load existing product images to pick from.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { data, error } = await supabase.functions.invoke('marketing-advisor', {
          body: {
            agent: 'build_meta_campaign',
            idea: `${theme.name} — ${theme.recommendation}`.slice(0, 600),
            audience_lens: 'auto',
            daily_budget_ils: theme.suggested_daily_budget_ils || 50,
          },
        })
        if (!alive) return
        if (error) throw error
        if (!data?.success) throw new Error(data?.error ?? 'בניית המפרט נכשלה')
        setSpec(data.spec)
        setStep('review')
      } catch (e: any) {
        if (!alive) return
        setError(e?.message ?? 'שגיאה'); setStep('error')
      }
    })()
    // Real assets to reuse as the creative: product images + recent IG posts.
    // Auto-match to this campaign's product so we never fall back to a random
    // image. Owner still picks/overrides — human gate keeps it on-brand.
    ;(async () => {
      const kws = keywordsFrom(theme.name)
      const [prodRes, igRes] = await Promise.all([
        supabase.from('woo_products').select('name, image_url, permalink').not('image_url', 'is', null).limit(40),
        supabase.from('meta_organic_posts').select('message, thumbnail_url').not('thumbnail_url', 'is', null).order('created_at', { ascending: false }).limit(30),
      ])
      if (!alive) return
      const prods = (prodRes.data ?? []) as any[]
      const prodAssets: Asset[] = prods.map((p) => ({ url: p.image_url, label: p.name, source: 'product' as const }))
      const igAssets: Asset[]   = (igRes.data ?? []).map((p: any) => ({ url: p.thumbnail_url, label: (p.message || 'Instagram').slice(0, 60), source: 'ig' as const }))
      const all = [...prodAssets, ...igAssets]
      const matches = (a: Asset) => kws.some((k) => a.label.toLowerCase().includes(k))
      setAssets([...all.filter(matches), ...all.filter((a) => !matches(a))]) // matched first
      const best = all.find((a) => a.source === 'product' && matches(a)) || all.find(matches)
      if (best) setImageUrl(best.url) // pre-select the matched real asset
      // Real landing page = the matched product's ACTUAL permalink, never a guess.
      const matchedProd = prods.find((p) => kws.some((k) => String(p.name).toLowerCase().includes(k)))
      if (matchedProd?.permalink) setLandingUrl(matchedProd.permalink)
    })()
    return () => { alive = false }
  }, [theme.name])

  async function createDraft() {
    if (!imageUrl.trim()) { setError('נדרש URL תמונה ציבורי'); return }
    setStep('creating'); setError(null)
    try {
      // Use the matched product's real permalink for the destination — never the
      // model's guessed/commentary-laden landing_page_url.
      const finalSpec = landingUrl ? { ...spec, landing_page_url: landingUrl } : spec
      const { data, error } = await supabase.functions.invoke('meta-ads-draft', {
        body: { action: 'create', idea_id: ideaId, spec: finalSpec, image_url: imageUrl.trim() },
      })
      if (error) throw error
      if (!data?.ok) throw new Error(data?.error ?? 'יצירת הטיוטה נכשלה')
      setResult({ campaign_id: data.campaign_id, edit_url: data.edit_url, warnings: data.warnings ?? [], existed: data.existed })
      setStep('done')
    } catch (e: any) {
      setError(e?.message ?? 'שגיאה'); setStep('review')
    }
  }

  const c = spec?.creative ?? {}
  const a = spec?.audience ?? {}

  // Drawer basics: focus the close button on open, Escape closes, focus
  // returns to whatever opened it, and the page underneath does not scroll.
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      opener?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const LABEL = 'text-[12.5px] text-surface-500'
  const SECTION = 'card-flush p-4'

  return (
    <div className="fixed inset-0 z-50 flex" dir="rtl">
      <div className="cockpit-scrim fixed inset-0 bg-[rgba(28,33,26,0.32)]" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="draft-drawer-title"
        className="cockpit-drawer relative ml-auto w-full max-w-md bg-[var(--bg)] h-full overflow-y-auto overscroll-contain shadow-[0_8px_24px_rgba(28,33,26,0.10)]"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white border-b border-surface-200 ps-5 pe-2 py-2 flex items-center justify-between gap-3 min-h-14">
          <div className="min-w-0">
            <h2 id="draft-drawer-title" className="text-[17px] font-semibold text-surface-900">בניית טיוטת קמפיין</h2>
            <p className="text-[13px] text-surface-500 truncate">{theme.name}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="סגירה"
            className="btn-ghost shrink-0 w-10 h-10 px-0 text-surface-600"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          {step === 'building' && (
            <div className="text-center py-14" role="status">
              <Loader2 size={20} aria-hidden="true" className="text-surface-400 mx-auto mb-3 animate-spin" />
              <p className="text-sm text-surface-700">מפרט הקמפיין נבנה מהתובנה…</p>
            </div>
          )}

          {step === 'error' && (
            <Notice tone="danger" icon={<AlertCircle />} title="בניית המפרט נכשלה">{error}</Notice>
          )}

          {(step === 'review' || step === 'creating') && spec && (
            <>
              {/* Spec review — what will be created, all PAUSED */}
              <section className={`${SECTION} space-y-3`} aria-label="מפרט הקמפיין">
                <div>
                  <p className={LABEL}>שם הקמפיין</p>
                  <p className="text-sm font-medium text-surface-900 break-words">{spec.campaign_name}</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="min-w-0">
                    <p className={LABEL}>מטרה</p>
                    <p className="text-sm text-surface-700 break-words" dir="auto">{spec.objective}</p>
                  </div>
                  <div>
                    <p className={LABEL}>תקציב יומי</p>
                    <p className="text-sm text-surface-900 font-medium num">{formatCurrency(spec.daily_budget_ils ?? 0)}</p>
                  </div>
                </div>
                {a.age_range && (
                  <div>
                    <p className={`${LABEL} flex items-center gap-1.5`}><Users size={14} aria-hidden="true" /> קהל</p>
                    <p className="text-sm text-surface-700 num">{a.age_range} · {a.geo ?? 'ישראל'}{Array.isArray(a.interests_or_behaviors) && a.interests_or_behaviors.length ? ` · ${a.interests_or_behaviors.slice(0, 3).join(', ')}` : ''}</p>
                  </div>
                )}
                <div className="pt-3 border-t border-surface-200">
                  <p className={LABEL}>דף הנחיתה</p>
                  <p className="text-[13px] text-surface-700 break-all text-right" dir="ltr">
                    {landingUrl || String(spec.landing_page_url || '').match(/https?:\/\/[^\s]+/)?.[0] || 'דף הבית'}
                  </p>
                </div>
              </section>

              {/* Creative copy (Hebrew, brand-guarded by the generator) */}
              <section className={`${SECTION} space-y-1.5`} aria-label="קריאייטיב">
                <p className={LABEL}>קריאייטיב</p>
                {c.headline && <p className="text-sm font-semibold text-surface-900">{c.headline}</p>}
                {c.primary_text && <p className="text-sm text-surface-700 leading-relaxed">{c.primary_text}</p>}
                {c.cta_button && <span className="inline-block mt-1 tag" dir="ltr">{c.cta_button}</span>}
              </section>

              {/* Image — pick a REAL matched asset (product image or IG post), or paste a URL */}
              <section className={SECTION} aria-labelledby="draft-image-label">
                <p id="draft-image-label" className="text-sm font-medium text-surface-900 flex items-center gap-1.5">
                  <ImageIcon size={16} aria-hidden="true" className="text-surface-500" /> תמונת המודעה
                </p>
                <p className="text-[12.5px] text-surface-500 mt-0.5 mb-3">נכסים אמיתיים. המתאימים למוצר מופיעים ראשונים.</p>
                {assets.length > 0 ? (
                  <div className="flex gap-2 overflow-x-auto pb-2 mb-2 -mx-1 px-1 pt-1">
                    {assets.slice(0, 18).map((a) => {
                      const on = imageUrl === a.url
                      return (
                        <button
                          key={a.url}
                          type="button"
                          onClick={() => setImageUrl(a.url)}
                          aria-pressed={on}
                          aria-label={`${a.source === 'ig' ? 'אינסטגרם' : 'מוצר'}: ${a.label}`}
                          title={`${a.source === 'ig' ? 'אינסטגרם' : 'מוצר'} · ${a.label}`}
                          className={`relative shrink-0 w-16 h-16 rounded-lg overflow-hidden cursor-pointer transition-[box-shadow,transform] duration-150 active:scale-[0.97] ${on ? 'ring-2 ring-brand-600 ring-offset-2 ring-offset-white' : 'ring-1 ring-surface-200 [@media(hover:hover)]:hover:ring-surface-400'}`}
                        >
                          <img src={a.url} alt="" className="w-full h-full object-cover" />
                          <span className="absolute bottom-1 right-1 px-1 rounded-[4px] bg-white/90 text-[10px] font-medium leading-4 text-surface-700">
                            {a.source === 'ig' ? 'IG' : 'מוצר'}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-[13px] text-surface-500 mb-2">טוען נכסים…</p>
                )}
                <label htmlFor="draft-image-url" className="sr-only">כתובת תמונה</label>
                <input
                  id="draft-image-url"
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="או הדביקו URL…"
                  dir="ltr"
                  className="field text-[13px]"
                />
                {!imageUrl && (
                  <p className="text-[12.5px] text-warn mt-1.5 flex items-center gap-1.5">
                    <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-warn-dot" />
                    בחרו תמונה כדי להמשיך
                  </p>
                )}
              </section>

              {error && <Notice tone="danger" icon={<AlertCircle />}>{error}</Notice>}

              {/* The gate: everything created is PAUSED, under the budget cap. */}
              <Notice icon={<ShieldCheck className="text-brand-600" />}>
                נוצר במצב מושהה (PAUSED) בלבד. שום דבר לא מתפרסם ולא מוציא כסף עד שמפעילים ידנית ב-Ads Manager. כפוף לתקרת התקציב.
              </Notice>

              <button
                type="button"
                onClick={createDraft}
                disabled={step === 'creating'}
                className="btn-primary w-full h-11"
              >
                {step === 'creating' ? <><Loader2 size={16} aria-hidden="true" className="animate-spin" /> הטיוטה נוצרת…</> : 'אישור ויצירת טיוטה מושהית'}
              </button>
            </>
          )}

          {step === 'done' && result && (
            <div className="text-center py-8 space-y-4" role="status">
              <CheckCircle2 size={32} aria-hidden="true" className="text-ok mx-auto" />
              <div>
                <p className="text-[17px] font-semibold text-surface-900">{result.existed ? 'הטיוטה כבר קיימת' : 'נוצרה טיוטה מושהית'}</p>
                <p className="text-[13px] text-surface-500 mt-1 num">קמפיין <span dir="ltr">{result.campaign_id}</span> · מצב PAUSED</p>
              </div>
              {result.warnings?.length > 0 && (
                <div className="text-right">
                  <Notice tone="warn" icon={<AlertTriangle />}>
                    <ul className="space-y-1">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                  </Notice>
                </div>
              )}
              <a
                href={result.edit_url} target="_blank" rel="noopener noreferrer"
                className="btn-primary"
              >
                פתיחה ב-Ads Manager לבדיקה והפעלה <ExternalLink size={16} aria-hidden="true" />
              </a>
              <button type="button" onClick={onClose} className="block mx-auto h-9 px-3 rounded-lg text-sm text-surface-600 transition-colors duration-150 [@media(hover:hover)]:hover:bg-surface-100 [@media(hover:hover)]:hover:text-surface-900 cursor-pointer">סגירה</button>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
