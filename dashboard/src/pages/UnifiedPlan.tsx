import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { formatCurrency } from '../lib/utils'
import { startOfWeek, format } from 'date-fns'
import {
  Megaphone, Search, Layers, AlertTriangle, RefreshCw,
  TrendingUp, ShieldCheck, Wallet, Sparkles,
} from 'lucide-react'
import { DraftCampaignDrawer } from '../components/DraftCampaignDrawer'
import MetaAdsPage from './MetaAds'
import GoogleAdsPage from './GoogleAds'
import MetaOrganicPage from './MetaOrganic'
import GoogleOrganicPage from './GoogleOrganic'

// ── Types — mirror the `unified_marketing_plan` action's JSON output ──────────
interface Evidence { organic: string; paid: string; margin: string }
interface Theme {
  name: string
  evidence: Evidence
  recommendation: string
  channel: 'organic' | 'paid' | 'both'
  suggested_daily_budget_ils: number
  confidence: 'high' | 'medium' | 'low'
  unknowns: string[]
}
interface Plan { summary: string; themes: Theme[]; global_unknowns: string[] }

interface Spend {
  currency: string
  month_to_date: number
  last_month: number
  committed_drafts_this_month: number
  monthly_cap: number
  remaining_under_cap: number
}

// Marks any evidence string the agent flagged as ungrounded, so the UI can
// visually separate "cited data" from "we don't know this yet".
const isUnknown = (s: string) => /^\s*unknown/i.test(s || '')

const CHANNEL: Record<Theme['channel'], { label: string; cls: string; Icon: any }> = {
  paid:    { label: 'ממומן — Meta', cls: 'bg-brand-50 text-brand-700',       Icon: Megaphone },
  organic: { label: 'אורגני',        cls: 'bg-emerald-50 text-emerald-700',   Icon: Search },
  both:    { label: 'משולב',         cls: 'bg-brand-100 text-brand-800',      Icon: Layers },
}
const CONFIDENCE: Record<Theme['confidence'], string> = {
  high:   'badge-success',
  medium: 'badge-warning',
  low:    'bg-surface-100 text-surface-500',
}
const CONFIDENCE_HE: Record<Theme['confidence'], string> = {
  high: 'ביטחון גבוה', medium: 'ביטחון בינוני', low: 'ביטחון נמוך',
}

function thisWeekStart(): string {
  return format(startOfWeek(new Date(), { weekStartsOn: 0 }), 'yyyy-MM-dd')
}

// ── Small stat tile (warm, dense) ─────────────────────────────────────────────
function Stat({ icon: Icon, label, value, sub, tone = 'default' }: {
  icon: any; label: string; value: string; sub?: string
  tone?: 'default' | 'good' | 'warn'
}) {
  const valueTone = tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-brand-700' : 'text-surface-900'
  return (
    <div className="bg-white border border-surface-200 rounded-2xl p-4">
      <div className="flex items-center gap-2 text-surface-400 mb-2">
        <Icon size={15} />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className={`font-display text-2xl font-semibold ${valueTone}`}>{value}</p>
      {sub && <p className="text-xs text-surface-400 mt-1">{sub}</p>}
    </div>
  )
}

// ── Evidence row — the heart of "grounded, not guessing" ──────────────────────
function EvidenceRow({ label, text }: { label: string; text: string }) {
  const unknown = isUnknown(text)
  return (
    <div className="flex gap-2 text-sm">
      <span className="shrink-0 w-16 text-surface-400 font-medium">{label}</span>
      {unknown ? (
        <span className="inline-flex items-start gap-1.5 text-amber-700">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{text}</span>
        </span>
      ) : (
        <span className="text-surface-700">{text}</span>
      )}
    </div>
  )
}

function ThemeCard({ t, onDraft }: { t: Theme; onDraft: (t: Theme) => void }) {
  const ch = CHANNEL[t.channel] ?? CHANNEL.both
  // Meta-actionable = a paid/both theme with a real budget. Google-only and
  // "fix infra first" themes come through with budget 0 → recommendation-only.
  const actionable = (t.channel === 'paid' || t.channel === 'both') && t.suggested_daily_budget_ils > 0
  return (
    <article className="bg-white border border-surface-200 rounded-2xl p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <h3 className="font-display text-lg font-semibold text-surface-900">{t.name}</h3>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`badge ${CONFIDENCE[t.confidence]}`}>{CONFIDENCE_HE[t.confidence]}</span>
          <span className={`inline-flex items-center gap-1 badge ${ch.cls}`}>
            <ch.Icon size={12} />{ch.label}
          </span>
        </div>
      </div>

      <div className="space-y-1.5 mb-4 border-r-2 border-surface-100 pr-3">
        <EvidenceRow label="אורגני" text={t.evidence?.organic} />
        <EvidenceRow label="ממומן"  text={t.evidence?.paid} />
        <EvidenceRow label="מרווח"  text={t.evidence?.margin} />
      </div>

      <p className="text-sm text-surface-800 leading-relaxed mb-4">{t.recommendation}</p>

      <div className="flex flex-wrap items-center gap-2">
        {t.suggested_daily_budget_ils > 0 && (
          <span className="inline-flex items-center gap-1.5 badge bg-brand-50 text-brand-700">
            <Wallet size={12} />
            תקציב מוצע: {formatCurrency(t.suggested_daily_budget_ils)}/יום
          </span>
        )}
        {actionable ? (
          <button
            onClick={() => onDraft(t)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-medium hover:bg-brand-700 transition-colors cursor-pointer"
          >
            <Megaphone size={13} /> בנה טיוטה מושהית
          </button>
        ) : t.channel !== 'organic' ? (
          <span className="text-xs text-surface-400">המלצה בלבד (לא נבנה אוטומטית)</span>
        ) : null}
      </div>

      {t.unknowns?.length > 0 && (
        <div className="mt-4 pt-3 border-t border-surface-100">
          <p className="text-xs font-medium text-amber-700 mb-1.5 flex items-center gap-1.5">
            <AlertTriangle size={12} /> חסר לנו מידע:
          </p>
          <ul className="space-y-1">
            {t.unknowns.map((u, i) => (
              <li key={i} className="text-xs text-surface-500 pr-4 relative before:content-['·'] before:absolute before:right-1">{u}</li>
            ))}
          </ul>
        </div>
      )}
    </article>
  )
}

function PlanTab() {
  const [spend, setSpend] = useState<Spend | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [drafting, setDrafting] = useState<Theme | null>(null)

  // Cheap spend KPIs on mount; the expensive analysis is gated behind a click.
  useEffect(() => {
    supabase.functions.invoke('meta-ads-draft', { body: { action: 'spend' } })
      .then(({ data }) => { if (data?.ok) setSpend(data as Spend) })
      .catch(() => { /* KPIs are best-effort */ })
  }, [])

  async function runAnalysis() {
    setLoading(true); setError(null)
    try {
      const { data, error } = await supabase.functions.invoke('marketing-advisor', {
        body: { agent: 'unified_marketing_plan', week_start: thisWeekStart() },
      })
      if (error) throw error
      if (!data?.ok) throw new Error(data?.error || 'הניתוח נכשל')
      setPlan(data.plan as Plan)
    } catch (e: any) {
      setError(e?.message ?? 'שגיאה לא ידועה')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-semibold text-surface-900">תוכנית שיווק מאוחדת</h1>
          <p className="text-sm text-surface-500 mt-1 flex items-center gap-1.5">
            <Sparkles size={14} className="text-brand-500" />
            אורגני וממומן יחד, כל המלצה מבוססת על נתונים אמיתיים
          </p>
        </div>
        <button
          onClick={runAnalysis}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 transition-colors disabled:opacity-60 cursor-pointer"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          {loading ? 'מנתח…' : plan ? 'רענן ניתוח' : 'הפעל ניתוח'}
        </button>
      </div>

      {/* Spend guardrail KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat icon={Wallet} label="הוצאת Meta החודש" value={spend ? formatCurrency(spend.month_to_date) : '—'} sub={spend ? `חודש שעבר: ${formatCurrency(spend.last_month)}` : undefined} />
        <Stat icon={ShieldCheck} label="נותר עד התקרה" tone="good" value={spend ? formatCurrency(spend.remaining_under_cap) : '—'} sub={spend ? `תקרה חודשית: ${formatCurrency(spend.monthly_cap)}` : undefined} />
        <Stat icon={Megaphone} label="מחויב מטיוטות" tone="warn" value={spend ? formatCurrency(spend.committed_drafts_this_month) : '—'} />
        <Stat icon={Layers} label="תמות בתוכנית" value={plan ? String(plan.themes?.length ?? 0) : '—'} sub={plan ? 'לחצו להרחבה' : 'טרם הופעל'} />
      </div>

      {/* Body */}
      {error && (
        <div className="bg-red-50 border border-red-100 text-red-700 rounded-2xl p-4 text-sm">{error}</div>
      )}

      {!plan && !loading && !error && (
        <div className="bg-white border border-dashed border-surface-200 rounded-2xl p-10 text-center">
          <TrendingUp size={28} className="text-surface-300 mx-auto mb-3" />
          <p className="text-surface-600 font-medium">טרם הופעל ניתוח לשבוע הנוכחי</p>
          <p className="text-sm text-surface-400 mt-1">הפעלת הניתוח אוספת נתוני אורגני, ממומן ומכירות ומחזירה תוכנית מבוססת נתונים. לוקח כ-30-60 שניות.</p>
        </div>
      )}

      {loading && (
        <div className="bg-white border border-surface-200 rounded-2xl p-10 text-center">
          <RefreshCw size={24} className="text-brand-500 mx-auto mb-3 animate-spin" />
          <p className="text-surface-600 text-sm">אוסף נתונים ומנתח… זה לוקח כ-30-60 שניות.</p>
        </div>
      )}

      {plan && !loading && (
        <div className="space-y-4">
          {plan.summary && (
            <div className="bg-brand-50/60 border border-brand-100 rounded-2xl p-5">
              <p className="text-sm text-surface-800 leading-relaxed">{plan.summary}</p>
            </div>
          )}

          {plan.themes?.map((t, i) => <ThemeCard key={i} t={t} onDraft={setDrafting} />)}

          {plan.global_unknowns?.length > 0 && (
            <div className="bg-white border border-surface-200 rounded-2xl p-5">
              <p className="text-sm font-medium text-amber-700 mb-2 flex items-center gap-1.5">
                <AlertTriangle size={14} /> מה חסר כדי לשפר את התוכנית
              </p>
              <ul className="space-y-1">
                {plan.global_unknowns.map((u, i) => (
                  <li key={i} className="text-sm text-surface-600 pr-4 relative before:content-['·'] before:absolute before:right-1">{u}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {drafting && <DraftCampaignDrawer theme={drafting} onClose={() => setDrafting(null)} />}
    </div>
  )
}

// ── Marketing cockpit ─────────────────────────────────────────────────────────
// One page consolidating the Meta + Google marketing views. The unified plan is
// the default tab; the per-channel analytics tabs embed the existing page
// components verbatim (no rewrite) so parity is immediate and reversible.
const COCKPIT_TABS = [
  { id: 'plan',     label: 'תוכנית' },
  { id: 'meta',     label: 'Meta Ads' },
  { id: 'google',   label: 'Google Ads' },
  { id: 'ig',       label: 'אינסטגרם' },
  { id: 'gorganic', label: 'Google אורגני' },
] as const
type CockpitTab = typeof COCKPIT_TABS[number]['id']

export default function UnifiedPlanPage() {
  const [tab, setTab] = useState<CockpitTab>('plan')
  return (
    <div className="space-y-5">
      <div className="flex gap-1 border-b border-surface-200 overflow-x-auto">
        {COCKPIT_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors cursor-pointer ${
              tab === t.id ? 'border-brand-600 text-brand-700' : 'border-transparent text-surface-400 hover:text-surface-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'plan'     && <PlanTab />}
      {tab === 'meta'     && <MetaAdsPage />}
      {tab === 'google'   && <GoogleAdsPage />}
      {tab === 'ig'       && <MetaOrganicPage />}
      {tab === 'gorganic' && <GoogleOrganicPage />}
    </div>
  )
}
