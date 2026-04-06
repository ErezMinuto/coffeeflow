import { useState, useEffect } from 'react'
import { KPICard } from '../components/shared/KPICard'
import { DateRangePicker } from '../components/shared/DateRangePicker'
import { ConnectionStatusBar } from '../components/shared/ConnectionStatus'
import { DateRange, ConnectionStatus } from '../lib/types'
import { getDefaultDateRange, getMetaAuthUrl, getGoogleAuthUrl } from '../lib/utils'
import { supabase } from '../lib/supabase'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend
} from 'recharts'

// Mock chart data — will be replaced by real data from Supabase
const MOCK_CHART = Array.from({ length: 30 }, (_, i) => ({
  date: `${i + 1}/02`,
  reach: Math.floor(800 + Math.random() * 1200),
  spend: Math.floor(50 + Math.random() * 200),
  clicks: Math.floor(20 + Math.random() * 80),
}))

export default function OverviewPage() {
  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange())
  const [connections, setConnections] = useState<ConnectionStatus[]>([
    { platform: 'meta', connected: false },
    { platform: 'google', connected: false },
  ])
  const [syncing, setSyncing] = useState<'meta' | 'google' | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    checkConnections()
  }, [])

  async function checkConnections() {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('oauth_tokens')
        .select('platform, updated_at')

      if (data) {
        setConnections(prev => prev.map(conn => {
          const token = data.find(t => t.platform === conn.platform)
          return token
            ? { ...conn, connected: true, last_synced: token.updated_at }
            : conn
        }))
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  function handleConnect(platform: 'meta' | 'google') {
    const url = platform === 'meta' ? getMetaAuthUrl() : getGoogleAuthUrl()
    window.location.href = url
  }

  async function handleSync(platform: 'meta' | 'google') {
    setSyncing(platform)
    try {
      await supabase.functions.invoke(`${platform}-sync`, {
        body: { manual: true }
      })
      await checkConnections()
    } finally {
      setSyncing(null)
    }
  }

  return (
    <div className="space-y-8 fade-up">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-display font-semibold text-surface-900">סקירה כללית</h2>
          <p className="text-sm text-surface-400 mt-1">כל הערוצים במקום אחד</p>
        </div>
        <DateRangePicker value={dateRange} onChange={setDateRange} />
      </div>

      {/* Connections */}
      <ConnectionStatusBar
        connections={connections}
        onConnect={handleConnect}
        onSync={handleSync}
        syncing={syncing}
      />

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard label="Reach כולל" value={42800} change={12.4} loading={loading} className="fade-up fade-up-1" />
        <KPICard label="הוצאות פרסום" value="₪3,240" change={-5.2} loading={loading} className="fade-up fade-up-2" />
        <KPICard label="קליקים" value={1840} change={8.7} loading={loading} className="fade-up fade-up-3" />
        <KPICard label="עוקבים חדשים" value={127} change={22.1} loading={loading} className="fade-up fade-up-4" />
      </div>

      {/* Chart */}
      <div className="card fade-up fade-up-5">
        <div className="flex items-center justify-between mb-6">
          <h3 className="font-display font-semibold text-surface-900">ביצועים לאורך זמן</h3>
          <div className="flex gap-2">
            <span className="badge badge-meta">Meta</span>
            <span className="badge badge-google">Google</span>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={MOCK_CHART} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="reach" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#1877f2" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#1877f2" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="spend" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#d97318" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#d97318" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0ebe3" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#927561' }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 11, fill: '#927561' }} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={{ background: '#fff', border: '1px solid #e3d9cc', borderRadius: 12, fontSize: 12 }}
            />
            <Area type="monotone" dataKey="reach" stroke="#1877f2" strokeWidth={2} fill="url(#reach)" name="Reach" />
            <Area type="monotone" dataKey="spend" stroke="#d97318" strokeWidth={2} fill="url(#spend)" name="הוצאות (₪)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
