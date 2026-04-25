import { useState, useEffect } from 'react'
import { CheckCircle, XCircle, ExternalLink, RefreshCw, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { getMetaAuthUrl, getGoogleAuthUrl } from '../lib/utils'

interface PlatformInfo {
  platform: 'meta' | 'google'
  connected: boolean
  account_name?: string
  last_synced?: string
}

export default function SettingsPage() {
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([
    { platform: 'meta', connected: false },
    { platform: 'google', connected: false },
  ])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState<'meta' | 'google' | 'google_search' | 'woo_orders' | null>(null)
  const [wooOrderCount, setWooOrderCount] = useState<number | null>(null)
  const [syncResult, setSyncResult] = useState<{ platform: string; message: string; success: boolean } | null>(null)

  useEffect(() => {
    loadConnections()
    supabase.from('woo_orders').select('*', { count: 'exact', head: true })
      .then(({ count }) => setWooOrderCount(count ?? 0))
  }, [])

  async function loadConnections() {
    setLoading(true)
    try {
      const { data } = await supabase.from('oauth_tokens').select('*')
      // Always reset all platforms to disconnected first, then apply what's actually in the DB
      setPlatforms([
        { platform: 'meta',   connected: false },
        { platform: 'google', connected: false },
      ])
      if (data) {
        setPlatforms(prev => prev.map(p => {
          const token = data.find(t => t.platform === p.platform)
          return token ? { ...p, connected: true, last_synced: token.updated_at, account_name: token.account_name } : p
        }))
      }
    } finally {
      setLoading(false)
    }
  }

  async function disconnect(platform: 'meta' | 'google') {
    if (!confirm(`האם לנתק את ${platform}?`)) return
    await supabase.from('oauth_tokens').delete().eq('platform', platform)
    await loadConnections()
  }

  // Poll sync_log row by id until status flips off 'running'. Used by the
  // async sync pattern where the function returns 202 + sync_id immediately
  // and continues working in the background. Without this the manual sync
  // button would just succeed instantly with no real result and leave the
  // user wondering whether anything actually happened.
  async function pollSyncLog(syncId: string, platform: string, timeoutMs = 180_000): Promise<any> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise(r => setTimeout(r, 3000))
      const { data: row } = await supabase
        .from('sync_log')
        .select('status, records, error_msg, stats')
        .eq('id', syncId)
        .single()
      if (!row) continue
      if ((row as any).status !== 'running') return row
      // While running, refresh the toast with current phase if available
      const phase = (row as any).stats?.phase
      if (phase) {
        setSyncResult({ platform: platform as any, message: `⏳ סנכרון ${phase}…`, success: true })
      }
    }
    throw new Error(`Sync timed out after ${timeoutMs / 1000}s — check sync_log row ${syncId}`)
  }

  async function sync(platform: 'meta' | 'google' | 'google_search' | 'woo_orders') {
    setSyncing(platform)
    setSyncResult(null)
    try {
      const functionName =
        platform === 'meta'          ? 'meta-sync' :
        platform === 'google_search' ? 'google-search-sync' :
        platform === 'woo_orders'    ? 'woo-orders-sync' :
                                       'google-sync'
      const { data, error } = await supabase.functions.invoke(functionName)
      if (error) throw error

      // Async response shape: { sync_id, status: 'running' }. Means the
      // function returned 202 immediately and is still working in the
      // background — poll sync_log to know when it's done. The other
      // platforms still respond synchronously for now.
      const asyncResponse = data as { sync_id?: string; status?: string }
      if (asyncResponse?.sync_id && asyncResponse?.status === 'running') {
        setSyncResult({ platform, message: '⏳ סנכרון רץ ברקע…', success: true })
        const finalRow = await pollSyncLog(asyncResponse.sync_id, platform)
        const finalStatus = finalRow.status as 'success' | 'partial' | 'error'
        const records = finalRow.records ?? 0
        const errMsg = finalRow.error_msg
        const message =
          finalStatus === 'success' ? `✅ סנכרון הסתיים בהצלחה (${records} רשומות)` :
          finalStatus === 'partial' ? `⚠️ סנכרון חלקי — ${records} רשומות, שגיאות: ${errMsg ?? '—'}` :
                                       `❌ סנכרון נכשל: ${errMsg ?? 'unknown'}`
        setSyncResult({ platform, message, success: finalStatus !== 'error' })
        await loadConnections()
        return
      }

      if (platform === 'woo_orders') {
        // The function returns `new_orders` (orders with id > lastSyncedId)
        // and `refreshed_orders` (already-synced orders re-fetched in the
        // 3-day safety buffer). Show both — "0 new, 14 refreshed" is way
        // more informative than "0 synced" which made it look like a bug
        // when the sync was actually doing its job.
        const d = data as { new_orders?: number; refreshed_orders?: number; fetched?: number }
        const newCount = d?.new_orders ?? 0
        const refreshedCount = d?.refreshed_orders ?? 0
        const message = newCount > 0
          ? `✅ ${newCount} הזמנות חדשות סונכרנו${refreshedCount > 0 ? ` (+${refreshedCount} עודכנו)` : ''}`
          : refreshedCount > 0
            ? `✅ אין הזמנות חדשות. ${refreshedCount} הזמנות קיימות עודכנו`
            : `✅ אין הזמנות חדשות לסנכרון`
        setSyncResult({ platform, message, success: true })
        setWooOrderCount(prev => (prev ?? 0) + newCount)
      } else {
        setSyncResult({ platform, message: `סנכרון הצליח! ${JSON.stringify(data)}`, success: true })
      }
      await loadConnections()
    } catch (err: any) {
      setSyncResult({ platform, message: `שגיאה: ${err.message || 'Sync failed'}`, success: false })
    } finally {
      setSyncing(null)
    }
  }

  const PLATFORM_CONFIG = {
    meta: {
      name: 'Meta (Instagram + Ads)',
      description: 'מחבר Instagram אורגני וקמפיינים ממומנים',
      icon: '📘',
      authUrl: getMetaAuthUrl,
      scopes: ['instagram_basic', 'instagram_manage_insights', 'ads_read'],
    },
    google: {
      name: 'Google (Ads + Search Console)',
      description: 'מחבר קמפיינים ממומנים ונתוני חיפוש אורגני',
      icon: '🔴',
      authUrl: getGoogleAuthUrl,
      scopes: ['Google Ads API', 'Search Console'],
    },
  }

  return (
    <div className="space-y-8 fade-up max-w-2xl">
      <div>
        <h2 className="text-2xl font-display font-semibold text-surface-900">הגדרות</h2>
        <p className="text-sm text-surface-400 mt-1">ניהול חיבורי API</p>
      </div>

      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-surface-500 uppercase tracking-wider">חיבורי ערוצים</h3>

        {syncResult && (
          <div className={`card text-sm ${syncResult.success ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
            {syncResult.message}
          </div>
        )}

        {platforms.map(({ platform, connected, account_name, last_synced }) => {
          const config = PLATFORM_CONFIG[platform]
          return (
            <div key={platform} className="card flex items-start justify-between gap-4">
              <div className="flex items-start gap-4">
                <span className="text-2xl">{config.icon}</span>
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="font-medium text-surface-900">{config.name}</h4>
                    {connected
                      ? <span className="badge badge-success"><CheckCircle size={10} /> מחובר</span>
                      : <span className="badge bg-surface-100 text-surface-500"><XCircle size={10} /> לא מחובר</span>
                    }
                  </div>
                  <p className="text-sm text-surface-400 mt-0.5">{config.description}</p>
                  {account_name && <p className="text-xs text-surface-500 mt-1">חשבון: {account_name}</p>}
                  {last_synced && <p className="text-xs text-surface-400 mt-0.5">סונכרן לאחרונה: {new Date(last_synced).toLocaleString('he-IL')}</p>}
                  <div className="flex flex-wrap gap-1 mt-2">
                    {config.scopes.map(scope => (
                      <span key={scope} className="text-xs bg-surface-100 text-surface-500 px-2 py-0.5 rounded font-mono">{scope}</span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                {connected ? (
                  <>
                    <button
                      onClick={() => sync(platform)}
                      disabled={!!syncing}
                      className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-800 transition-colors px-3 py-1.5 rounded-lg hover:bg-brand-50 disabled:opacity-50"
                    >
                      <RefreshCw size={12} className={syncing === platform ? 'animate-spin' : ''} />
                      {syncing === platform ? 'מסנכרן...' : 'סנכרן'}
                    </button>
                    {platform === 'google' && (
                      <button
                        onClick={() => sync('google_search')}
                        disabled={!!syncing}
                        className="flex items-center gap-1.5 text-xs text-green-600 hover:text-green-800 transition-colors px-3 py-1.5 rounded-lg hover:bg-green-50 disabled:opacity-50"
                      >
                        <RefreshCw size={12} className={syncing === 'google_search' ? 'animate-spin' : ''} />
                        {syncing === 'google_search' ? 'מסנכרן...' : 'סנכרן Search Console'}
                      </button>
                    )}
                    <button
                      onClick={() => disconnect(platform)}
                      className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 transition-colors px-3 py-1.5 rounded-lg hover:bg-red-50"
                    >
                      <Trash2 size={12} />
                      נתק
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => window.location.href = config.authUrl()}
                    className="btn-primary flex items-center gap-1.5"
                  >
                    <ExternalLink size={12} />
                    חבר
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* WooCommerce */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-surface-500 uppercase tracking-wider">חנות מקוונת</h3>
        <div className="card flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <span className="text-2xl">🛒</span>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="font-medium text-surface-900">WooCommerce</h4>
                <span className="badge badge-success"><CheckCircle size={10} /> מחובר</span>
              </div>
              <p className="text-sm text-surface-400 mt-0.5">הזמנות ומכירות — מועבר לסוכני ה-AI</p>
              {wooOrderCount !== null && (
                <p className="text-xs text-surface-500 mt-1">
                  {wooOrderCount.toLocaleString()} הזמנות במסד הנתונים
                </p>
              )}
              <div className="flex flex-wrap gap-1 mt-2">
                {['orders read', 'products read'].map(s => (
                  <span key={s} className="text-xs bg-surface-100 text-surface-500 px-2 py-0.5 rounded font-mono">{s}</span>
                ))}
              </div>
            </div>
          </div>
          <button
            onClick={() => sync('woo_orders')}
            disabled={!!syncing}
            className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-800 transition-colors px-3 py-1.5 rounded-lg hover:bg-brand-50 disabled:opacity-50 shrink-0"
          >
            <RefreshCw size={12} className={syncing === 'woo_orders' ? 'animate-spin' : ''} />
            {syncing === 'woo_orders' ? 'מסנכרן...' : 'סנכרן הזמנות'}
          </button>
        </div>
      </div>
    </div>
  )
}
