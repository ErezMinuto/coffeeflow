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

type MobilePanel = 'tasks' | 'chat' | 'metrics'

export default function SeoAgent() {
  const [sessionId, setSessionId] = useState<string>('')
  // Which panel is visible on mobile (< lg). Desktop shows all three at
  // once via the grid; this only drives the small-screen tab switcher.
  // Chat is the default — it's the primary interaction surface.
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('chat')

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

  const tabs: Array<{ key: MobilePanel; label: string }> = [
    { key: 'chat',    label: 'Chat' },
    { key: 'tasks',   label: 'Tasks' },
    { key: 'metrics', label: 'Metrics' },
  ]

  return (
    <SeoAgentLayout>
      <div className="h-full flex flex-col min-h-0">
        {/* Mobile-only tab switcher. Hidden at lg+ where all three panels
            show side by side. Lets the page work on a phone instead of
            overflowing the fixed 280/1fr/300 desktop grid. */}
        <div className="lg:hidden flex shrink-0 border-b border-surface-200 bg-white">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setMobilePanel(t.key)}
              className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
                mobilePanel === t.key
                  ? 'text-brand-700 border-b-2 border-brand-600 bg-brand-50/40'
                  : 'text-surface-500 hover:text-surface-800'
              }`}
            >{t.label}</button>
          ))}
        </div>

        {/* Mobile: single column, only the active panel is shown (others
            `hidden` but still MOUNTED, so realtime subs + chat state
            survive tab switches). Desktop (lg+): the original 3-column
            grid, all panels visible.

            `grid-rows-1` is load-bearing — without it the implicit row is
            content-sized, `h-full` on children resolves to natural height,
            and the chat footer drops below the viewport. `grid-rows-1` =
            `minmax(0,1fr)`: fillable AND shrinkable. */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[280px_1fr_300px] grid-rows-1 gap-0">
          <div className={`${mobilePanel === 'tasks' ? 'block' : 'hidden'} lg:block h-full min-h-0 overflow-hidden`}>
            <SeoTaskQueue />
          </div>
          <div className={`${mobilePanel === 'chat' ? 'block' : 'hidden'} lg:block h-full min-h-0 overflow-hidden`}>
            <SeoChatThread sessionId={sessionId} onSwitchSession={setSessionId} />
          </div>
          <div className={`${mobilePanel === 'metrics' ? 'flex' : 'hidden'} lg:flex flex-col h-full min-h-0 overflow-hidden`}>
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
      </div>
    </SeoAgentLayout>
  )
}
