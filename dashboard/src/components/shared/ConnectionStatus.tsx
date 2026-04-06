import { CheckCircle, XCircle, RefreshCw, AlertCircle } from 'lucide-react'
import { ConnectionStatus as IConnectionStatus } from '../../lib/types'
import { formatDate } from '../../lib/utils'

interface Props {
  connections: IConnectionStatus[]
  onConnect: (platform: 'meta' | 'google') => void
  onSync: (platform: 'meta' | 'google') => void
  syncing?: 'meta' | 'google' | null
}

const PLATFORM_LABELS = {
  meta: { name: 'Meta (Instagram)', color: '#1877f2', bg: 'bg-blue-50' },
  google: { name: 'Google Ads', color: '#ea4335', bg: 'bg-red-50' },
}

export function ConnectionStatusBar({ connections, onConnect, onSync, syncing }: Props) {
  return (
    <div className="flex flex-wrap gap-3">
      {connections.map((conn) => {
        const meta = PLATFORM_LABELS[conn.platform]
        const isSyncing = syncing === conn.platform

        return (
          <div key={conn.platform} className={`flex items-center gap-3 card-sm ${meta.bg} border-0`}>
            <div className="flex items-center gap-2">
              {conn.connected ? (
                <CheckCircle size={16} className="text-green-500" />
              ) : conn.error ? (
                <AlertCircle size={16} className="text-amber-500" />
              ) : (
                <XCircle size={16} className="text-surface-300" />
              )}
              <span className="text-sm font-medium text-surface-700">{meta.name}</span>
            </div>

            {conn.connected ? (
              <div className="flex items-center gap-2">
                {conn.last_synced && (
                  <span className="text-xs text-surface-400">סונכרן {formatDate(conn.last_synced)}</span>
                )}
                <button
                  onClick={() => onSync(conn.platform)}
                  disabled={isSyncing}
                  className="flex items-center gap-1 text-xs text-surface-500 hover:text-surface-700 transition-colors"
                >
                  <RefreshCw size={12} className={isSyncing ? 'animate-spin' : ''} />
                  {isSyncing ? 'מסנכרן...' : 'סנכרן'}
                </button>
              </div>
            ) : (
              <button
                onClick={() => onConnect(conn.platform)}
                className="text-xs font-medium px-3 py-1 bg-white rounded-lg border border-surface-200 hover:bg-surface-50 transition-colors"
                style={{ color: meta.color }}
              >
                חבר
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
