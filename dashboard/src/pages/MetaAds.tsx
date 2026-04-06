import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { KPICard } from '../components/shared/KPICard'
import { DateRangePicker } from '../components/shared/DateRangePicker'
import { DateRange } from '../lib/types'
import { getDefaultDateRange, formatCurrency, formatNumber } from '../lib/utils'
import { subDays, subMonths, startOfMonth, endOfMonth } from 'date-fns'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, BarChart, Bar
} from 'recharts'

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: 'badge-success',
  PAUSED: 'badge-warning',
  ARCHIVED: 'bg-surface-100 text-surface-400',
}

function getThisMonthRange(): DateRange {
  const now = new Date()
  return { from: startOfMonth(now), to: now }
}

function getPrevMonthRange(): DateRange {
  const prevMonth = subMonths(new Date(), 1)
  return { from: startOfMonth(prevMonth), to: endOfMonth(prevMonth) }
}

async function fetchCampaignAggregates(from: string, to: string) {
  const { data } = await supabase
    .from('meta_ad_campaigns')
    .select('*')
    .gte('date', from)
    .lte('date', to)
  return data || []
}

export default function MetaAdsPage() {
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange())
  const [campaigns, setCampaigns] = useState<any[]>([])
  const [chartData, setChartData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState<'spend' | 'conversions' | 'cpa'>('spend')
  const [cpaThreshold, setCpaThreshold] = useState<number>(() => {
    return Number(localStorage.getItem('cpa_threshold') || '100')
  })
  const [editingThreshold, setEditingThreshold] = useState(false)
  const [thresholdInput, setThresholdInput] = useState('')

  // Month-over-month comparisons
  const [prevSpend, setPrevSpend] = useState<number | null>(null)
  const [prevConversions, setPrevConversions] = useState<number | null>(null)
  const [prevClicks, setPrevClicks] = useState<number | null>(null)
  const [prevCpa, setPrevCpa] = useState<number | null>(null)

  useEffect(() => { loadCampaigns() }, [dateRange])
  useEffect(() => { loadPrevMonth() }, [])

  async function loadPrevMonth() {
    const prev = getPrevMonthRange()
    const rows = await fetchCampaignAggregates(
      prev.from.toISOString().split('T')[0],
      prev.to.toISOString().split('T')[0]
    )
    const spend = rows.reduce((s: number, c: any) => s + c.spend, 0)
    const conv = rows.reduce((s: number, c: any) => s + c.conversions, 0)
    const clicks = rows.reduce((s: number, c: any) => s + c.clicks, 0)
    setPrevSpend(spend)
    setPrevConversions(conv)
    setPrevClicks(clicks)
    setPrevCpa(conv > 0 ? spend / conv : null)
  }

  async function loadCampaigns() {
    setLoading(true)
    const from = dateRange.from.toISOString().split('T')[0]
    const to = dateRange.to.toISOString().split('T')[0]
    const rows = await fetchCampaignAggregates(from, to)

    // Aggregate by campaign
    const byCampaign: Record<string, any> = {}
    rows.forEach((r: any) => {
      if (!byCampaign[r.campaign_id]) {
        byCampaign[r.campaign_id] = { ...r, spend: 0, impressions: 0, clicks: 0, conversions: 0 }
      }
      byCampaign[r.campaign_id].spend += r.spend
      byCampaign[r.campaign_id].impressions += r.impressions
      byCampaign[r.campaign_id].clicks += r.clicks
      byCampaign[r.campaign_id].conversions += r.conversions
    })
    const agg = Object.values(byCampaign).map((c: any) => ({
      ...c,
      cpc: c.clicks > 0 ? c.spend / c.clicks : 0,
      ctr: c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0,
      cpa: c.conversions > 0 ? c.spend / c.conversions : null,
    }))
    setCampaigns(agg)

    // Daily chart
    const byDate: Record<string, any> = {}
    rows.forEach((r: any) => {
      if (!byDate[r.date]) byDate[r.date] = { date: r.date.slice(5), spend: 0, conversions: 0, clicks: 0 }
      byDate[r.date].spend += r.spend
      byDate[r.date].conversions += r.conversions
      byDate[r.date].clicks += r.clicks
    })
    const daily = Object.values(byDate).map((d: any) => ({
      ...d,
      cpa: d.conversions > 0 ? +(d.spend / d.conversions).toFixed(2) : 0,
    }))
    setChartData(daily)
    setLoading(false)
  }

  function saveCpaThreshold(val: number) {
    setCpaThreshold(val)
    localStorage.setItem('cpa_threshold', String(val))
    setEditingThreshold(false)
  }

  const totalSpend = campaigns.reduce((s, c) => s + c.spend, 0)
  const totalImpressions = campaigns.reduce((s, c) => s + c.impressions, 0)
  const totalClicks = campaigns.reduce((s, c) => s + c.clicks, 0)
  const totalConversions = campaigns.reduce((s, c) => s + c.conversions, 0)
  const totalCPA = totalConversions > 0 ? totalSpend / totalConversions : null
  const avgCPC = totalClicks > 0 ? totalSpend / totalClicks : 0
  const avgCTR = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0

  // MoM changes
  const spendChange = prevSpend && prevSpend > 0 ? ((totalSpend - prevSpend) / prevSpend) * 100 : undefined
  const convChange = prevConversions && prevConversions > 0 ? ((totalConversions - prevConversions) / prevConversions) * 100 : undefined
  const clicksChange = prevClicks && prevClicks > 0 ? ((totalClicks - prevClicks) / prevClicks) * 100 : undefined
  const cpaChange = prevCpa && totalCPA ? ((totalCPA - prevCpa) / prevCpa) * 100 : undefined

  const cpaAlert = totalCPA !== null && totalCPA > cpaThreshold
  const sorted = [...campaigns].sort((a, b) => {
    if (sortBy === 'spend') return b.spend - a.spend
    if (sortBy === 'conversions') return b.conversions - a.conversions
    if (sortBy === 'cpa') return (a.cpa ?? 99999) - (b.cpa ?? 99999)
    return 0
  })

  return (
    <div className="space-y-8 fade-up">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-display font-semibold text-surface-900">Meta Ads</h2>
          <p className="text-sm text-surface-400 mt-1">{campaigns.length} קמפיינים</p>
        </div>
        <div className="flex items-center gap-3">
          {/* CPA Threshold setting */}
          <div className="flex items-center gap-2 text-sm bg-surface-50 border border-surface-200 rounded-xl px-3 py-2">
            <span className="text-surface-500">סף CPA:</span>
            {editingThreshold ? (
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  className="w-16 text-sm border border-surface-200 rounded px-1 py-0.5 text-center"
                  value={thresholdInput}
                  onChange={e => setThresholdInput(e.target.value)}
                  autoFocus
                />
                <span className="text-surface-400">₪</span>
                <button onClick={() => saveCpaThreshold(Number(thresholdInput))}
                  className="text-xs bg-brand-600 text-white px-2 py-0.5 rounded">שמור</button>
                <button onClick={() => setEditingThreshold(false)} className="text-xs text-surface-400">ביטול</button>
              </div>
            ) : (
              <button onClick={() => { setThresholdInput(String(cpaThreshold)); setEditingThreshold(true) }}
                className="font-mono font-medium text-brand-600 hover:underline">
                ₪{cpaThreshold}
              </button>
            )}
          </div>
          <DateRangePicker value={dateRange} onChange={setDateRange} />
        </div>
      </div>

      {/* CPA Alert */}
      {cpaAlert && (
        <div className="card bg-red-50 border-red-200 flex items-center gap-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <p className="font-medium text-red-800 text-sm">עלות להמרה גבוהה מהסף</p>
            <p className="text-xs text-red-600 mt-0.5">
              CPA נוכחי: <strong>{formatCurrency(totalCPA!)}</strong> — סף: {formatCurrency(cpaThreshold)}
            </p>
          </div>
        </div>
      )}

      {/* KPIs with MoM */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard label="הוצאות" value={formatCurrency(totalSpend)} change={spendChange} loading={loading} />
        <KPICard label="המרות" value={formatNumber(totalConversions)} change={convChange} loading={loading} />
        <KPICard label="עלות להמרה (CPA)" value={totalCPA !== null ? formatCurrency(totalCPA) : '—'} change={cpaChange} loading={loading} />
        <KPICard label="קליקים" value={formatNumber(totalClicks)} change={clicksChange} loading={loading} />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <KPICard label="CPC ממוצע" value={formatCurrency(avgCPC)} loading={loading} />
        <KPICard label="CPM ממוצע" value={formatCurrency(totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0)} loading={loading} />
        <KPICard label="CTR ממוצע" value={avgCTR.toFixed(2)} suffix="%" loading={loading} />
      </div>

      {/* Charts */}
      {chartData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="card">
            <h3 className="font-display font-semibold text-surface-900 mb-4">עלות להמרה יומית (₪)</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0ebe3" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#927561' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#927561' }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ background: '#fff', border: '1px solid #e3d9cc', borderRadius: 12, fontSize: 12 }} formatter={(v: any) => [`₪${Number(v).toFixed(2)}`, 'CPA']} />
                <Line type="monotone" dataKey="cpa" stroke="#1877f2" strokeWidth={2} dot={false} name="CPA ₪" />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="card">
            <h3 className="font-display font-semibold text-surface-900 mb-4">הוצאות והמרות יומיות</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0ebe3" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#927561' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#927561' }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ background: '#fff', border: '1px solid #e3d9cc', borderRadius: 12, fontSize: 12 }} />
                <Bar dataKey="spend" fill="#1877f2" name="הוצאות ₪" radius={[3, 3, 0, 0]} />
                <Bar dataKey="conversions" fill="#34d399" name="המרות" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Campaigns table */}
      <div className="card overflow-hidden p-0">
        <div className="px-5 py-4 border-b border-surface-100 flex items-center justify-between">
          <h3 className="font-display font-semibold text-surface-900">קמפיינים</h3>
          <div className="flex items-center gap-2 text-xs text-surface-400">
            <span>מיין לפי:</span>
            {(['spend', 'conversions', 'cpa'] as const).map(s => (
              <button key={s} onClick={() => setSortBy(s)}
                className={`px-2 py-1 rounded ${sortBy === s ? 'bg-brand-100 text-brand-700 font-medium' : 'hover:bg-surface-100'}`}>
                {s === 'spend' ? 'הוצאות' : s === 'conversions' ? 'המרות' : 'CPA'}
              </button>
            ))}
          </div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-100 bg-surface-50">
              {['קמפיין', 'סטטוס', 'הוצאות', 'קליקים', 'CTR', 'CPC', 'המרות', 'CPA'].map(h => (
                <th key={h} className="text-right px-4 py-3 text-xs font-semibold text-surface-400 uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-50">
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 8 }).map((_, j) => (
                  <td key={j} className="px-4 py-3"><div className="h-3 bg-surface-100 rounded animate-pulse" /></td>
                ))}</tr>
              ))
            ) : sorted.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-12 text-surface-400">אין נתונים — חבר את Meta בהגדרות וסנכרן</td></tr>
            ) : (
              sorted.map(c => (
                <tr key={c.campaign_id} className="hover:bg-surface-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-surface-800 max-w-xs truncate">{c.name}</td>
                  <td className="px-4 py-3">
                    <span className={`badge ${STATUS_COLORS[c.status] || 'bg-surface-100 text-surface-500'}`}>{c.status}</span>
                  </td>
                  <td className="px-4 py-3 font-mono text-surface-700">{formatCurrency(c.spend)}</td>
                  <td className="px-4 py-3 font-mono text-surface-600">{formatNumber(c.clicks)}</td>
                  <td className="px-4 py-3 font-mono text-surface-600">{c.ctr.toFixed(2)}%</td>
                  <td className="px-4 py-3 font-mono text-surface-600">{formatCurrency(c.cpc)}</td>
                  <td className="px-4 py-3 font-mono text-surface-600">{c.conversions}</td>
                  <td className="px-4 py-3 font-mono">
                    {c.cpa !== null ? (
                      <span className={c.cpa > cpaThreshold ? 'text-red-600 font-semibold' : 'text-green-600'}>
                        {formatCurrency(c.cpa)}
                      </span>
                    ) : <span className="text-surface-300">—</span>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
