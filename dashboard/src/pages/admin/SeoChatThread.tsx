import { useEffect, useRef, useState } from 'react'
import { Send, Wrench, Loader2, Bell } from 'lucide-react'
import { supabase } from '../../lib/supabase'

// Hardcoded mirror of seo-agent/briefingWriter.ts BRIEFING_SESSION_ID.
// Kept in sync manually — both client + server need to know this.
const BRIEFING_SESSION_ID = 'briefings-system'
const LAST_SEEN_KEY       = 'coffeeflow:seo-agent:briefings_last_seen_at'

interface ChatRow {
  id:           string
  session_id:   string
  role:         'user' | 'assistant' | 'tool' | 'system'
  content:      string
  tool_calls:   Array<{ id: string; name: string; input: Record<string, unknown> }> | null
  tool_call_id: string | null
  created_at:   string
  metadata:     Record<string, unknown> | null
}

interface Props {
  sessionId: string
  onSwitchSession?: (sessionId: string) => void
}

export default function SeoChatThread({ sessionId, onSwitchSession }: Props) {
  const [messages, setMessages] = useState<ChatRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [draft, setDraft]       = useState('')
  const [sending, setSending]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [unreadBriefings, setUnreadBriefings] = useState<number>(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Poll for unread briefings whenever we're NOT already on the briefings
  // session. Counts assistant messages in 'briefings-system' created after
  // localStorage[LAST_SEEN_KEY]. Refresh every 60s + via realtime
  // subscription on the briefings session.
  useEffect(() => {
    if (sessionId === BRIEFING_SESSION_ID) {
      setUnreadBriefings(0)
      try { localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString()) } catch { /* noop */ }
      return
    }
    let cancelled = false
    async function countUnread() {
      const lastSeen = (() => {
        try { return localStorage.getItem(LAST_SEEN_KEY) ?? new Date(0).toISOString() } catch { return new Date(0).toISOString() }
      })()
      const { count } = await supabase
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', BRIEFING_SESSION_ID)
        .eq('role', 'assistant')
        .gt('created_at', lastSeen)
      if (!cancelled) setUnreadBriefings(count ?? 0)
    }
    countUnread()
    const interval = setInterval(countUnread, 60_000)
    const channel = supabase
      .channel(`briefings_unread_${sessionId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `session_id=eq.${BRIEFING_SESSION_ID}` },
        countUnread,
      )
      .subscribe()
    return () => {
      cancelled = true
      clearInterval(interval)
      supabase.removeChannel(channel)
    }
  }, [sessionId])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data } = await supabase
        .from('chat_messages')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true })
        .limit(200)
      if (!cancelled) {
        setMessages((data ?? []) as ChatRow[])
        setLoading(false)
      }
    }
    load()

    const channel = supabase
      .channel(`chat_messages_${sessionId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `session_id=eq.${sessionId}` },
        load,
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [sessionId])

  // Briefings is a FEED (newest brief shown first, at the top) — opening it
  // should land on the latest brief's start with no scrolling. The interactive
  // chat stays chronological and follows new messages to the bottom. sessionId
  // is in the deps so switching views re-runs this even when message counts
  // happen to match (length-only deps silently skipped that case).
  const isBriefings = sessionId === BRIEFING_SESSION_ID
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (isBriefings) el.scrollTo({ top: 0 })
    else el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, sending, isBriefings])

  async function send() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    setDraft('')

    const optimistic: ChatRow = {
      id:           `optimistic-${Date.now()}`,
      session_id:   sessionId,
      role:         'user',
      content:      text,
      tool_calls:   null,
      tool_call_id: null,
      created_at:   new Date().toISOString(),
      metadata:     null,
    }
    setMessages(prev => [...prev, optimistic])

    try {
      const { data, error: invokeErr } = await supabase.functions.invoke('handle-seo-chat', {
        body: { session_id: sessionId, user_message: text },
      })
      if (invokeErr) {
        // The Supabase functions SDK collapses non-2xx into a generic
        // "Edge Function returned a non-2xx status code" string. The
        // underlying Response sits on .context — read its body to surface
        // the actual server-side error message in the UI + console.
        let serverDetail: string | null = null
        try {
          const ctx = (invokeErr as any).context
          if (ctx && typeof ctx.json === 'function') {
            const body = await ctx.json()
            serverDetail = body?.error ?? body?.message ?? JSON.stringify(body)
          } else if (ctx && typeof ctx.text === 'function') {
            serverDetail = await ctx.text()
          }
        } catch { /* fall through to generic message */ }
        console.error('[SeoChatThread] send failed:', invokeErr, '\n  server-side:', serverDetail)
        throw new Error(serverDetail ?? invokeErr.message ?? 'Send failed')
      }
      if (data?.history) setMessages(data.history as ChatRow[])
    } catch (e: any) {
      console.error('[SeoChatThread] send failed:', e)
      setError(e?.message ?? 'Send failed')
      setMessages(prev => prev.filter(m => m.id !== optimistic.id))
      setDraft(text)
    } finally {
      setSending(false)
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    // `min-h-0` on the flex column is required for the inner scrollable
    // `flex-1` div to actually shrink — otherwise its natural content
    // height pushes the column taller than h-full and the footer (input)
    // ends up below the viewport. Same gotcha applies to the scroll div
    // itself (also gets min-h-0). `overflow-hidden` on the section is a
    // belt-and-suspenders guarantee that nothing inside can paint past
    // the section's bounds — combined with `shrink-0` on the footer,
    // this makes the textarea PERMANENTLY visible regardless of message
    // count, viewport height, or upstream sizing weirdness.
    <section className="h-full max-h-full flex flex-col bg-surface-50 min-h-0 overflow-hidden">
      <header className="h-10 px-3 flex items-center justify-between border-b border-surface-200 bg-white shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-surface-800">Chat</h2>
          {sessionId === BRIEFING_SESSION_ID && (
            <span className="text-[10px] uppercase tracking-wide font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">briefings</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {sessionId !== BRIEFING_SESSION_ID && onSwitchSession && (
            <button
              onClick={() => onSwitchSession(BRIEFING_SESSION_ID)}
              className={`text-[10px] inline-flex items-center gap-1 px-2 py-1 rounded transition-colors ${
                unreadBriefings > 0
                  ? 'bg-amber-100 text-amber-900 hover:bg-amber-200 font-medium animate-pulse'
                  : 'text-surface-500 hover:bg-surface-100'
              }`}
              title={unreadBriefings > 0 ? `${unreadBriefings} new briefing(s) from the agent` : 'View agent briefings'}
            >
              <Bell size={11} />
              {unreadBriefings > 0 ? `${unreadBriefings} new` : 'briefings'}
            </button>
          )}
          {sessionId === BRIEFING_SESSION_ID && onSwitchSession && (
            <button
              onClick={() => {
                try { localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString()) } catch { /* noop */ }
                const stored = (() => { try { return localStorage.getItem('seo_agent_session_id') ?? '' } catch { return '' } })()
                if (stored && stored !== BRIEFING_SESSION_ID) onSwitchSession(stored)
              }}
              className="text-[10px] text-surface-500 hover:text-surface-900 underline"
            >back to chat</button>
          )}
          <span className="text-[10px] font-mono text-surface-400" title="session id">{sessionId.slice(0, 8)}</span>
        </div>
      </header>

      {sessionId !== BRIEFING_SESSION_ID && unreadBriefings > 0 && (
        <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900 shrink-0 flex items-center justify-between">
          <span>
            <strong>While you were away,</strong> the agent left {unreadBriefings} briefing{unreadBriefings === 1 ? '' : 's'} for you.
          </span>
          {onSwitchSession && (
            <button
              onClick={() => onSwitchSession(BRIEFING_SESSION_ID)}
              className="font-medium underline hover:text-amber-700"
            >View briefings →</button>
          )}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="text-xs text-surface-500">Loading…</div>
        ) : messages.length === 0 ? (
          <div className="text-xs text-surface-500">
            Start typing below. Try: "what's pending?" or "queue an article about V60 brewing for beginners".
          </div>
        ) : (
          (isBriefings ? [...messages].reverse() : messages).map(m => <ChatBubble key={m.id} m={m} />)
        )}
        {sending && (
          <div className="text-xs text-surface-500 inline-flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> thinking…
          </div>
        )}
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-red-700 bg-red-50 border-t border-red-200 shrink-0">{error}</div>
      )}

      <footer className="border-t border-surface-200 bg-white p-3 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder="Message the SEO agent…"
            rows={2}
            disabled={sending}
            className="flex-1 resize-none rounded border border-surface-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-surface-100"
          />
          <button
            onClick={send}
            disabled={sending || draft.trim().length === 0}
            className="inline-flex items-center gap-1 rounded bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send size={14} /> Send
          </button>
        </div>
        <div className="text-[10px] text-surface-400 mt-1">Enter to send · Shift+Enter for newline</div>
      </footer>
    </section>
  )
}

function ChatBubble({ m }: { m: ChatRow }) {
  if (m.role === 'system') {
    return (
      <div className="text-[11px] text-surface-500 italic">{m.content}</div>
    )
  }
  if (m.role === 'tool') {
    let parsed: unknown = m.content
    try { parsed = JSON.parse(m.content) } catch { /* leave as string */ }
    return (
      <details className="text-[11px] bg-surface-100 border border-surface-200 rounded px-2 py-1">
        <summary className="cursor-pointer text-surface-600 inline-flex items-center gap-1">
          <Wrench size={11} /> tool result
        </summary>
        <pre className="mt-1 whitespace-pre-wrap break-all text-[10px] text-surface-700">
{JSON.stringify(parsed, null, 2)}
        </pre>
      </details>
    )
  }
  const isUser = m.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
          isUser ? 'bg-brand-600 text-white' : 'bg-white border border-surface-200 text-surface-900'
        }`}
      >
        {m.content && <div>{m.content}</div>}
        {Array.isArray(m.tool_calls) && m.tool_calls.length > 0 && (
          <div className={`mt-2 space-y-1 ${isUser ? '' : ''}`}>
            {m.tool_calls.map(tc => (
              <div
                key={tc.id}
                className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded ${
                  isUser ? 'bg-brand-700/50' : 'bg-surface-100 text-surface-700'
                }`}
                title={JSON.stringify(tc.input)}
              >
                <Wrench size={10} /> {tc.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
