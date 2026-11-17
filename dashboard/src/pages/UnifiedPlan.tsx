import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { formatCurrency } from '../lib/utils'
import { startOfWeek, format } from 'date-fns'
import {
  Megaphone, Search, Layers, RefreshCw, Loader2, AlertCircle, CircleHelp, Wallet, ClipboardList,
} from 'lucide-react'
import { DraftCampaignDrawer } from '../components/DraftCampaignDrawer'
import { BrainChat } from '../components/BrainChat'
import { NeedsYou } from '../components/shared/NeedsYou'
import { Dot, Kpi, Kpis, Notice, SectionHead, Tabs, Tone } from '../components/shared/cockpit'
import MetaAdsPage from './MetaAds'
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

// Channel = a neutral tag with a line icon; confidence = a status dot.
const CHANNEL: Record<Theme['channel'], { label: string; Icon: any }> = {
  paid:    { label: 'ממומן, Meta', Icon: Megaphone },
  organic: { label: 'אורגני',      Icon: Search },
  both:    { label: 'משולב',       Icon: Layers },
}
const CONFIDENCE: Record<Theme['confidence'], Tone> = {
  high:   'ok',
  medium: 'warn',
  low:    'neutral',
}
const CONFIDENCE_HE: Record<Theme['confidence'], string> = {
  high: 'ביטחון גבוה', medium: 'ביטחון בינוני', low: 'ביטחון נמוך',
}

function thisWeekStart(): string {
  return format(startOfWeek(new Date(), { weekStartsOn: 0 }), 'yyyy-MM-dd')
}

// ── Evidence row — the heart of "grounded, not guessing" ──────────────────────
function EvidenceRow({ label, text }: { label: string; text: string }) {
  const unknown = isUnknown(text)
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)] gap-3 py-2 [&+&]:border-t [&+&]:border-surface-200">
      <dt className="text-[13px] text-surface-500">{label}</dt>
      {unknown ? (
        <dd className="flex items-start gap-1.5 text-[13px] text-warn">
          <CircleHelp size={14} aria-hidden="true" className="mt-[3px] shrink-0" />
          {/* Display only: the agent's "unknown:" prefix becomes a Hebrew label. */}
          <span><span className="font-medium">לא ידוע</span>{text.replace(/^\s*unknown\s*:?\s*/i, '') ? `: ${text.replace(/^\s*unknown\s*:?\s*/i, '')}` : ''}</span>
        </dd>
      ) : (
        <dd className="text-[13px] text-surface-700 num">{text}</dd>
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
    <article className="card-flush p-5">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between lg:gap-4 mb-3">
        <h3 className="text-base font-semibold text-surface-900">{t.name}</h3>
        <div className="flex items-center gap-3 shrink-0 text-[13px] text-surface-600">
          <span className="inline-flex items-center gap-1.5">
            <Dot tone={CONFIDENCE[t.confidence]} />{CONFIDENCE_HE[t.confidence]}
          </span>
          <span className="tag">
            <ch.Icon size={13} aria-hidden="true" />{ch.label}
          </span>
        </div>
      </div>

      <p className="text-sm text-surface-900 leading-relaxed mb-4">{t.recommendation}</p>

      <dl className="rounded-lg bg-surface-50 border border-surface-200 px-3.5 py-1 mb-4">
        <EvidenceRow label="אורגני" text={t.evidence?.organic} />
        <EvidenceRow label="ממומן"  text={t.evidence?.paid} />
        <EvidenceRow label="מרווח"  text={t.evidence?.margin} />
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {t.suggested_daily_budget_ils > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-surface-600 num">
            <Wallet size={15} aria-hidden="true" className="text-surface-400" />
            תקציב מוצע <span className="font-medium text-surface-900">{formatCurrency(t.suggested_daily_budget_ils)}</span> ליום
          </span>
        ) : <span />}
        {actionable ? (
          <button
            type="button"
            onClick={() => onDraft(t)}
            className="btn-secondary h-9 px-3 text-[13px]"
          >
            <Megaphone size={15} aria-hidden="true" /> בניית טיוטה מושהית
          </button>
        ) : t.channel !== 'organic' ? (
          <span className="text-[12.5px] text-surface-500">המלצה בלבד, לא נבנית אוטומטית</span>
        ) : null}
      </div>

      {t.unknowns?.length > 0 && (
        <div className="mt-4 pt-3 border-t border-surface-200">
          <p className="text-[13px] font-medium text-surface-700 mb-1 flex items-center gap-2">
            <Dot tone="warn" /> חסר לנו מידע
          </p>
          <ul className="list-disc pr-5 space-y-0.5 marker:text-surface-400">
            {t.unknowns.map((u, i) => (
              <li key={i} className="text-[13px] text-surface-500">{u}</li>
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function stopPoll() { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }

  // The analysis is a ~85s job that runs server-side and writes to
  // advisor_reports; we read/poll that row instead of blocking on the call.
  async function fetchReport(ws: string) {
    const { data } = await supabase
      .from('advisor_reports')
      .select('status, report, error_msg')
      .eq('agent_type', 'unified_plan')
      .eq('week_start', ws)
      .maybeSingle()
    return data as { status: string; report: Plan | null; error_msg: string | null } | null
  }

  function startPolling(ws: string) {
    stopPoll()
    let elapsed = 0
    pollRef.current = setInterval(async () => {
      elapsed += 4
      const r = await fetchReport(ws)
      if (r?.status === 'done' && r.report) { setPlan(r.report); setLoading(false); stopPoll() }
      else if (r?.status === 'error') { setError(r.error_msg || 'הניתוח נכשל'); setLoading(false); stopPoll() }
      else if (elapsed > 180) { setError('הניתוח נמשך זמן רב מהצפוי, נסו שוב'); setLoading(false); stopPoll() }
    }, 4000)
  }

  // On mount: cheap spend KPIs + resume/show any existing plan for this week.
  useEffect(() => {
    supabase.functions.invoke('meta-ads-draft', { body: { action: 'spend' } })
      .then(({ data }) => { if (data?.ok) setSpend(data as Spend) })
      .catch(() => { /* KPIs are best-effort */ })

    const ws = thisWeekStart()
    fetchReport(ws).then((r) => {
      if (r?.status === 'done' && r.report) setPlan(r.report)
      else if (r?.status === 'running') { setLoading(true); startPolling(ws) }
    }).catch(() => { /* best-effort */ })

    return () => stopPoll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runAnalysis() {
    const ws = thisWeekStart()
    setLoading(true); setError(null); setPlan(null)
    try {
      // Trigger — returns 202 immediately; the work happens server-side.
      const { error } = await supabase.functions.invoke('marketing-advisor', {
        body: { agent: 'unified_marketing_plan', week_start: ws },
      })
      if (error) throw error
      startPolling(ws)
    } catch (e: any) {
      setError(e?.message ?? 'שגיאה לא ידועה'); setLoading(false)
    }
  }

  const themeCount = plan ? plan.themes?.length ?? 0 : null

  return (
    <div className="fade-up space-y-5">
      <SectionHead
        title="התוכנית של השבוע"
        sub="אורגני וממומן יחד. כל המלצה נשענת על נתונים אמיתיים, ומה שלא ידוע מסומן."
        actions={
          <button
            type="button"
            onClick={runAnalysis}
            disabled={loading}
            className={`${plan ? 'btn-secondary' : 'btn-primary'} w-full lg:w-auto`}
          >
            {loading
              ? <Loader2 size={16} aria-hidden="true" className="animate-spin" />
              : <RefreshCw size={16} aria-hidden="true" />}
            {loading ? 'הניתוח רץ…' : plan ? 'רענון הניתוח' : 'הפעלת ניתוח'}
          </button>
        }
      />

      {/* Spend guardrail KPIs */}
      <Kpis label="תקציב Meta">
        <Kpi label="הוצאת Meta החודש" value={spend ? formatCurrency(spend.month_to_date) : '—'}
          note={spend ? `בחודש שעבר ${formatCurrency(spend.last_month)}` : 'לפי Meta'} />
        <Kpi label="נותר עד התקרה" value={spend ? formatCurrency(spend.remaining_under_cap) : '—'}
          note={spend ? `מתוך תקרה חודשית של ${formatCurrency(spend.monthly_cap)}` : 'תקרה חודשית'} />
        <Kpi label="מחויב בטיוטות" value={spend ? formatCurrency(spend.committed_drafts_this_month) : '—'}
          note="טיוטות מושהות שנבנו החודש" />
        <Kpi label="נושאים בתוכנית" value={themeCount ?? '—'}
          note={plan ? 'בתוכנית של השבוע' : 'עדיין לא הופעל ניתוח'} />
      </Kpis>

      {/* Body */}
      {error && <Notice tone="danger" icon={<AlertCircle />} title="הניתוח לא הושלם">{error}</Notice>}

      {!plan && !loading && !error && (
        <div className="card-flush px-6 py-10 text-center">
          <ClipboardList size={22} aria-hidden="true" className="text-surface-400 mx-auto mb-3" />
          <p className="text-[15px] font-medium text-surface-900">עדיין לא הופעל ניתוח לשבוע הזה</p>
          <p className="text-[13px] text-surface-500 mt-1 max-w-md mx-auto text-pretty">הניתוח אוסף נתוני אורגני, ממומן ומכירות ומחזיר תוכנית מבוססת נתונים. זה לוקח כדקה.</p>
        </div>
      )}

      {loading && (
        <div className="card-flush px-6 py-10 text-center" role="status">
          <Loader2 size={20} aria-hidden="true" className="text-surface-400 mx-auto mb-3 animate-spin" />
          <p className="text-sm text-surface-700">אוסף נתונים ומנתח. זה לוקח כדקה, אפשר להישאר בעמוד.</p>
        </div>
      )}

      {plan && !loading && (
        <div className="space-y-4">
          {plan.summary && (
            <section aria-label="סיכום" className="card-flush p-5">
              <p className="text-[13px] text-surface-500 mb-1.5">סיכום השבוע</p>
              <p className="text-[15px] text-surface-900 leading-relaxed text-pretty">{plan.summary}</p>
            </section>
          )}

          {plan.themes?.map((t, i) => <ThemeCard key={i} t={t} onDraft={setDrafting} />)}

          {plan.global_unknowns?.length > 0 && (
            <section aria-labelledby="global-unknowns" className="card-flush p-5">
              <h3 id="global-unknowns" className="text-[15px] font-semibold text-surface-900 mb-2 flex items-center gap-2">
                <Dot tone="warn" /> מה חסר כדי לשפר את התוכנית
              </h3>
              <ul className="list-disc pr-5 space-y-1 marker:text-surface-400">
                {plan.global_unknowns.map((u, i) => (
                  <li key={i} className="text-sm text-surface-700">{u}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {drafting && <DraftCampaignDrawer theme={drafting} onClose={() => setDrafting(null)} />}
    </div>
  )
}

// ── Marketing cockpit ─────────────────────────────────────────────────────────
// One page consolidating the marketing views. The unified plan is
// the default tab; the per-channel analytics tabs embed the existing page
// components verbatim (no rewrite) so parity is immediate and reversible.
const COCKPIT_TABS = [
  { id: 'brain',    label: 'מוח שיווקי' },
  { id: 'plan',     label: 'תוכנית' },
  { id: 'meta',     label: 'מודעות Meta' },
  { id: 'ig',       label: 'אינסטגרם' },
  { id: 'gorganic', label: 'Google אורגני' },
] as const
type CockpitTab = typeof COCKPIT_TABS[number]['id']

export default function UnifiedPlanPage() {
  const [tab, setTab] = useState<CockpitTab>('brain')
  return (
    <div className="fade-up space-y-6">
      <header className="page-header mb-0">
        <div>
          <h1>שיווק</h1>
          <p className="page-sub">מה ממתין להחלטה, התוכנית של השבוע והנתונים לפי ערוץ</p>
        </div>
      </header>
      <NeedsYou />
      <div className="space-y-6">
        <Tabs value={tab} onChange={setTab} tabs={COCKPIT_TABS} label="אזורי השיווק" idPrefix="cockpit" />
        <div role="tabpanel" id="cockpit-panel" aria-labelledby={`cockpit-tab-${tab}`}>
          {tab === 'brain'    && <BrainChat />}
          {tab === 'plan'     && <PlanTab />}
          {tab === 'meta'     && <MetaAdsPage />}
          {tab === 'ig'       && <MetaOrganicPage />}
          {tab === 'gorganic' && <GoogleOrganicPage />}
        </div>
      </div>
    </div>
  )
}
