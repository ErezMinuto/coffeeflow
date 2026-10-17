import { useEffect, useState } from 'react'
import { LayoutGrid, Compass } from 'lucide-react'
import SeoAgentLayout from './SeoAgentLayout'
import SeoTaskQueue from './SeoTaskQueue'
import SeoChatThread from './SeoChatThread'
import SeoMetricsPanel from './SeoMetricsPanel'
import StrategicBriefPanel from './StrategicBriefPanel'
import { supabase } from '../../lib/supabase'

const SESSION_STORAGE_KEY = 'seo_agent_session_id'
// Hardcoded mirror of seo-agent/briefingWriter.ts BRIEFING_SESSION_ID. That
// feed is written BY the agent, so it never counts as a conversation the
// admin started.
const BRIEFING_SESSION_ID = 'briefings-system'

function readCachedSessionId(): string | null {
  try { return localStorage.getItem(SESSION_STORAGE_KEY) } catch { return null }
}

function cacheSessionId(id: string): void {
  try { localStorage.setItem(SESSION_STORAGE_KEY, id) } catch { /* localStorage may be disabled */ }
}

// The conversation itself has always lived in chat_messages — but WHICH
// session is "current" used to live only in this browser's localStorage. So a
// laptop and a phone each minted their own UUID, rendered different threads,
// and the agent (which loads history by session_id) had no memory of anything
// said on the other device.
//
// Resolve the current session from the DB instead: the session of the most
// recent non-briefing message, which is the same answer on every device.
// localStorage is now only a fallback for when that query can't run.
async function resolveSessionId(): Promise<string> {
  try {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('session_id')
      .neq('session_id', BRIEFING_SESSION_ID)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!error && data?.session_id) return data.session_id
  } catch { /* offline — fall through to the local fallback */ }
  return readCachedSessionId() ?? crypto.randomUUID()
}

type MobilePanel = 'tasks' | 'chat' | 'metrics'
// Top-level view: the existing 3-panel content workspace, or the full-width
// strategist "State of Minuto" brief (a reading surface that wants width, so
// it gets its own view rather than a cramped 4th grid column).
type View = 'workspace' | 'brief'

export default function SeoAgent() {
  const [sessionId, setSessionId] = useState<string>('')
  // Which panel is visible on mobile (< lg). Desktop shows all three at
  // once via the grid; this only drives the small-screen tab switcher.
  // Chat is the default — it's the primary interaction surface.
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('chat')
  // Honor a ?view=brief deep-link (the home "Needs You" panel links proposals
  // and signals straight to the strategist brief, not the content workspace).
  const [view, setView] = useState<View>(
    new URLSearchParams(window.location.search).get('view') === 'brief' ? 'brief' : 'workspace'
  )

  useEffect(() => {
    let cancelled = false
    async function adopt() {
      const id = await resolveSessionId()
      if (cancelled) return
      cacheSessionId(id)
      // Don't yank the view away from someone reading the briefings feed —
      // "back to chat" reads the cache we just refreshed, so they land on the
      // resolved session when they ask for it.
      setSessionId(prev => (prev === BRIEFING_SESSION_ID ? prev : id))
    }
    adopt()
    // Re-resolve when the tab returns to the foreground. Phones suspend
    // background tabs, so without this you come back to a thread the laptop
    // has since moved on from.
    function onVisible() { if (document.visibilityState === 'visible') adopt() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [])

  async function newSession() {
    const fresh = crypto.randomUUID()
    cacheSessionId(fresh)
    setSessionId(fresh)
    // Write a marker row so the fresh session becomes the most-recent one in
    // chat_messages — that is what makes the other devices follow us into it
    // instead of resolving back to the thread we just left. handle-seo-chat
    // skips role='system' rows when it rebuilds the model's history, so this
    // costs the agent nothing.
    await supabase.from('chat_messages').insert({
      session_id: fresh,
      role:       'system',
      content:    'New session started.',
    })
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

  const views: Array<{ key: View; label: string; icon: typeof LayoutGrid }> = [
    { key: 'workspace', label: 'Workspace',      icon: LayoutGrid },
    { key: 'brief',     label: 'State of Minuto', icon: Compass },
  ]

  return (
    <SeoAgentLayout>
      <div className="h-full flex flex-col min-h-0">
        {/* Top-level view switcher (always visible): the content workspace vs
            the full-width strategist brief. */}
        <div className="flex shrink-0 border-b border-surface-200 bg-white">
          {views.map(v => {
            const Icon = v.icon
            return (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors ${
                  view === v.key
                    ? 'text-brand-700 border-b-2 border-brand-600 bg-brand-50/40'
                    : 'text-surface-500 hover:text-surface-800'
                }`}
              ><Icon size={13} /> {v.label}</button>
            )
          })}
        </div>

        {view === 'brief' ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <StrategicBriefPanel />
          </div>
        ) : (
        <div className="flex-1 min-h-0 flex flex-col">
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
            <SeoChatThread sessionId={sessionId} onSwitchSession={setSessionId} onNewSession={newSession} />
          </div>
          <div className={`${mobilePanel === 'metrics' ? 'flex' : 'hidden'} lg:flex flex-col h-full min-h-0 overflow-hidden`}>
            <SeoMetricsPanel />
          </div>
        </div>
        </div>
        )}
      </div>
    </SeoAgentLayout>
  )
}
