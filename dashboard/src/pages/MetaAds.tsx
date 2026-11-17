import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { DateRangePicker } from '../components/shared/DateRangePicker'
import { CardHead, CHART, Dot, Kpi, Kpis, Notice, SectionHead, Segmented, Swatch, TD, TH, Tone } from '../components/shared/cockpit'
import { DateRange } from '../lib/types'
import { getDefaultDateRange, formatCurrency, formatNumber } from '../lib/utils'
import { subMonths, startOfMonth, endOfMonth } from 'date-fns'
import { AlertCircle, Pencil } from 'lucide-react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, BarChart, Bar
} from 'recharts'

// Meta campaign status → Hebrew label + status dot.
const STATUS: Record<string, { label: string; tone: Tone }> = {
  ACTIVE:   { label: 'פעיל',    tone: 'ok' },
  PAUSED:   { label: 'מושהה',   tone: 'warn' },
  ARCHIVED: { label: 'בארכיון', tone: 'neutral' },
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
    // Meta's own PURCHASE count, not `conversions` (every funnel event, ~12x inflated).
    const conv = rows.reduce((s: number, c: any) => s + (c.purchases ?? 0), 0)
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
      byCampaign[r.campaign_id].conversions += (r.purchases ?? 0)
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
      byDate[r.date].conversions += (r.purchases ?? 0)
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
    <div className="space-y-5 fade-up">
      <SectionHead
        title="מודעות Meta"
        sub={`${campaigns.length} קמפיינים בטווח`}
        actions={
          <>
            {/* CPA Threshold setting */}
            {editingThreshold ? (
              <div className="flex items-center gap-2 w-full lg:w-auto">
                <label htmlFor="cpa-threshold" className="text-[13px] text-surface-600 whitespace-nowrap">סף CPA</label>
                <div className="relative">
                  <input
                    id="cpa-threshold"
                    type="number"
                    inputMode="decimal"
                    className="field num w-24 ps-3 pe-7"
                    value={thresholdInput}
                    onChange={e => setThresholdInput(e.target.value)}
                    autoFocus
                  />
                  <span aria-hidden="true" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] text-surface-400">₪</span>
                </div>
                <button type="button" onClick={() => saveCpaThreshold(Number(thresholdInput))} className="btn-primary h-[38px]">שמירה</button>
                <button type="button" onClick={() => setEditingThreshold(false)} className="btn-secondary h-[38px]">ביטול</button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setThresholdInput(String(cpaThreshold)); setEditingThreshold(true) }}
                className="btn-secondary flex-1 lg:flex-none"
                aria-label={`סף CPA ${cpaThreshold} ש״ח, עריכה`}
              >
                <span className="text-surface-500 font-normal">סף CPA</span>
                <span className="num">₪{cpaThreshold}</span>
                <Pencil size={14} aria-hidden="true" className="text-surface-400" />
              </button>
            )}
            <div className="flex-1 lg:flex-none"><DateRangePicker value={dateRange} onChange={setDateRange} /></div>
          </>
        }
      />

      {/* CPA Alert */}
      {cpaAlert && (
        <Notice tone="danger" icon={<AlertCircle />} title="העלות לרכישה גבוהה מהסף">
          <span className="num">CPA נוכחי <strong className="font-semibold text-surface-900">{formatCurrency(totalCPA!)}</strong>, הסף {formatCurrency(cpaThreshold)}</span>
        </Notice>
      )}

      {/* KPIs with MoM */}
      <div className="space-y-3">
        <Kpis label="מדדי Meta עיקריים">
          <Kpi label="הוצאות" value={formatCurrency(totalSpend)} change={spendChange} goodWhen="none" loading={loading} />
          <Kpi label="רכישות (לפי Meta)" value={formatNumber(totalConversions)} change={convChange} loading={loading} />
          <Kpi label="עלות לרכישה (CPA)" value={totalCPA !== null ? formatCurrency(totalCPA) : '—'} change={cpaChange} goodWhen="down" loading={loading} />
          <Kpi label="קליקים" value={formatNumber(totalClicks)} change={clicksChange} loading={loading} />
        </Kpis>
        <Kpis label="מדדי Meta משניים" cols={3}>
          <Kpi size="sm" label="CPC ממוצע" value={formatCurrency(avgCPC)} loading={loading} />
          <Kpi size="sm" label="CPM ממוצע" value={formatCurrency(totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0)} loading={loading} />
          <Kpi size="sm" label="CTR ממוצע" value={avgCTR.toFixed(2)} unit="%" loading={loading} />
        </Kpis>
      </div>

      {/* Charts */}
      {chartData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <section className="card-flush overflow-hidden">
            <CardHead title="עלות לרכישה ביום">
              <span className="text-[12.5px] text-surface-500">₪, לפי Meta</span>
            </CardHead>
            <div className="p-4 pt-5" dir="ltr">
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={CHART.grid} />
                  <XAxis dataKey="date" tick={CHART.tick} tickLine={false} axisLine={false} minTickGap={16} />
                  <YAxis tick={CHART.tick} tickLine={false} axisLine={false} />
                  <Tooltip {...CHART.tooltip} cursor={{ stroke: CHART.grid }} formatter={(v: any) => [`₪${Number(v).toFixed(2)}`, 'CPA']} />
                  <Line type="monotone" dataKey="cpa" stroke={CHART.olive} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} name="CPA ₪" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>
          <section className="card-flush overflow-hidden">
            <CardHead title="הוצאות ורכישות ביום">
              <div className="flex items-center gap-3">
                <Swatch color={CHART.olive} label="הוצאות ₪" />
                <Swatch color={CHART.grey} label="רכישות" />
              </div>
            </CardHead>
            <div className="p-4 pt-5" dir="ltr">
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={CHART.grid} />
                  <XAxis dataKey="date" tick={CHART.tick} tickLine={false} axisLine={false} minTickGap={16} />
                  <YAxis tick={CHART.tick} tickLine={false} axisLine={false} />
                  <Tooltip {...CHART.tooltip} />
                  <Bar dataKey="spend" fill={CHART.olive} name="הוצאות ₪" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="conversions" fill={CHART.grey} name="רכישות" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        </div>
      )}

      {/* Campaigns table */}
      <section className="card-flush overflow-hidden">
        <CardHead title="קמפיינים">
          <Segmented
            label="מיון הקמפיינים"
            value={sortBy}
            onChange={setSortBy}
            options={[
              { id: 'spend', label: 'הוצאות' },
              { id: 'conversions', label: 'רכישות' },
              { id: 'cpa', label: 'CPA' },
            ]}
          />
        </CardHead>
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-50 border-b border-surface-200">
                <th scope="col" className={`${TH} text-right`}>קמפיין</th>
                <th scope="col" className={`${TH} text-right`}>סטטוס</th>
                <th scope="col" className={`${TH} text-left`}>הוצאות</th>
                <th scope="col" className={`${TH} text-left hidden lg:table-cell`}>קליקים</th>
                <th scope="col" className={`${TH} text-left hidden lg:table-cell`}>CTR</th>
                <th scope="col" className={`${TH} text-left hidden lg:table-cell`}>CPC</th>
                <th scope="col" className={`${TH} text-left`}>רכישות</th>
                <th scope="col" className={`${TH} text-left`}>CPA</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-t border-surface-200 first:border-t-0">{Array.from({ length: 8 }).map((_, j) => (
                    <td key={j} className={`px-4 py-3.5 ${j >= 3 && j <= 5 ? 'hidden lg:table-cell' : ''}`}><div className="h-3 bg-surface-100 rounded" /></td>
                  ))}</tr>
                ))
              ) : sorted.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-12 text-[13px] text-surface-500">אין נתונים לטווח הזה. אפשר לחבר את Meta בהגדרות ולסנכרן.</td></tr>
              ) : (
                sorted.map(c => {
                  const st = STATUS[c.status] ?? { label: c.status, tone: 'neutral' as Tone }
                  return (
                    <tr key={c.campaign_id} className="border-t border-surface-200 first:border-t-0 [@media(hover:hover)]:hover:bg-surface-50 transition-colors duration-150">
                      <td className="px-4 py-3 font-medium text-surface-900 max-w-[16rem] lg:max-w-xs truncate" title={c.name}>{c.name}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 text-[13px] text-surface-700"><Dot tone={st.tone} />{st.label}</span>
                      </td>
                      <td className={`${TD} text-left text-surface-900`}>{formatCurrency(c.spend)}</td>
                      <td className={`${TD} text-left text-surface-700 hidden lg:table-cell`}>{formatNumber(c.clicks)}</td>
                      <td className={`${TD} text-left text-surface-700 hidden lg:table-cell`}>{c.ctr.toFixed(2)}%</td>
                      <td className={`${TD} text-left text-surface-700 hidden lg:table-cell`}>{formatCurrency(c.cpc)}</td>
                      <td className={`${TD} text-left text-surface-700`}>{c.conversions}</td>
                      <td className={`${TD} text-left whitespace-nowrap`}>
                        {c.cpa !== null ? (
                          c.cpa > cpaThreshold ? (
                            <span className="inline-flex items-center gap-1.5 font-medium text-danger">
                              <Dot tone="danger" /><span className="sr-only">מעל הסף: </span>{formatCurrency(c.cpa)}
                            </span>
                          ) : <span className="text-surface-900">{formatCurrency(c.cpa)}</span>
                        ) : <span className="text-surface-400">—</span>}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
