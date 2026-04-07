import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { TrendingUp, Leaf, RefreshCw, AlertCircle, Loader2, ChevronRight, ChevronLeft } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdvisorReport {
  id: string
  agent_type: 'paid_ads' | 'organic_content'
  week_start: string
  status: 'pending' | 'running' | 'done' | 'error'
  report: PaidAdsReport | OrganicReport | null
  error_msg: string | null
  model: string | null
  tokens_used: number
}

interface PaidAdsReport {
  summary: string
  google: {
    total_cost: number
    total_clicks: number
    total_impressions: number
    total_conversions: number
    roas: number
    top_campaign: string
    worst_campaign: string
  } | null
  meta: null
  budget_recommendations: {
    platform: string
    campaign: string
    action: 'increase' | 'decrease' | 'pause' | 'keep'
    reason: string
    suggested_budget_change_pct: number
  }[]
  campaign_changes: {
    platform: string
    campaign: string
    action: string
    reason: string
  }[]
  key_insights: string[]
  next_week_focus: string
}

interface OrganicReport {
  summary: string
  account_health: {
    avg_reach_30d: number
    follower_count: number
    best_post_type: string
    engagement_rate_pct: number
  }
  content_recommendations: {
    priority: number
    content_type: string
    topic: string
    reason: string
    caption_idea: string
    best_day: string
    best_time: string
  }[]
  products_to_feature: {
    product: string
    reason: string
    content_angle: string
  }[]
  next_week_calendar: {
    day: string
    type: string
    topic: string
  }[]
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
    case 'increase':    return 'border-green-400 bg-green-50'
    case 'decrease':    return 'border-amber-400 bg-amber-50'
    case 'pause':       return 'border-red-400 bg-red-50'
    case 'keep':        return 'border-surface-200 bg-surface-50'
    default:            return 'border-surface-200 bg-surface-50'
  }
}

function actionLabel(action: string) {
  const map: Record<string, string> = {
    increase:         '↑ הגדל',
    decrease:         '↓ הקטן',
    pause:            '⏸ השהה',
    keep:             '→ המשך',
    activate:         '▶ הפעל',
    test_new_creative:'🎨 בדוק קריאייטיב',
    review_targeting: '🎯 בדוק טירגוט',
  }
  return map[action] ?? action
}

function contentTypeIcon(type: string) {
  const map: Record<string, string> = { reel: '🎬', post: '🖼️', story: '⏱' }
  return map[type] ?? '📌'
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AdvisorReport['status'] }) {
  if (status === 'done')    return <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">✓ הושלם</span>
  if (status === 'running') return <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium flex items-center gap-1"><Loader2 size={10} className="animate-spin" />מנתח...</span>
  if (status === 'error')   return <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">✗ שגיאה</span>
  return <span className="text-xs bg-surface-100 text-surface-500 px-2 py-0.5 rounded-full font-medium">ממתין</span>
}

function EmptyState({ agentLabel }: { agentLabel: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center text-surface-400">
      <div className="text-4xl mb-3">🤖</div>
      <p className="font-medium text-surface-600 mb-1">{agentLabel} טרם הופעל</p>
      <p className="text-sm">לחץ על "הרץ עכשיו" לייצור הדוח הראשון</p>
    </div>
  )
}

function RunningState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center text-surface-400">
      <Loader2 size={32} className="animate-spin text-blue-500 mb-3" />
      <p className="font-medium text-surface-600 mb-1">מנתח נתונים...</p>
      <p className="text-sm">זה לוקח כ-30–60 שניות</p>
    </div>
  )
}

function ErrorState({ msg }: { msg: string }) {
  return (
    <div className="card bg-red-50 border-red-200 flex gap-3">
      <AlertCircle className="text-red-500 shrink-0 mt-0.5" size={18} />
      <div>
        <p className="font-medium text-red-800 text-sm">שגיאה בהפעלת הסוכן</p>
        <p className="text-xs text-red-700 mt-1 font-mono">{msg}</p>
      </div>
    </div>
  )
}

// ── Paid Ads Panel ────────────────────────────────────────────────────────────

function PaidAdsPanel({ row }: { row: AdvisorReport | null }) {
  if (!row)                    return <EmptyState agentLabel="סוכן פרסום ממומן" />
  if (row.status === 'running') return <RunningState />
  if (row.status === 'error')   return <ErrorState msg={row.error_msg ?? 'שגיאה לא ידועה'} />
  if (!row.report)             return <EmptyState agentLabel="סוכן פרסום ממומן" />

  const r = row.report as PaidAdsReport

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="card bg-blue-50 border-blue-100">
        <p className="text-sm text-blue-900 leading-relaxed">{r.summary}</p>
      </div>

      {/* Google KPIs */}
      {r.google && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">Google Ads</h4>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: 'הוצאה', value: `₪${r.google.total_cost.toLocaleString()}` },
              { label: 'קליקים', value: r.google.total_clicks.toLocaleString() },
              { label: 'המרות', value: r.google.total_conversions },
              { label: 'ROAS', value: `${r.google.roas}x` },
            ].map(kpi => (
              <div key={kpi.label} className="card p-3 text-center">
                <p className="text-lg font-bold font-mono text-surface-900">{kpi.value}</p>
                <p className="text-xs text-surface-400 mt-0.5">{kpi.label}</p>
              </div>
            ))}
          </div>
          {(r.google.top_campaign || r.google.worst_campaign) && (
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              {r.google.top_campaign && (
                <div className="card p-2 bg-green-50 border-green-100">
                  <p className="text-green-600 font-medium">🏆 הטוב ביותר</p>
                  <p className="text-surface-700 truncate">{r.google.top_campaign}</p>
                </div>
              )}
              {r.google.worst_campaign && (
                <div className="card p-2 bg-red-50 border-red-100">
                  <p className="text-red-600 font-medium">⚠️ הגרוע ביותר</p>
                  <p className="text-surface-700 truncate">{r.google.worst_campaign}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Budget Recommendations */}
      {r.budget_recommendations?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">המלצות תקציב</h4>
          <div className="space-y-2">
            {r.budget_recommendations.map((rec, i) => (
              <div key={i} className={`card border-r-4 p-3 ${actionColor(rec.action)}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold">{actionLabel(rec.action)}</span>
                  {rec.suggested_budget_change_pct !== 0 && (
                    <span className="text-xs font-mono bg-white px-1.5 py-0.5 rounded">{rec.suggested_budget_change_pct > 0 ? '+' : ''}{rec.suggested_budget_change_pct}%</span>
                  )}
                </div>
                <p className="text-sm font-medium text-surface-800">{rec.campaign}</p>
                <p className="text-xs text-surface-500 mt-1">{rec.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Campaign Changes */}
      {r.campaign_changes?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">שינויים מומלצים</h4>
          <div className="space-y-2">
            {r.campaign_changes.map((c, i) => (
              <div key={i} className="card p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs bg-surface-100 px-1.5 py-0.5 rounded font-mono">{c.action}</span>
                  <span className="text-sm font-medium text-surface-800">{c.campaign}</span>
                </div>
                <p className="text-xs text-surface-500">{c.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Key Insights */}
      {r.key_insights?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">תובנות מרכזיות</h4>
          <ul className="space-y-1">
            {r.key_insights.map((ins, i) => (
              <li key={i} className="text-sm text-surface-700 flex gap-2">
                <span className="text-surface-300 shrink-0">•</span>
                {ins}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Next Week Focus */}
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
  if (!row)                    return <EmptyState agentLabel="סוכן תוכן אורגני" />
  if (row.status === 'running') return <RunningState />
  if (row.status === 'error')   return <ErrorState msg={row.error_msg ?? 'שגיאה לא ידועה'} />
  if (!row.report)             return <EmptyState agentLabel="סוכן תוכן אורגני" />

  const r = row.report as OrganicReport

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="card bg-green-50 border-green-100">
        <p className="text-sm text-green-900 leading-relaxed">{r.summary}</p>
      </div>

      {/* Account Health */}
      {r.account_health && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">בריאות חשבון</h4>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: 'reach ממוצע', value: r.account_health.avg_reach_30d.toLocaleString() },
              { label: 'עוקבים', value: r.account_health.follower_count.toLocaleString() },
              { label: 'engagement', value: `${r.account_health.engagement_rate_pct}%` },
              { label: 'תוכן מוביל', value: r.account_health.best_post_type === 'reel' ? '🎬 ריילס' : r.account_health.best_post_type === 'post' ? '🖼️ פוסט' : '⏱ סטורי' },
            ].map(kpi => (
              <div key={kpi.label} className="card p-3 text-center">
                <p className="text-lg font-bold font-mono text-surface-900">{kpi.value}</p>
                <p className="text-xs text-surface-400 mt-0.5">{kpi.label}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Next Week Calendar */}
      {r.next_week_calendar?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">לוח תוכן לשבוע הבא</h4>
          <div className="space-y-1.5">
            {r.next_week_calendar.map((item, i) => (
              <div key={i} className="card p-3 flex items-center gap-3">
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

      {/* Content Recommendations */}
      {r.content_recommendations?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">רעיונות תוכן</h4>
          <div className="space-y-3">
            {r.content_recommendations.map((rec, i) => (
              <div key={i} className="card p-4 border-r-4 border-green-400">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm">{contentTypeIcon(rec.content_type)}</span>
                  <span className="text-xs bg-surface-100 px-1.5 py-0.5 rounded font-medium text-surface-600">{rec.content_type}</span>
                  <span className="text-xs text-surface-400">{rec.best_day} · {rec.best_time}</span>
                </div>
                <p className="font-medium text-surface-800 text-sm mb-1">{rec.topic}</p>
                <p className="text-xs text-surface-500 mb-2">{rec.reason}</p>
                {rec.caption_idea && (
                  <blockquote className="text-xs text-surface-600 bg-surface-50 border-r-2 border-surface-200 pr-2 py-1 italic">
                    "{rec.caption_idea}"
                  </blockquote>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Products to Feature */}
      {r.products_to_feature?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">מוצרים לקדם</h4>
          <div className="space-y-2">
            {r.products_to_feature.map((p, i) => (
              <div key={i} className="card p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-surface-800">{p.product}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                    p.reason === 'low_stock_urgency' ? 'bg-red-100 text-red-600' :
                    p.reason === 'new_batch'         ? 'bg-blue-100 text-blue-600' :
                    'bg-amber-100 text-amber-600'
                  }`}>
                    {p.reason === 'low_stock_urgency' ? '⚠️ מלאי נמוך' :
                     p.reason === 'new_batch'         ? '✨ אצווה חדשה' :
                     p.reason === 'bestseller'        ? '🏆 נמכר ביותר' : p.reason}
                  </span>
                </div>
                <p className="text-xs text-surface-500">{p.content_angle}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Key Insights */}
      {r.key_insights?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">תובנות</h4>
          <ul className="space-y-1">
            {r.key_insights.map((ins, i) => (
              <li key={i} className="text-sm text-surface-700 flex gap-2">
                <span className="text-surface-300 shrink-0">•</span>
                {ins}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* What Worked */}
      {r.what_worked_last_week?.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-400 uppercase tracking-wider mb-2">מה עבד השבוע שעבר</h4>
          <ul className="space-y-1">
            {r.what_worked_last_week.map((item, i) => (
              <li key={i} className="text-sm text-surface-700 flex gap-2">
                <span className="text-surface-300 shrink-0">•</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AdvisorPage() {
  const [paidRow, setPaidRow]     = useState<AdvisorReport | null>(null)
  const [organicRow, setOrganicRow] = useState<AdvisorReport | null>(null)
  const [availableWeeks, setAvailableWeeks] = useState<string[]>([])
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null)
  const [loading, setLoading]     = useState(true)
  const [running, setRunning]     = useState(false)
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
      .eq('agent_type', 'paid_ads')
      .in('status', ['done', 'running', 'error'])
      .order('week_start', { ascending: false })
      .limit(8)

    const weeks = (data ?? []).map((r: { week_start: string }) => r.week_start)

    // Also look for organic-only weeks
    const { data: organicWeeks } = await supabase
      .from('advisor_reports')
      .select('week_start')
      .eq('agent_type', 'organic_content')
      .in('status', ['done', 'running', 'error'])
      .order('week_start', { ascending: false })
      .limit(8)

    const allWeeks = [...new Set([...weeks, ...(organicWeeks ?? []).map((r: { week_start: string }) => r.week_start)])]
      .sort((a, b) => b.localeCompare(a))

    setAvailableWeeks(allWeeks)
    const latest = allWeeks[0] ?? null
    setSelectedWeek(latest)
    if (latest) await loadReports(latest)
    else setLoading(false)
  }

  async function loadReports(weekStart: string) {
    setLoading(true)
    const { data } = await supabase
      .from('advisor_reports')
      .select('*')
      .in('agent_type', ['paid_ads', 'organic_content'])
      .eq('week_start', weekStart)

    const rows = (data ?? []) as AdvisorReport[]
    setPaidRow(rows.find(r => r.agent_type === 'paid_ads') ?? null)
    setOrganicRow(rows.find(r => r.agent_type === 'organic_content') ?? null)
    setLoading(false)

    // If any agent is running, start polling
    if (rows.some(r => r.status === 'running')) {
      startPolling(weekStart)
    }
  }

  function startPolling(weekStart: string) {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      const { data } = await supabase
        .from('advisor_reports')
        .select('*')
        .in('agent_type', ['paid_ads', 'organic_content'])
        .eq('week_start', weekStart)

      const rows = (data ?? []) as AdvisorReport[]
      setPaidRow(rows.find(r => r.agent_type === 'paid_ads') ?? null)
      setOrganicRow(rows.find(r => r.agent_type === 'organic_content') ?? null)

      const stillRunning = rows.some(r => r.status === 'running')
      if (!stillRunning) {
        clearInterval(pollRef.current!)
        setRunning(false)
        // Refresh week list in case new week was added
        await loadWeeks()
      }
    }, 5000)
  }

  async function runAdvisor() {
    setRunning(true)

    const { error } = await supabase.functions.invoke('marketing-advisor', {
      body: { trigger: 'manual', agent: 'both' },
    })

    if (error) {
      console.error('Advisor invoke error:', error)
      setRunning(false)
      return
    }

    // Refresh weeks list and reload — the function runs async, we poll
    await loadWeeks()
    if (selectedWeek) startPolling(selectedWeek)
  }

  const isRunning = paidRow?.status === 'running' || organicRow?.status === 'running' || running

  return (
    <div className="space-y-6 fade-up">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-display font-semibold text-surface-900">יועץ שיווק AI</h2>
          <p className="text-sm text-surface-400 mt-1">
            {selectedWeek ? `שבוע ${formatWeek(selectedWeek)}` : 'טרם הופעל'}
          </p>
        </div>
        <button
          onClick={runAdvisor}
          disabled={isRunning}
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRunning
            ? <><Loader2 size={14} className="animate-spin" /> מנתח...</>
            : <><RefreshCw size={14} /> הרץ עכשיו</>
          }
        </button>
      </div>

      {/* Two-column report */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Paid Ads */}
        <div className="card">
          <div className="flex items-center justify-between mb-4 pb-4 border-b border-surface-100">
            <div className="flex items-center gap-2">
              <TrendingUp size={18} className="text-blue-500" />
              <h3 className="font-display font-semibold text-surface-900">פרסום ממומן</h3>
            </div>
            {paidRow && <StatusBadge status={paidRow.status} />}
          </div>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <div key={i} className="h-12 bg-surface-100 rounded animate-pulse" />)}
            </div>
          ) : (
            <PaidAdsPanel row={paidRow} />
          )}
        </div>

        {/* Organic Content */}
        <div className="card">
          <div className="flex items-center justify-between mb-4 pb-4 border-b border-surface-100">
            <div className="flex items-center gap-2">
              <Leaf size={18} className="text-green-500" />
              <h3 className="font-display font-semibold text-surface-900">תוכן אורגני</h3>
            </div>
            {organicRow && <StatusBadge status={organicRow.status} />}
          </div>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <div key={i} className="h-12 bg-surface-100 rounded animate-pulse" />)}
            </div>
          ) : (
            <OrganicPanel row={organicRow} />
          )}
        </div>
      </div>

      {/* Week history navigation */}
      {availableWeeks.length > 1 && (
        <div className="card p-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-surface-400 font-medium ml-2">שבועות קודמים:</span>
            {availableWeeks.map(week => (
              <button
                key={week}
                onClick={() => setSelectedWeek(week)}
                className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                  week === selectedWeek
                    ? 'bg-surface-900 text-white'
                    : 'bg-surface-100 text-surface-600 hover:bg-surface-200'
                }`}
              >
                {formatWeek(week)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Empty state — no reports at all */}
      {!loading && availableWeeks.length === 0 && (
        <div className="card text-center py-20">
          <div className="text-5xl mb-4">🤖</div>
          <h3 className="text-lg font-display font-semibold text-surface-800 mb-2">הסוכנים עדיין לא הופעלו</h3>
          <p className="text-sm text-surface-400 max-w-sm mx-auto mb-6">
            לחץ על "הרץ עכשיו" כדי שהסוכנים ינתחו את הנתונים ויציגו המלצות לשבוע הבא.
          </p>
          <button onClick={runAdvisor} disabled={isRunning} className="btn btn-primary mx-auto flex items-center gap-2">
            <RefreshCw size={14} /> הרץ ניתוח ראשון
          </button>
        </div>
      )}
    </div>
  )
}
