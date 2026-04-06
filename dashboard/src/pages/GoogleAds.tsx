import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { KPICard } from '../components/shared/KPICard'
import { DateRangePicker } from '../components/shared/DateRangePicker'
import { DateRange, GoogleCampaign } from '../lib/types'
import { getDefaultDateRange, formatCurrency, formatNumber } from '../lib/utils'
import { AlertCircle } from 'lucide-react'

export default function GoogleAdsPage() {
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange())
  const [campaigns, setCampaigns] = useState<GoogleCampaign[]>([])
  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)

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
      const { data } = await supabase
        .from('google_campaigns')
        .select('*')
        .gte('date', dateRange.from.toISOString().split('T')[0])
        .lte('date', dateRange.to.toISOString().split('T')[0])
        .order('cost', { ascending: false })
      setCampaigns(data || [])
    }
    setLoading(false)
  }

  const totalCost = campaigns.reduce((s, c) => s + c.cost, 0)
  const totalClicks = campaigns.reduce((s, c) => s + c.clicks, 0)
  const totalConversions = campaigns.reduce((s, c) => s + c.conversions, 0)
  const totalConvValue = campaigns.reduce((s, c) => s + c.conversion_value, 0)
  const roas = totalCost > 0 ? totalConvValue / totalCost : 0

  return (
    <div className="space-y-8 fade-up">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-display font-semibold text-surface-900">Google Ads</h2>
          <p className="text-sm text-surface-400 mt-1">{campaigns.length} קמפיינים</p>
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard label="הוצאות" value={formatCurrency(totalCost)} loading={loading} />
        <KPICard label="קליקים" value={totalClicks} loading={loading} />
        <KPICard label="המרות" value={totalConversions} loading={loading} />
        <KPICard label="ROAS" value={roas.toFixed(2)} suffix="x" loading={loading} />
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
              <th className="text-right px-4 py-3 text-xs font-semibold text-surface-400 uppercase tracking-wider">CTR</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-surface-400 uppercase tracking-wider">CPC</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-surface-400 uppercase tracking-wider">המרות</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-surface-400 uppercase tracking-wider">ROAS</th>
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
              campaigns.map(c => (
                <tr key={c.id} className="hover:bg-surface-50 transition-colors">
                  <td className="px-5 py-3 font-medium text-surface-800">{c.name}</td>
                  <td className="px-4 py-3 font-mono text-surface-700">{formatCurrency(c.cost)}</td>
                  <td className="px-4 py-3 font-mono text-surface-600">{formatNumber(c.clicks)}</td>
                  <td className="px-4 py-3 font-mono text-surface-600">{(c.ctr * 100).toFixed(2)}%</td>
                  <td className="px-4 py-3 font-mono text-surface-600">{formatCurrency(c.cpc)}</td>
                  <td className="px-4 py-3 font-mono text-surface-600">{c.conversions}</td>
                  <td className="px-4 py-3 font-mono text-surface-600">{c.roas.toFixed(2)}x</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
