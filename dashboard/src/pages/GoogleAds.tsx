import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { KPICard } from '../components/shared/KPICard'
import { DateRangePicker } from '../components/shared/DateRangePicker'
import { DateRange } from '../lib/types'
import { fetchPaidSummary, PaidCampaignRow } from '../lib/metrics'
import { getDefaultDateRange, formatCurrency, formatNumber } from '../lib/utils'
import { AlertCircle } from 'lucide-react'

export default function GoogleAdsPage() {
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange())
  const [campaigns, setCampaigns] = useState<PaidCampaignRow[]>([])
  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { loadData() }, [dateRange])

  async function loadData() {
    setLoading(true)
    const { data: token } = await supabase
      .from('oauth_tokens')
      .select('platform')
      .eq('platform', 'google')
      .single()
    setConnected(!!token)

    if (token) {
      // One row per campaign from the metrics layer: spend from Google, real
      // orders and revenue from MFlow web sales attributed by gclid / UTM.
      // (This page used to list one row per campaign PER DAY, with Google's
      // all_conversions count, ~6x inflated, and its own ROAS.)
      const { rows, error } = await fetchPaidSummary(dateRange, 'google')
      setError(error)
      setCampaigns(rows)
    }
    setLoading(false)
  }

  const attributed = campaigns.filter(c => c.campaign_id)
  const unattributed = campaigns.find(c => !c.campaign_id)
  const totalCost = attributed.reduce((s, c) => s + c.spend, 0)
  const totalClicks = attributed.reduce((s, c) => s + c.clicks, 0)
  const totalOrders = campaigns.reduce((s, c) => s + c.orders, 0)
  const totalRevenue = campaigns.reduce((s, c) => s + c.revenue_ex_vat, 0)
  const roas = totalCost > 0 ? totalRevenue / totalCost : 0
  const cpa = totalOrders > 0 ? totalCost / totalOrders : null

  return (
    <div className="space-y-8 fade-up">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-display font-semibold text-surface-900">Google Ads</h2>
          <p className="text-sm text-surface-400 mt-1">{attributed.length} קמפיינים · הכנסה מ־MFlow לפני מע״מ</p>
        </div>
        <DateRangePicker value={dateRange} onChange={setDateRange} />
      </div>

      {!connected && !loading && (
        <div className="card bg-amber-50 border-amber-200 flex gap-3">
          <AlertCircle className="text-amber-500 shrink-0 mt-0.5" size={18} />
          <div>
            <p className="font-medium text-amber-800 text-sm">Google Ads לא מחובר</p>
            <p className="text-xs text-amber-700 mt-1">
              לחיבור נדרש Developer Token מ-Google. לאחר קבלתו,
              חבר את Google ב<a href="/settings" className="underline">הגדרות</a>.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="card bg-red-50 border-red-200 text-sm text-red-700">שגיאה בטעינת המדדים: {error}</div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard label="הוצאות" value={formatCurrency(totalCost)} loading={loading} />
        <KPICard label="CPA אמיתי" value={cpa !== null ? formatCurrency(Math.round(cpa)) : '—'} loading={loading} />
        <KPICard label="הזמנות אמיתיות" value={totalOrders} loading={loading} />
        <KPICard label="ROAS אמיתי (לפני מע״מ)" value={roas.toFixed(2)} suffix="x" loading={loading} />
      </div>

      <div className="card overflow-hidden p-0">
        <div className="px-5 py-4 border-b border-surface-100">
          <h3 className="font-display font-semibold text-surface-900">קמפיינים</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-100 bg-surface-50">
              <th className="text-right px-5 py-3 text-xs font-semibold text-surface-400 uppercase tracking-wider">קמפיין</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-surface-400 uppercase tracking-wider">עלות</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-surface-400 uppercase tracking-wider">קליקים</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-surface-400 uppercase tracking-wider">הזמנות</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-surface-400 uppercase tracking-wider">הכנסה</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-surface-400 uppercase tracking-wider">ROAS</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-surface-400 uppercase tracking-wider" title="מה שגוגל מדווח. לאבחון בלבד">המרות לפי גוגל</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-50">
            {loading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 7 }).map((_, j) => (
                  <td key={j} className="px-4 py-3"><div className="h-3 bg-surface-100 rounded animate-pulse" /></td>
                ))}</tr>
              ))
            ) : campaigns.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-12 text-surface-400">
                {connected ? 'אין נתונים לתקופה זו' : 'חבר את Google בהגדרות'}
              </td></tr>
            ) : (
              [...attributed, ...(unattributed ? [unattributed] : [])].map(c => (
                <tr key={c.campaign_id ?? 'unattributed'} className="hover:bg-surface-50 transition-colors">
                  <td className="px-5 py-3">
                    <span className={`font-medium ${c.campaign_id ? 'text-surface-800' : 'text-surface-400 italic'}`}>
                      {c.campaign_id ? c.name : 'לא משויך לקמפיין'}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-surface-700">{c.campaign_id ? formatCurrency(c.spend) : '—'}</td>
                  <td className="px-4 py-3 font-mono text-surface-600">{c.campaign_id ? formatNumber(c.clicks) : '—'}</td>
                  <td className="px-4 py-3 font-mono text-surface-600">{c.orders}</td>
                  <td className="px-4 py-3 font-mono text-surface-600">{formatCurrency(Math.round(c.revenue_ex_vat))}</td>
                  <td className="px-4 py-3 font-mono text-surface-600">{c.real_roas !== null ? `${c.real_roas.toFixed(2)}x` : '—'}</td>
                  <td className="px-4 py-3 font-mono text-surface-400">{c.platform_purchases ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
