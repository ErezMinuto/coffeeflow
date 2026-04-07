import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { TrendingUp, Shield, Leaf, RefreshCw, AlertCircle, Loader2 } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdvisorReport {
  id: string
  agent_type: 'google_ads_growth' | 'google_ads_efficiency' | 'organic_content'
  week_start: string
  status: 'pending' | 'running' | 'done' | 'error'
  report: GrowthReport | EfficiencyReport | OrganicReport | null
  error_msg: string | null
  model: string | null
  tokens_used: number
}

interface GoogleKPIs {
  total_cost: number
  total_clicks: number
  total_impressions: number
  total_conversions: number
  roas: number
  top_campaign: string
  worst_campaign: string
}

interface BudgetRec {
  platform: string
  campaign: string
  action: 'increase' | 'decrease' | 'pause' | 'keep' | 'test_new'
  reason: string
  suggested_budget_change_pct: number
}

interface GrowthReport {
  agent_philosophy: string
  summary: string
  google: GoogleKPIs | null
  budget_recommendations: BudgetRec[]
  growth_opportunities: { opportunity: string; action: string; expected_impact: string }[]
  key_insights: string[]
  next_week_focus: string
}

interface EfficiencyReport {
  agent_philosophy: string
  summary: string
  google: GoogleKPIs | null
  budget_recommendations: BudgetRec[]
  waste_identified: { campaign: string; issue: string; estimated_waste: string; fix: string }[]
  key_insights: string[]
  next_week_focus: string
}

interface OrganicReport {
  summary: string
  account_health: { avg_reach_30d: number; follower_count: number; best_post_type: string; engagement_rate_pct: number }
  seo_content_opportunities: { keyword: string; search_volume_signal: string; current_position: number; instagram_angle: string }[]
  content_recommendations: { priority: number; content_type: string; topic: string; reason: string; caption_idea: string; best_day: string; best_time: string }[]
  products_to_feature: { product: string; reason: string; content_angle: string }[]
  next_week_calendar: { day: string; type: string; topic: string }[]
  key_insights: string[]
  what_worked_last_week: string[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatWeek(weekStart: string) {
  const d = new Date(weekStart)
  const end = new Date(weekStart)
  end.setDate(end.getDate() + 6)
  const fmt = (date: Date) => `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}`
  return `${fmt(d)} – ${fmt(end)}`
}

function actionColor(action: string) {
  switch (action) {
    case 'increase':  return 'border-green-400 bg-green-50'
    case 'test_new':  return 'border-blue-400 bg-blue-50'
    case 'decrease':  return 'border-amber-400 bg-amber-50'
    case 'pause':     return 'border-red-400 bg-red-50'
    default:          return 'border-surface-200 bg-surface-50'
  }
}

function actionLabel(action: string) {
  const map: Record<string, string> = {
    increase: '↑ הגדל', decrease: '↓ הקטן',
    pause: '⏸ השהה', keep: '→ המשך', test_new: '🧪 בדוק',
  }
  return map[action] ?? action
}

function contentTypeIcon(type: string) {
  return ({ reel: '🎬', post: '🖼️', story: '⏱' } as Record<string, string>)[type] ?? '📌'
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AdvisorReport['status'] }) {
  if (status === 'done')    return <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">✓ הושלם</span>
  if (status === 'running') return <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium flex items-center gap-1"><Loader2 size={10} className="animate-spin" />מנתח...</span>
  if (status === 'error')   return <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">✗ שגיאה</span>
  return <span className="text-xs bg-surface-100 text-surface-500 px-2 py-0.5 rounded-full font-medium">ממתין</span>
}

function PanelEmpty({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center text-surface-400">
      <div className="text-3xl mb-2">🤖</div>
      <p className="text-sm text-surface-500">{label} טרם הופעל</p>
    </div>
  )
}

function PanelRunning() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Loader2 size={28} className="animate-spin text-blue-500 mb-2" />
      <p className="text-sm text-surface-500">מנתח נתונים... (~30–60 שניות)</p>
    </div>
  )
}

function PanelError({ msg }: { msg: string }) {
  return (
    <div className="card bg-red-50 border-red-200 flex gap-3">
      <AlertCircle className="text-red-500 shrink-0 mt-0.5" size={16} />
      <p className="text-xs text-red-700 font-mono">{msg}</p>
    </div>
  )
}

function GoogleKPIGrid({ g }: { g: GoogleKPIs }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {[
        { label: 'הוצאה', value: `₪${g.total_cost.toLocaleString()}` },
        { label: 'קליקים', value: g.total_clicks.toLocaleString() },
        { label: 'המרות', value: g.total_conversions },
        { label: 'ROAS', value: `${g.roas}x` },
      ].map(k => (
        <div key={k.label} className="bg-surface-50 rounded-xl p-2.5 text-center">
          <p className="text-base font-bold font-mono text-surface-900">{k.value}</p>
          <p className="text-xs text-surface-400 mt-0.5">{k.label}</p>
        </div>
      ))}
    </div>
  )
}

function BudgetRecs({ recs }: { recs: BudgetRec[] }) {
  if (!recs?.length) return null
  return (
    <div>
      <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">המלצות תקציב</h4>
      <div className="space-y-2">
        {recs.map((r, i) => (
          <div key={i} className={`rounded-xl border-r-4 p-3 ${actionColor(r.action)}`}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold">{actionLabel(r.action)}</span>
              {r.suggested_budget_change_pct !== 0 && (
                <span className="text-xs font-mono bg-white px-1.5 py-0.5 rounded">
                  {r.suggested_budget_change_pct > 0 ? '+' : ''}{r.suggested_budget_change_pct}%
                </span>
              )}
            </div>
            <p className="text-sm font-medium text-surface-800 truncate">{r.campaign}</p>
            <p className="text-xs text-surface-500 mt-1">{r.reason}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function KeyInsights({ insights }: { insights: string[] }) {
  if (!insights?.length) return null
  return (
    <div>
      <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">תובנות</h4>
      <ul className="space-y-1">
        {insights.map((ins, i) => (
          <li key={i} className="text-sm text-surface-700 flex gap-2">
            <span className="text-surface-300 shrink-0 mt-0.5">•</span>{ins}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Growth Panel ──────────────────────────────────────────────────────────────

function GrowthPanel({ row }: { row: AdvisorReport | null }) {
  if (!row)                     return <PanelEmpty label="סוכן צמיחה" />
  if (row.status === 'running') return <PanelRunning />
  if (row.status === 'error')   return <PanelError msg={row.error_msg ?? 'שגיאה לא ידועה'} />
  if (!row.report)              return <PanelEmpty label="סוכן צמיחה" />
  const r = row.report as GrowthReport

  return (
    <div className="space-y-4">
      <div className="card bg-blue-50 border-blue-100 p-3">
        <p className="text-sm text-blue-900 leading-relaxed">{r.summary}</p>
      </div>

      {r.google && <GoogleKPIGrid g={r.google} />}

      {/* Top / worst campaign */}
      {r.google && (r.google.top_campaign || r.google.worst_campaign) && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          {r.google.top_campaign && (
            <div className="card p-2 bg-green-50 border-green-100">
              <p className="text-green-600 font-medium mb-0.5">🚀 לסקייל</p>
              <p className="text-surface-700 truncate">{r.google.top_campaign}</p>
            </div>
          )}
          {r.google.worst_campaign && (
            <div className="card p-2 bg-amber-50 border-amber-100">
              <p className="text-amber-600 font-medium mb-0.5">⚠️ לטפל</p>
              <p className="text-surface-700 truncate">{r.google.worst_campaign}</p>
            </div>
          )}
        </div>
      )}

      <BudgetRecs recs={r.budget_recommendations} />

      {/* Growth opportunities */}
      {r.growth_opportunities?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">הזדמנויות צמיחה</h4>
          <div className="space-y-2">
            {r.growth_opportunities.map((op, i) => (
              <div key={i} className="card p-3 border-r-4 border-blue-400 bg-blue-50">
                <p className="text-sm font-medium text-blue-900 mb-1">{op.opportunity}</p>
                <p className="text-xs text-blue-700 mb-1">▶ {op.action}</p>
                <p className="text-xs text-blue-600 italic">{op.expected_impact}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <KeyInsights insights={r.key_insights} />

      {r.next_week_focus && (
        <div className="card bg-surface-800 text-white p-4">
          <p className="text-xs font-semibold text-surface-300 mb-1">מוקד שבוע הבא</p>
          <p className="text-sm leading-relaxed">{r.next_week_focus}</p>
        </div>
      )}
    </div>
  )
}

// ── Efficiency Panel ──────────────────────────────────────────────────────────

function EfficiencyPanel({ row }: { row: AdvisorReport | null }) {
  if (!row)                     return <PanelEmpty label="סוכן יעילות" />
  if (row.status === 'running') return <PanelRunning />
  if (row.status === 'error')   return <PanelError msg={row.error_msg ?? 'שגיאה לא ידועה'} />
  if (!row.report)              return <PanelEmpty label="סוכן יעילות" />
  const r = row.report as EfficiencyReport

  return (
    <div className="space-y-4">
      <div className="card bg-amber-50 border-amber-100 p-3">
        <p className="text-sm text-amber-900 leading-relaxed">{r.summary}</p>
      </div>

      {r.google && <GoogleKPIGrid g={r.google} />}

      {r.google && (r.google.top_campaign || r.google.worst_campaign) && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          {r.google.top_campaign && (
            <div className="card p-2 bg-green-50 border-green-100">
              <p className="text-green-600 font-medium mb-0.5">🏆 ROAS מוביל</p>
              <p className="text-surface-700 truncate">{r.google.top_campaign}</p>
            </div>
          )}
          {r.google.worst_campaign && (
            <div className="card p-2 bg-red-50 border-red-100">
              <p className="text-red-600 font-medium mb-0.5">🔥 בזבוז</p>
              <p className="text-surface-700 truncate">{r.google.worst_campaign}</p>
            </div>
          )}
        </div>
      )}

      <BudgetRecs recs={r.budget_recommendations} />

      {/* Waste identified */}
      {r.waste_identified?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">בזבוז מזוהה</h4>
          <div className="space-y-2">
            {r.waste_identified.map((w, i) => (
              <div key={i} className="card p-3 border-r-4 border-red-400 bg-red-50">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-medium text-red-900 truncate">{w.campaign}</p>
                  {w.estimated_waste && (
                    <span className="text-xs font-mono bg-red-100 text-red-700 px-1.5 py-0.5 rounded shrink-0 mr-2">
                      {w.estimated_waste}
                    </span>
                  )}
                </div>
                <p className="text-xs text-red-700 mb-1">{w.issue}</p>
                <p className="text-xs text-surface-600">✓ {w.fix}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <KeyInsights insights={r.key_insights} />

      {r.next_week_focus && (
        <div className="card bg-surface-800 text-white p-4">
          <p className="text-xs font-semibold text-surface-300 mb-1">מוקד שבוע הבא</p>
          <p className="text-sm leading-relaxed">{r.next_week_focus}</p>
        </div>
      )}
    </div>
  )
}

// ── Organic Panel ─────────────────────────────────────────────────────────────

function OrganicPanel({ row }: { row: AdvisorReport | null }) {
  if (!row)                     return <PanelEmpty label="סוכן תוכן אורגני" />
  if (row.status === 'running') return <PanelRunning />
  if (row.status === 'error')   return <PanelError msg={row.error_msg ?? 'שגיאה לא ידועה'} />
  if (!row.report)              return <PanelEmpty label="סוכן תוכן אורגני" />
  const r = row.report as OrganicReport

  return (
    <div className="space-y-4">
      <div className="card bg-green-50 border-green-100 p-3">
        <p className="text-sm text-green-900 leading-relaxed">{r.summary}</p>
      </div>

      {/* Account health */}
      {r.account_health && (
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: 'reach ממוצע', value: r.account_health.avg_reach_30d.toLocaleString() },
            { label: 'עוקבים', value: r.account_health.follower_count.toLocaleString() },
            { label: 'engagement', value: `${r.account_health.engagement_rate_pct}%` },
            { label: 'תוכן מוביל', value: r.account_health.best_post_type === 'reel' ? '🎬 ריילס' : r.account_health.best_post_type === 'post' ? '🖼️ פוסט' : '⏱ סטורי' },
          ].map(k => (
            <div key={k.label} className="bg-surface-50 rounded-xl p-2.5 text-center">
              <p className="text-base font-bold font-mono text-surface-900">{k.value}</p>
              <p className="text-xs text-surface-400 mt-0.5">{k.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* SEO content opportunities */}
      {r.seo_content_opportunities?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">הזדמנויות SEO → אינסטגרם</h4>
          <div className="space-y-2">
            {r.seo_content_opportunities.slice(0, 3).map((op, i) => (
              <div key={i} className="card p-3 border-r-4 border-purple-400 bg-purple-50">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-medium text-purple-900">"{op.keyword}"</p>
                  <span className="text-xs text-purple-600 font-mono shrink-0 mr-2">מיקום {op.current_position}</span>
                </div>
                <p className="text-xs text-purple-700">{op.instagram_angle}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Content calendar */}
      {r.next_week_calendar?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">לוח תוכן לשבוע הבא</h4>
          <div className="space-y-1.5">
            {r.next_week_calendar.map((item, i) => (
              <div key={i} className="card p-2.5 flex items-center gap-3">
                <span className="text-lg">{contentTypeIcon(item.type)}</span>
                <div>
                  <span className="text-xs font-medium text-surface-500">{item.day}</span>
                  <p className="text-sm text-surface-800">{item.topic}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Content recommendations */}
      {r.content_recommendations?.slice(0, 2).map((rec, i) => (
        <div key={i} className="card p-3 border-r-4 border-green-400">
          <div className="flex items-center gap-2 mb-1">
            <span>{contentTypeIcon(rec.content_type)}</span>
            <span className="text-xs text-surface-500">{rec.best_day} · {rec.best_time}</span>
          </div>
          <p className="font-medium text-surface-800 text-sm mb-1">{rec.topic}</p>
          <p className="text-xs text-surface-500 mb-1">{rec.reason}</p>
          {rec.caption_idea && (
            <blockquote className="text-xs text-surface-600 bg-surface-50 border-r-2 border-surface-200 pr-2 py-1 italic">
              "{rec.caption_idea}"
            </blockquote>
          )}
        </div>
      ))}

      {/* Products to feature */}
      {r.products_to_feature?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">מוצרים לקדם</h4>
          <div className="space-y-1.5">
            {r.products_to_feature.map((p, i) => (
              <div key={i} className="card p-2.5">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-surface-800">{p.product}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${p.reason === 'low_stock_urgency' ? 'bg-red-100 text-red-600' : p.reason === 'new_batch' ? 'bg-blue-100 text-blue-600' : 'bg-amber-100 text-amber-600'}`}>
                    {p.reason === 'low_stock_urgency' ? '⚠️ מלאי נמוך' : p.reason === 'new_batch' ? '✨ חדש' : '🏆 מוביל'}
                  </span>
                </div>
                <p className="text-xs text-surface-500">{p.content_angle}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <KeyInsights insights={r.key_insights} />
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const ALL_AGENT_TYPES = ['google_ads_growth', 'google_ads_efficiency', 'organic_content'] as const
type AgentType = typeof ALL_AGENT_TYPES[number]

export default function AdvisorPage() {
  const [rows, setRows]               = useState<Record<AgentType, AdvisorReport | null>>({
    google_ads_growth: null, google_ads_efficiency: null, organic_content: null,
  })
  const [availableWeeks, setAvailableWeeks] = useState<string[]>([])
  const [selectedWeek, setSelectedWeek]     = useState<string | null>(null)
  const [loading, setLoading]               = useState(true)
  const [running, setRunning]               = useState(false)
  const [focus, setFocus]                   = useState<string>(() => localStorage.getItem('advisor_focus') ?? '')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    loadWeeks()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  useEffect(() => {
    if (selectedWeek) loadReports(selectedWeek)
  }, [selectedWeek])

  async function loadWeeks() {
    setLoading(true)
    const { data } = await supabase
      .from('advisor_reports')
      .select('week_start')
      .in('status', ['done', 'running', 'error'])
      .order('week_start', { ascending: false })
      .limit(16)

    const weeks = [...new Set((data ?? []).map((r: { week_start: string }) => r.week_start))].sort((a, b) => b.localeCompare(a))
    setAvailableWeeks(weeks)
    const latest = weeks[0] ?? null
    setSelectedWeek(latest)
    if (latest) await loadReports(latest)
    else setLoading(false)
  }

  async function loadReports(weekStart: string) {
    setLoading(true)
    const { data } = await supabase
      .from('advisor_reports')
      .select('*')
      .in('agent_type', ALL_AGENT_TYPES as unknown as string[])
      .eq('week_start', weekStart)

    const fetched = (data ?? []) as AdvisorReport[]
    const newRows = { ...rows }
    for (const type of ALL_AGENT_TYPES) {
      newRows[type] = fetched.find(r => r.agent_type === type) ?? null
    }
    setRows(newRows)
    setLoading(false)

    if (fetched.some(r => r.status === 'running')) startPolling(weekStart)
  }

  function startPolling(weekStart: string) {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      const { data } = await supabase
        .from('advisor_reports')
        .select('*')
        .in('agent_type', ALL_AGENT_TYPES as unknown as string[])
        .eq('week_start', weekStart)

      const fetched = (data ?? []) as AdvisorReport[]
      const newRows = { google_ads_growth: null, google_ads_efficiency: null, organic_content: null } as Record<AgentType, AdvisorReport | null>
      for (const type of ALL_AGENT_TYPES) {
        newRows[type] = fetched.find(r => r.agent_type === type) ?? null
      }
      setRows(newRows)

      if (!fetched.some(r => r.status === 'running')) {
        clearInterval(pollRef.current!)
        setRunning(false)
        await loadWeeks()
      }
    }, 5000)
  }

  async function runAdvisor() {
    setRunning(true)
    await supabase.functions.invoke('marketing-advisor', {
      body: { trigger: 'manual', agent: 'all', focus: focus.trim() || undefined },
    })
    await loadWeeks()
    if (selectedWeek) startPolling(selectedWeek)
  }

  const isRunning = Object.values(rows).some(r => r?.status === 'running') || running

  const panels = [
    {
      key: 'google_ads_growth' as AgentType,
      label: 'Google Ads — צמיחה',
      sublabel: 'סקייל · הגדלת תקציב · חיפוש הזדמנויות',
      icon: <TrendingUp size={16} className="text-blue-500" />,
      headerColor: 'border-blue-100',
      component: (row: AdvisorReport | null) => <GrowthPanel row={row} />,
    },
    {
      key: 'google_ads_efficiency' as AgentType,
      label: 'Google Ads — יעילות',
      sublabel: 'ROAS · חיתוך בזבוז · שיפור רווחיות',
      icon: <Shield size={16} className="text-amber-500" />,
      headerColor: 'border-amber-100',
      component: (row: AdvisorReport | null) => <EfficiencyPanel row={row} />,
    },
    {
      key: 'organic_content' as AgentType,
      label: 'תוכן אורגני',
      sublabel: 'אינסטגרם · Google Search · מלאי',
      icon: <Leaf size={16} className="text-green-500" />,
      headerColor: 'border-green-100',
      component: (row: AdvisorReport | null) => <OrganicPanel row={row} />,
    },
  ]

  return (
    <div className="space-y-6 fade-up">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-display font-semibold text-surface-900">יועץ שיווק AI</h2>
          <p className="text-sm text-surface-400 mt-1">
            {selectedWeek ? `שבוע ${formatWeek(selectedWeek)}` : 'טרם הופעל'} · 3 סוכנים
          </p>
        </div>
        <button
          onClick={runAdvisor}
          disabled={isRunning}
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRunning
            ? <><Loader2 size={14} className="animate-spin" /> מנתח...</>
            : <><RefreshCw size={14} /> הרץ עכשיו</>}
        </button>
      </div>

      {/* Focus context */}
      <div className="card p-4 space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-surface-500 uppercase tracking-wider">
            הוראות לסוכנים
          </label>
          {focus.trim() && (
            <span className="text-xs text-brand-600 font-medium">● פעיל</span>
          )}
        </div>
        <textarea
          value={focus}
          onChange={e => { setFocus(e.target.value); localStorage.setItem('advisor_focus', e.target.value) }}
          placeholder="לדוגמה: התמקד במכירות קפה ספשלטי, אנחנו רוצים לגדול בתחום זה. שים דגש על מילות מפתח הקשורות לספשלטי ועל פוסטים שמדגישים את מקור הפולים."
          rows={2}
          dir="rtl"
          className="w-full text-sm border border-surface-200 rounded-xl px-4 py-2.5 bg-surface-50 focus:outline-none focus:ring-2 focus:ring-brand-300 focus:border-brand-400 transition placeholder:text-surface-300 resize-none"
        />
        <p className="text-xs text-surface-400">
          ההוראות יישלחו לכל שלושת הסוכנים בלחיצה על "הרץ עכשיו". נשמר אוטומטית.
        </p>
      </div>

      {/* 3 panels */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {panels.map(({ key, label, sublabel, icon, headerColor, component }) => (
          <div key={key} className="card flex flex-col">
            <div className={`flex items-start justify-between mb-4 pb-3 border-b ${headerColor}`}>
              <div>
                <div className="flex items-center gap-2">
                  {icon}
                  <h3 className="font-display font-semibold text-surface-900 text-sm">{label}</h3>
                </div>
                <p className="text-xs text-surface-400 mt-0.5 mr-6">{sublabel}</p>
              </div>
              {rows[key] && <StatusBadge status={rows[key]!.status} />}
            </div>
            <div className="flex-1">
              {loading
                ? <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-10 bg-surface-100 rounded animate-pulse" />)}</div>
                : component(rows[key])}
            </div>
          </div>
        ))}
      </div>

      {/* Week history */}
      {availableWeeks.length > 1 && (
        <div className="card p-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-surface-400 font-medium ml-2">שבועות קודמים:</span>
            {availableWeeks.map(week => (
              <button
                key={week}
                onClick={() => setSelectedWeek(week)}
                className={`text-xs px-3 py-1.5 rounded-full transition-colors ${week === selectedWeek ? 'bg-surface-900 text-white' : 'bg-surface-100 text-surface-600 hover:bg-surface-200'}`}
              >
                {formatWeek(week)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Full empty state */}
      {!loading && availableWeeks.length === 0 && (
        <div className="card text-center py-20">
          <div className="text-5xl mb-4">🤖</div>
          <h3 className="text-lg font-display font-semibold text-surface-800 mb-2">הסוכנים עדיין לא הופעלו</h3>
          <p className="text-sm text-surface-400 max-w-sm mx-auto mb-6">
            לחץ "הרץ עכשיו" — שלושת הסוכנים ינתחו את הנתונים ויציגו המלצות לשבוע הבא.
          </p>
          <button onClick={runAdvisor} disabled={isRunning} className="btn btn-primary mx-auto flex items-center gap-2">
            <RefreshCw size={14} /> הרץ ניתוח ראשון
          </button>
        </div>
      )}
    </div>
  )
}
