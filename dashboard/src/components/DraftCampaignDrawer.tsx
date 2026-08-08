import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { formatCurrency } from '../lib/utils'
import {
  X, Loader2, ExternalLink, CheckCircle2, AlertTriangle,
  Users, Megaphone, Image as ImageIcon,
} from 'lucide-react'

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
        supabase.from('woo_products').select('name, image_url').not('image_url', 'is', null).limit(40),
        supabase.from('meta_organic_posts').select('message, thumbnail_url').not('thumbnail_url', 'is', null).order('created_at', { ascending: false }).limit(30),
      ])
      if (!alive) return
      const prodAssets: Asset[] = (prodRes.data ?? []).map((p: any) => ({ url: p.image_url, label: p.name, source: 'product' as const }))
      const igAssets: Asset[]   = (igRes.data ?? []).map((p: any) => ({ url: p.thumbnail_url, label: (p.message || 'Instagram').slice(0, 60), source: 'ig' as const }))
      const all = [...prodAssets, ...igAssets]
      const matches = (a: Asset) => kws.some((k) => a.label.toLowerCase().includes(k))
      setAssets([...all.filter(matches), ...all.filter((a) => !matches(a))]) // matched first
      const best = all.find((a) => a.source === 'product' && matches(a)) || all.find(matches)
      if (best) setImageUrl(best.url) // pre-select the matched real asset
    })()
    return () => { alive = false }
  }, [theme.name])

  async function createDraft() {
    if (!imageUrl.trim()) { setError('נדרש URL תמונה ציבורי'); return }
    setStep('creating'); setError(null)
    try {
      const { data, error } = await supabase.functions.invoke('meta-ads-draft', {
        body: { action: 'create', idea_id: ideaId, spec, image_url: imageUrl.trim() },
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

  return (
    <div className="fixed inset-0 z-50 flex" dir="rtl">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <aside className="relative ml-auto w-full max-w-md bg-surface-50 h-full overflow-y-auto shadow-xl">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-surface-200 px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Megaphone size={18} className="text-brand-600" />
            <h2 className="font-display text-lg font-semibold text-surface-900">בניית טיוטת קמפיין</h2>
          </div>
          <button onClick={onClose} aria-label="סגור" className="p-2 -m-2 text-surface-400 hover:text-surface-700 cursor-pointer"><X size={20} /></button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-surface-500">{theme.name}</p>

          {step === 'building' && (
            <div className="text-center py-12">
              <Loader2 size={24} className="text-brand-500 mx-auto mb-3 animate-spin" />
              <p className="text-sm text-surface-600">בונה מפרט קמפיין מהתובנה…</p>
            </div>
          )}

          {step === 'error' && (
            <div className="bg-red-50 border border-red-100 text-red-700 rounded-2xl p-4 text-sm">{error}</div>
          )}

          {(step === 'review' || step === 'creating') && spec && (
            <>
              {/* Spec review — what will be created, all PAUSED */}
              <div className="bg-white border border-surface-200 rounded-2xl p-4 space-y-3">
                <div>
                  <p className="text-xs text-surface-400 mb-0.5">שם קמפיין</p>
                  <p className="text-sm font-medium text-surface-900">{spec.campaign_name}</p>
                </div>
                <div className="flex gap-4">
                  <div>
                    <p className="text-xs text-surface-400 mb-0.5">מטרה</p>
                    <p className="text-sm text-surface-700">{spec.objective}</p>
                  </div>
                  <div>
                    <p className="text-xs text-surface-400 mb-0.5">תקציב יומי</p>
                    <p className="text-sm text-surface-700">{formatCurrency(spec.daily_budget_ils ?? 0)}</p>
                  </div>
                </div>
                {a.age_range && (
                  <div className="flex items-start gap-1.5 text-sm text-surface-600">
                    <Users size={14} className="mt-0.5 text-surface-400 shrink-0" />
                    <span>{a.age_range} · {a.geo ?? 'ישראל'}{Array.isArray(a.interests_or_behaviors) && a.interests_or_behaviors.length ? ` · ${a.interests_or_behaviors.slice(0, 3).join(', ')}` : ''}</span>
                  </div>
                )}
              </div>

              {/* Creative copy (Hebrew, brand-guarded by the generator) */}
              <div className="bg-white border border-surface-200 rounded-2xl p-4 space-y-2">
                <p className="text-xs text-surface-400">קריאייטיב</p>
                {c.headline && <p className="text-sm font-semibold text-surface-900">{c.headline}</p>}
                {c.primary_text && <p className="text-sm text-surface-700 leading-relaxed">{c.primary_text}</p>}
                {c.cta_button && <span className="inline-block badge bg-brand-50 text-brand-700">{c.cta_button}</span>}
              </div>

              {/* Image — pick a REAL matched asset (product image or IG post), or paste a URL */}
              <div className="bg-white border border-surface-200 rounded-2xl p-4">
                <p className="text-xs text-surface-400 mb-2 flex items-center gap-1.5"><ImageIcon size={13} /> תמונת המודעה — נכסים אמיתיים (המתאימים למוצר מופיעים ראשונים)</p>
                {assets.length > 0 ? (
                  <div className="flex gap-2 overflow-x-auto pb-2 mb-2">
                    {assets.slice(0, 18).map((a) => (
                      <button
                        key={a.url}
                        onClick={() => setImageUrl(a.url)}
                        title={`${a.source === 'ig' ? 'אינסטגרם' : 'מוצר'} · ${a.label}`}
                        className={`relative shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 cursor-pointer transition-all ${imageUrl === a.url ? 'border-brand-500' : 'border-surface-200 hover:border-surface-400'}`}
                      >
                        <img src={a.url} alt={a.label} className="w-full h-full object-cover" />
                        <span className={`absolute bottom-0 inset-x-0 text-[9px] leading-tight text-white text-center ${a.source === 'ig' ? 'bg-pink-600/85' : 'bg-brand-700/85'}`}>
                          {a.source === 'ig' ? 'IG' : 'מוצר'}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-surface-400 mb-2">טוען נכסים…</p>
                )}
                <input
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="או הדביקו URL…"
                  dir="ltr"
                  className="w-full text-xs border border-surface-200 rounded-lg px-2 py-1.5 text-surface-700 focus:border-brand-400 focus:outline-none"
                />
                {!imageUrl && <p className="text-xs text-amber-600 mt-1.5">בחרו תמונה כדי להמשיך</p>}
              </div>

              {error && <div className="bg-red-50 border border-red-100 text-red-700 rounded-xl p-3 text-sm">{error}</div>}

              {/* The gate: everything created is PAUSED, under the budget cap. */}
              <div className="bg-brand-50/60 border border-brand-100 rounded-xl p-3 text-xs text-surface-600 flex items-start gap-1.5">
                <AlertTriangle size={13} className="mt-0.5 text-brand-600 shrink-0" />
                נוצר במצב מושהה (PAUSED) בלבד. שום דבר לא מתפרסם או מוציא כסף עד שתפעילו ידנית ב-Ads Manager. כפוף לתקרת התקציב.
              </div>

              <button
                onClick={createDraft}
                disabled={step === 'creating'}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 transition-colors disabled:opacity-60 cursor-pointer"
              >
                {step === 'creating' ? <><Loader2 size={16} className="animate-spin" /> יוצר טיוטה מושהית…</> : 'אשר וצור טיוטה מושהית'}
              </button>
            </>
          )}

          {step === 'done' && result && (
            <div className="text-center py-8 space-y-4">
              <CheckCircle2 size={40} className="text-emerald-600 mx-auto" />
              <div>
                <p className="font-display text-lg font-semibold text-surface-900">{result.existed ? 'הטיוטה כבר קיימת' : 'נוצרה טיוטה מושהית'}</p>
                <p className="text-sm text-surface-500 mt-1">קמפיין {result.campaign_id} · מצב PAUSED</p>
              </div>
              {result.warnings?.length > 0 && (
                <div className="bg-amber-50 border border-amber-100 text-amber-700 rounded-xl p-3 text-xs text-right">
                  {result.warnings.map((w, i) => <p key={i}>⚠ {w}</p>)}
                </div>
              )}
              <a
                href={result.edit_url} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-surface-900 text-white text-sm font-medium hover:bg-surface-800 transition-colors"
              >
                פתח ב-Ads Manager לבדיקה והפעלה <ExternalLink size={15} />
              </a>
              <button onClick={onClose} className="block mx-auto text-sm text-surface-500 hover:text-surface-800 cursor-pointer">סגור</button>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
