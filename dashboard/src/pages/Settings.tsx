import { useState, useEffect } from 'react'
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, RefreshCw, Store, Unplug, X } from 'lucide-react'
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
    if (!confirm(`לנתק את ${platform === 'meta' ? 'Meta' : 'Google'}? הסנכרון ייעצר עד לחיבור מחדש.`)) return
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
        setSyncResult({ platform: platform as any, message: `סנכרון: ${phase}…`, success: true })
      }
    }
    throw new Error(`Sync timed out after ${timeoutMs / 1000}s, check sync_log row ${syncId}`)
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
        setSyncResult({ platform, message: 'הסנכרון רץ ברקע…', success: true })
        const finalRow = await pollSyncLog(asyncResponse.sync_id, platform)
        const finalStatus = finalRow.status as 'success' | 'partial' | 'error'
        const records = finalRow.records ?? 0
        const errMsg = finalRow.error_msg
        const message =
          finalStatus === 'success' ? `הסנכרון הסתיים בהצלחה (${records} רשומות)` :
          finalStatus === 'partial' ? `סנכרון חלקי: ${records} רשומות, שגיאות: ${errMsg ?? 'לא ידוע'}` :
                                       `הסנכרון נכשל: ${errMsg ?? 'שגיאה לא ידועה'}`
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
          ? `${newCount} הזמנות חדשות סונכרנו${refreshedCount > 0 ? ` (+${refreshedCount} עודכנו)` : ''}`
          : refreshedCount > 0
            ? `אין הזמנות חדשות. ${refreshedCount} הזמנות קיימות עודכנו`
            : `אין הזמנות חדשות לסנכרון`
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
      name: 'Meta',
      description: 'אינסטגרם אורגני וקמפיינים ממומנים',
      logo: MetaLogo,
      authUrl: getMetaAuthUrl,
      scopes: ['instagram_basic', 'instagram_manage_insights', 'ads_read'],
    },
    google: {
      name: 'Google',
      description: 'קמפיינים ממומנים ונתוני חיפוש אורגני (Search Console)',
      logo: GoogleLogo,
      authUrl: getGoogleAuthUrl,
      scopes: ['Google Ads API', 'Search Console'],
    },
  }

  // Which row a sync result belongs to: the Search Console sync lives on the Google row.
  const resultRow = (target: string) => (target === 'google_search' ? 'google' : target === 'woo_orders' ? 'woo' : target)
  const rowResult = (row: string) => (syncResult && resultRow(syncResult.platform) === row ? syncResult : null)
  const rowSyncing = (row: string) => !!syncing && resultRow(syncing) === row

  return (
    <div className="fade-up max-w-[820px] space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-surface-900">הגדרות</h1>
        <p className="text-sm text-surface-500 mt-1">חיבורי הערוצים והחנות, וסנכרון ידני של הנתונים.</p>
      </header>

      <section aria-labelledby="set-channels">
        <div className="mb-3">
          <h2 id="set-channels" className="text-[17px] text-surface-900">חיבורי ערוצים</h2>
          <p className="text-sm text-surface-500 mt-1">מכאן סוכני השיווק קוראים נתוני קמפיינים, אינסטגרם וחיפוש.</p>
        </div>

        <ul className="bg-white border border-surface-200 rounded-[10px] divide-y divide-surface-200">
          {platforms.map(({ platform, connected, account_name, last_synced }) => {
            const config = PLATFORM_CONFIG[platform]
            const Logo = config.logo
            const result = rowResult(platform)
            const checking = loading && !connected
            const failed = !!result && !result.success && !rowSyncing(platform)
            return (
              <li key={platform} className="px-[18px] py-4">
                <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-4">
                  <div className="flex items-start gap-3.5 min-w-0 flex-1">
                    <span className="grid place-items-center w-10 h-10 shrink-0 rounded-lg border border-surface-200 bg-white">
                      <Logo />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h3 className="text-[15px] text-surface-900">{config.name}</h3>
                        {checking
                          ? <StatusTag tone="neutral" label="בודק חיבור…" />
                          : failed
                            ? <StatusTag tone="danger" label="שגיאה בסנכרון" />
                            : connected
                              ? <StatusTag tone="ok" label="מחובר" />
                              : <StatusTag tone="neutral" label="לא מחובר" />}
                      </div>
                      <p className="text-sm text-surface-500 mt-0.5">{config.description}</p>
                      {(account_name || last_synced) && (
                        <p className="text-[13px] text-surface-500 mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                          {account_name && <span>חשבון: <span className="text-surface-700">{account_name}</span></span>}
                          {last_synced && <span className="num">עודכן: {formatWhen(last_synced)}</span>}
                        </p>
                      )}
                      <ScopeList scopes={config.scopes} />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0 sm:justify-end">
                    {connected ? (
                      <>
                        <button
                          onClick={() => sync(platform)}
                          disabled={!!syncing}
                          className="btn-secondary"
                        >
                          <RefreshCw size={16} aria-hidden="true" className={syncing === platform ? 'animate-spin' : ''} />
                          {syncing === platform ? 'מסנכרן…' : 'סנכרון'}
                        </button>
                        {platform === 'google' && (
                          <button
                            onClick={() => sync('google_search')}
                            disabled={!!syncing}
                            className="btn-secondary"
                          >
                            <RefreshCw size={16} aria-hidden="true" className={syncing === 'google_search' ? 'animate-spin' : ''} />
                            {syncing === 'google_search' ? 'מסנכרן…' : 'סנכרון Search Console'}
                          </button>
                        )}
                        <button
                          onClick={() => disconnect(platform)}
                          className={BTN_QUIET_DANGER}
                        >
                          <Unplug size={16} aria-hidden="true" />
                          ניתוק
                        </button>
                      </>
                    ) : !checking && (
                      <button
                        onClick={() => window.location.href = config.authUrl()}
                        className="btn-secondary"
                      >
                        <Logo size={16} />
                        חיבור {config.name}
                        <ExternalLink size={14} aria-hidden="true" className="text-surface-500" />
                      </button>
                    )}
                  </div>
                </div>
                <SyncNotice result={result} running={rowSyncing(platform)} onDismiss={() => setSyncResult(null)} />
              </li>
            )
          })}
        </ul>
      </section>

      {/* WooCommerce */}
      <section aria-labelledby="set-store">
        <div className="mb-3">
          <h2 id="set-store" className="text-[17px] text-surface-900">חנות מקוונת</h2>
          <p className="text-sm text-surface-500 mt-1">הזמנות האתר, שמשמשות את הסוכנים ואת דוחות המכירות.</p>
        </div>

        <div className="bg-white border border-surface-200 rounded-[10px] px-[18px] py-4">
          <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-4">
            <div className="flex items-start gap-3.5 min-w-0 flex-1">
              <span className="grid place-items-center w-10 h-10 shrink-0 rounded-lg border border-surface-200 bg-white text-surface-700">
                <Store size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h3 className="text-[15px] text-surface-900">WooCommerce</h3>
                  {rowResult('woo') && !rowResult('woo')!.success && !rowSyncing('woo')
                    ? <StatusTag tone="danger" label="שגיאה בסנכרון" />
                    : <StatusTag tone="ok" label="מחובר" />}
                </div>
                <p className="text-sm text-surface-500 mt-0.5">הזמנות ומכירות, זמינות לסוכני ה-AI</p>
                {wooOrderCount !== null && (
                  <p className="text-[13px] text-surface-500 mt-1.5">
                    <span className="num text-surface-700 font-medium">{wooOrderCount.toLocaleString()}</span> הזמנות במסד הנתונים
                  </p>
                )}
                <ScopeList scopes={['orders read', 'products read']} />
              </div>
            </div>
            <div className="flex shrink-0">
              <button
                onClick={() => sync('woo_orders')}
                disabled={!!syncing}
                className="btn-secondary"
              >
                <RefreshCw size={16} aria-hidden="true" className={syncing === 'woo_orders' ? 'animate-spin' : ''} />
                {syncing === 'woo_orders' ? 'מסנכרן…' : 'סנכרון הזמנות'}
              </button>
            </div>
          </div>
          <SyncNotice result={rowResult('woo')} running={rowSyncing('woo')} onDismiss={() => setSyncResult(null)} />
        </div>
      </section>
    </div>
  )
}

// ── Local pieces ─────────────────────────────────────────────────────────

// Quiet at rest, red only when pointed at (same rule as CoffeeFlow's row deletes).
const BTN_QUIET_DANGER =
  'inline-flex items-center justify-center gap-2 h-[38px] px-3 rounded-lg text-sm font-medium whitespace-nowrap text-surface-700 ' +
  'transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97] ' +
  'hover:bg-[#FDF1EF] hover:text-[#B42318] disabled:opacity-50 disabled:cursor-not-allowed'

const TAG_TONE = {
  ok:      { tag: 'bg-[#EEF3E8] text-[#3F6B2A]', dot: 'bg-[#3F6B2A]' },
  warn:    { tag: 'bg-[#FCF5E8] text-[#A15C07]', dot: 'bg-[#D9921C]' },
  danger:  { tag: 'bg-[#FDF1EF] text-[#B42318]', dot: 'bg-[#B42318]' },
  neutral: { tag: 'bg-surface-100 text-surface-700', dot: 'bg-surface-400' },
} as const

function StatusTag({ tone, label }: { tone: keyof typeof TAG_TONE; label: string }) {
  const t = TAG_TONE[tone]
  return (
    <span className={`inline-flex items-center gap-1.5 h-[22px] px-2 rounded-md text-xs font-semibold whitespace-nowrap ${t.tag}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} aria-hidden="true" />
      {label}
    </span>
  )
}

function ScopeList({ scopes }: { scopes: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1 mt-2.5" aria-label="הרשאות">
      {scopes.map(scope => (
        <li key={scope} dir="ltr" className="text-[11.5px] leading-5 px-1.5 rounded bg-surface-100 text-surface-600 font-mono">{scope}</li>
      ))}
    </ul>
  )
}

// The result of the last manual sync, shown under the row that started it.
function SyncNotice({ result, running, onDismiss }: {
  result: { message: string; success: boolean } | null
  running: boolean
  onDismiss: () => void
}) {
  if (!result && !running) return null
  const tone = running ? 'neutral' : result!.success ? 'ok' : 'danger'
  const cls =
    tone === 'ok'     ? 'bg-[#EEF3E8] border-[#3F6B2A]/15' :
    tone === 'danger' ? 'bg-[#FDF1EF] border-[#B42318]/15' :
                        'bg-surface-50 border-surface-200'
  return (
    <div role="status" aria-live="polite" className={`mt-3 sm:ms-[54px] flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] text-surface-900 ${cls}`}>
      {tone === 'neutral' && <Loader2 size={16} aria-hidden="true" className="animate-spin text-surface-500 shrink-0 mt-px" />}
      {tone === 'ok' && <CheckCircle2 size={16} aria-hidden="true" className="text-[#3F6B2A] shrink-0 mt-px" />}
      {tone === 'danger' && <AlertCircle size={16} aria-hidden="true" className="text-[#B42318] shrink-0 mt-px" />}
      <p className="flex-1 min-w-0 break-words">{result?.message ?? 'הסנכרון התחיל…'}</p>
      {!running && (
        <button
          onClick={onDismiss}
          aria-label="סגירת ההודעה"
          className="grid place-items-center w-8 h-8 -my-1.5 -me-1.5 rounded-md text-surface-500 hover:bg-black/5 hover:text-surface-900 transition-colors shrink-0"
        >
          <X size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })
}

// Channel marks: small and recognisable, never a full brand-colour fill.
function MetaLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 11.2C10.4 8.4 8.7 6.5 6.8 6.5 4.6 6.5 3 9.2 3 12.4 3 15.1 4.4 17.5 6.6 17.5c1.9 0 3.4-2 5.4-5.3 2-3.3 3.5-5.7 5.6-5.7 2.2 0 3.4 2.8 3.4 5.7 0 3-1.3 5.3-3.4 5.3-1.9 0-3.6-2.1-5.6-6.3z"
        stroke="#0866FF" strokeWidth="2" strokeLinejoin="round"
      />
    </svg>
  )
}

function GoogleLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  )
}
