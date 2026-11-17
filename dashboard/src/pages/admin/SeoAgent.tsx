import { useEffect, useState } from 'react'
import { LayoutGrid, Compass, Inbox, MessageSquare, ListChecks, BarChart3 } from 'lucide-react'
import SeoAgentLayout from './SeoAgentLayout'
import SeoTaskQueue from './SeoTaskQueue'
import SeoChatThread from './SeoChatThread'
import SeoMetricsPanel from './SeoMetricsPanel'
import StrategicBriefPanel from './StrategicBriefPanel'
import ApprovalInbox from './ApprovalInbox'
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
type View = 'workspace' | 'brief' | 'inbox'

export default function SeoAgent() {
  const [sessionId, setSessionId] = useState<string>('')
  // Which panel is visible on mobile (< lg). Desktop shows all three at
  // once via the grid; this only drives the small-screen tab switcher.
  // Chat is the default — it's the primary interaction surface.
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('chat')
  // Honor a ?view=brief deep-link (the home "Needs You" panel links proposals
  // and signals straight to the strategist brief, not the content workspace).
  const [view, setView] = useState<View>(
    (() => {
      const v = new URLSearchParams(window.location.search).get('view')
      return v === 'brief' || v === 'inbox' ? v : 'workspace'
    })()
  )
  // "Guide the agent" from the Approvals inbox → prefill the chat composer.
  const [chatPrefill, setChatPrefill] = useState<{ text: string; nonce: number } | null>(null)

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
        <div className="h-full flex items-center justify-center text-[13px] text-surface-500" role="status">טוען את השיחה…</div>
      </SeoAgentLayout>
    )
  }

  const tabs: Array<{ key: MobilePanel; label: string; icon: typeof LayoutGrid }> = [
    { key: 'chat',    label: 'שיחה',   icon: MessageSquare },
    { key: 'tasks',   label: 'משימות', icon: ListChecks },
    { key: 'metrics', label: 'מדדים',  icon: BarChart3 },
  ]

  const views: Array<{ key: View; label: string; icon: typeof LayoutGrid }> = [
    { key: 'inbox',     label: 'אישורים',      icon: Inbox },
    { key: 'workspace', label: 'סביבת עבודה', icon: LayoutGrid },
    { key: 'brief',     label: 'מצב מינוטו',  icon: Compass },
  ]

  // Each panel is a white hairline card on the paper ground.
  const panel = 'h-full min-h-0 overflow-hidden bg-white border border-surface-200 rounded-[10px]'

  return (
    <SeoAgentLayout>
      <div className="h-full flex flex-col min-h-0">
        {/* Top-level view switcher (always visible): approvals, the content
            workspace, or the full-width strategist brief. */}
        <div className="shrink-0 px-3 pt-3 lg:px-4 lg:pt-4">
          <div className="flex w-full sm:w-auto sm:inline-flex gap-1 p-1 bg-white border border-surface-200 rounded-[10px] overflow-x-auto" role="group" aria-label="תצוגה">
            {views.map(v => {
              const Icon = v.icon
              return (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setView(v.key)}
                  aria-pressed={view === v.key}
                  className="seg-btn flex-1 sm:flex-none"
                ><Icon size={16} aria-hidden="true" /> {v.label}</button>
              )
            })}
          </div>
        </div>

        {view === 'inbox' ? (
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_420px] grid-rows-1 gap-4 p-3 lg:p-4">
            <div className={panel}>
              <ApprovalInbox onGuide={text => {
                setChatPrefill({ text, nonce: Date.now() })
                // Below lg the chat is not beside the inbox: jump to the workspace chat.
                if (window.innerWidth < 1024) { setView('workspace'); setMobilePanel('chat') }
              }} />
            </div>
            <div className={`hidden lg:block ${panel}`}>
              <SeoChatThread sessionId={sessionId} onSwitchSession={setSessionId} onNewSession={newSession} prefill={chatPrefill} />
            </div>
          </div>
        ) : view === 'brief' ? (
          <div className="flex-1 min-h-0 p-3 lg:p-4">
            <div className={panel}>
              <StrategicBriefPanel />
            </div>
          </div>
        ) : (
        <div className="flex-1 min-h-0 flex flex-col">
        {/* Mobile-only tab switcher. Hidden at lg+ where all three panels
            show side by side. Lets the page work on a phone instead of
            overflowing the fixed 280/1fr/300 desktop grid. */}
        <div className="lg:hidden shrink-0 px-3 pt-2">
          <div className="flex gap-1 p-1 bg-white border border-surface-200 rounded-[10px]" role="group" aria-label="חלונית">
            {tabs.map(t => {
              const Icon = t.icon
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setMobilePanel(t.key)}
                  aria-pressed={mobilePanel === t.key}
                  className="seg-btn flex-1"
                ><Icon size={16} aria-hidden="true" /> {t.label}</button>
              )
            })}
          </div>
        </div>

        {/* Mobile: single column, only the active panel is shown (others
            `hidden` but still MOUNTED, so realtime subs + chat state
            survive tab switches). Desktop (lg+): the original 3-column
            grid, all panels visible.

            `grid-rows-1` is load-bearing — without it the implicit row is
            content-sized, `h-full` on children resolves to natural height,
            and the chat footer drops below the viewport. `grid-rows-1` =
            `minmax(0,1fr)`: fillable AND shrinkable. */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[300px_1fr_280px] grid-rows-1 gap-4 p-3 lg:p-4">
          <div className={`${mobilePanel === 'tasks' ? 'block' : 'hidden'} lg:block ${panel}`}>
            <SeoTaskQueue />
          </div>
          <div className={`${mobilePanel === 'chat' ? 'block' : 'hidden'} lg:block ${panel}`}>
            <SeoChatThread sessionId={sessionId} onSwitchSession={setSessionId} onNewSession={newSession} prefill={chatPrefill} />
          </div>
          <div className={`${mobilePanel === 'metrics' ? 'flex' : 'hidden'} lg:flex flex-col ${panel}`}>
            <SeoMetricsPanel />
          </div>
        </div>
        </div>
        )}
      </div>
    </SeoAgentLayout>
  )
}
