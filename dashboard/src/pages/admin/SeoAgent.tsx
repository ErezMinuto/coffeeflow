import { useEffect, useState } from 'react'
import SeoAgentLayout from './SeoAgentLayout'
import SeoTaskQueue from './SeoTaskQueue'
import SeoChatThread from './SeoChatThread'
import SeoMetricsPanel from './SeoMetricsPanel'

const SESSION_STORAGE_KEY = 'seo_agent_session_id'

function loadOrCreateSessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_STORAGE_KEY)
    if (existing) return existing
  } catch { /* localStorage may be disabled */ }
  const fresh = crypto.randomUUID()
  try { localStorage.setItem(SESSION_STORAGE_KEY, fresh) } catch { /* noop */ }
  return fresh
}

export default function SeoAgent() {
  const [sessionId, setSessionId] = useState<string>('')

  useEffect(() => {
    setSessionId(loadOrCreateSessionId())
  }, [])

  function newSession() {
    const fresh = crypto.randomUUID()
    try { localStorage.setItem(SESSION_STORAGE_KEY, fresh) } catch { /* noop */ }
    setSessionId(fresh)
  }

  if (!sessionId) {
    return (
      <SeoAgentLayout>
        <div className="h-full flex items-center justify-center text-sm text-surface-500">Initializing…</div>
      </SeoAgentLayout>
    )
  }

  return (
    <SeoAgentLayout>
      <div className="h-full grid grid-cols-[280px_1fr_300px] gap-0">
        <SeoTaskQueue />
        <SeoChatThread sessionId={sessionId} />
        <div className="flex flex-col h-full">
          <SeoMetricsPanel />
          <div className="border-t border-surface-200 bg-white px-3 py-2 shrink-0">
            <button
              onClick={newSession}
              className="text-[11px] text-surface-500 hover:text-surface-900 underline"
              title="Start a fresh chat session (history stays in DB)"
            >New session</button>
          </div>
        </div>
      </div>
    </SeoAgentLayout>
  )
}
