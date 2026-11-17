import { useEffect, useRef, useState } from 'react'
import { Send, Wrench, Loader2, Bell, Plus, ArrowRight, ChevronLeft, MessageSquare, AlertCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { PanelHead, Tag, Dot } from './seoUi'

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
  onNewSession?:    () => void
  // Text to put in the composer (e.g. from the Approvals inbox "Guide the
  // agent" button). The nonce makes the same text re-apply on a second click.
  prefill?:         { text: string; nonce: number } | null
}

export default function SeoChatThread({ sessionId, onSwitchSession, onNewSession, prefill }: Props) {
  const [messages, setMessages] = useState<ChatRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [draft, setDraft]       = useState('')
  useEffect(() => { if (prefill?.text) setDraft(prefill.text) }, [prefill?.nonce])
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
      // CRITICAL: fetch the MOST-RECENT 200 rows, not the oldest. Ordering
      // ascending + limit(200) silently dropped the newest messages once a
      // session passed 200 rows — and sessions cross that fast, since every
      // chat turn writes several rows (user + assistant tool_use turns + tool
      // results + final text). That truncation is exactly the "recent history
      // missing on session open" bug. Mirror the server-side getChatHistory
      // fix: order descending, limit, then reverse back to chronological so
      // the rest of the component (and the briefings reverse) is unchanged.
      const { data } = await supabase
        .from('chat_messages')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(200)
      if (!cancelled) {
        setMessages(((data ?? []) as ChatRow[]).reverse())
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

  // Both the interactive chat AND the briefings feed use standard chat UX:
  // messages render chronologically (newest at the bottom, above the input)
  // and the view follows new messages down. On load + on every new message we
  // scroll to the bottom so the latest message is visible without scrolling;
  // older messages are reachable by scrolling up. sessionId is in the deps so
  // switching views re-runs this even when message counts happen to match
  // (length-only deps silently skipped that case).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, sending, sessionId])

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
        throw new Error(serverDetail ?? invokeErr.message ?? 'השליחה נכשלה')
      }
      if (data?.history) setMessages(data.history as ChatRow[])
    } catch (e: any) {
      console.error('[SeoChatThread] send failed:', e)
      setError(e?.message ?? 'השליחה נכשלה')
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

  const onBriefings = sessionId === BRIEFING_SESSION_ID

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
    <section className="h-full max-h-full flex flex-col min-h-0 overflow-hidden" aria-label="שיחה עם הסוכן">
      <PanelHead
        title={<>{onBriefings ? 'תדריכים מהסוכן' : 'שיחה'}</>}
        meta={<span className="font-mono text-[11.5px] text-surface-400" title="מזהה שיחה" dir="ltr">{sessionId.slice(0, 8)}</span>}
      >
        {!onBriefings && onSwitchSession && (
          <button
            type="button"
            onClick={() => onSwitchSession(BRIEFING_SESSION_ID)}
            className="act"
            title={unreadBriefings > 0 ? `${unreadBriefings} תדריכים חדשים מהסוכן` : 'תדריכים מהסוכן'}
          >
            <Bell size={16} aria-hidden="true" />
            <span className="hidden sm:inline">תדריכים</span>
            {unreadBriefings > 0 && <Tag tone="warn"><span className="num">{unreadBriefings}</span></Tag>}
          </button>
        )}
        {onBriefings && onSwitchSession && (
          <button
            type="button"
            onClick={() => {
              try { localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString()) } catch { /* noop */ }
              const stored = (() => { try { return localStorage.getItem('seo_agent_session_id') ?? '' } catch { return '' } })()
              if (stored && stored !== BRIEFING_SESSION_ID) onSwitchSession(stored)
            }}
            className="act"
          ><ArrowRight size={16} aria-hidden="true" /> חזרה לשיחה</button>
        )}
        {!onBriefings && onNewSession && (
          <button
            type="button"
            onClick={onNewSession}
            disabled={sending}
            className="act"
            title="שיחה חדשה. ההיסטוריה נשמרת והלמידה של הסוכן ממשיכה"
          >
            <Plus size={16} aria-hidden="true" /> <span className="hidden sm:inline">שיחה חדשה</span><span className="sm:hidden">חדשה</span>
          </button>
        )}
      </PanelHead>

      {!onBriefings && unreadBriefings > 0 && (
        <div className="shrink-0 px-4 py-1.5 border-b border-surface-200 bg-warn-soft flex items-center gap-2 text-[13px] text-surface-900">
          <Dot tone="warn" />
          <span className="flex-1 min-w-0">
            בזמן שלא היית כאן הסוכן השאיר <span className="num font-medium">{unreadBriefings}</span> {unreadBriefings === 1 ? 'תדריך' : 'תדריכים'}.
          </span>
          {onSwitchSession && (
            <button
              type="button"
              onClick={() => onSwitchSession(BRIEFING_SESSION_ID)}
              className="act primary"
            >לתדריכים <ChevronLeft size={16} aria-hidden="true" /></button>
          )}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4 bg-surface-50">
        {loading ? (
          <div className="space-y-4" role="status" aria-label="טוען שיחה">
            <div className="skel lg w-2/3" />
            <div className="skel lg w-1/2 ms-auto" />
            <div className="skel lg w-3/5" />
          </div>
        ) : messages.length === 0 ? (
          <div className="max-w-sm mx-auto py-10 text-center text-[13px] leading-relaxed text-surface-500">
            <MessageSquare size={18} aria-hidden="true" className="mx-auto mb-2 text-surface-400" />
            אפשר לכתוב לסוכן בשדה למטה. למשל: "מה ממתין?" או "להוסיף לתור מאמר על חליטת V60 למתחילים".
          </div>
        ) : (
          messages.map(m => <ChatBubble key={m.id} m={m} />)
        )}
        {sending && (
          <div className="text-[13px] text-surface-500 inline-flex items-center gap-2" role="status">
            <Loader2 size={14} aria-hidden="true" className="animate-spin" /> הסוכן חושב…
          </div>
        )}
      </div>

      {error && (
        <div className="shrink-0 px-4 py-2 border-t border-[#F1D3CE] bg-danger-soft text-[13px] text-danger flex items-start gap-2" role="alert">
          <AlertCircle size={16} aria-hidden="true" className="shrink-0 mt-0.5" />
          <span className="min-w-0 break-words" dir="auto">{error}</span>
        </div>
      )}

      <footer className="border-t border-surface-200 bg-white p-3 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder="הודעה לסוכן…"
            aria-label="הודעה לסוכן"
            rows={2}
            disabled={sending}
            dir="auto"
            className="field flex-1 resize-none"
          />
          <button
            type="button"
            onClick={send}
            disabled={sending || draft.trim().length === 0}
            className="btn-primary shrink-0"
          >
            <Send size={16} aria-hidden="true" className="-scale-x-100" /> שליחה
          </button>
        </div>
        <div className="hidden sm:block text-[12px] text-surface-400 mt-1.5">Enter לשליחה · Shift+Enter לשורה חדשה</div>
      </footer>
    </section>
  )
}

function ChatBubble({ m }: { m: ChatRow }) {
  if (m.role === 'system') {
    return (
      <div className="flex items-center gap-3 text-[12px] text-surface-400">
        <span className="h-px flex-1 bg-surface-200" aria-hidden="true" />
        <span className="shrink-0" dir="auto">{m.content}</span>
        <span className="h-px flex-1 bg-surface-200" aria-hidden="true" />
      </div>
    )
  }
  if (m.role === 'tool') {
    let parsed: unknown = m.content
    try { parsed = JSON.parse(m.content) } catch { /* leave as string */ }
    return (
      <details className="text-[12.5px] max-w-[85%]">
        <summary className="inline-flex items-center gap-1.5 min-h-8 px-2 -mx-2 rounded-lg text-surface-500 hover:text-surface-800">
          <ChevronLeft size={14} aria-hidden="true" className="chev" />
          <Wrench size={14} aria-hidden="true" /> תוצאת כלי
        </summary>
        <pre className="code mt-1">
{JSON.stringify(parsed, null, 2)}
        </pre>
      </details>
    )
  }
  const isUser = m.role === 'user'
  // User and agent are told apart by side and a quiet surface step: the
  // agent speaks on white with a hairline, the user's own lines sit on the
  // sunken tone at the far side. No brand fill.
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] lg:max-w-[78%] rounded-[10px] px-3.5 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap break-words ${
          isUser ? 'bg-surface-100 text-surface-900' : 'bg-white border border-surface-200 text-surface-900'
        }`}
      >
        {m.content && <div dir="auto">{m.content}</div>}
        {Array.isArray(m.tool_calls) && m.tool_calls.length > 0 && (
          <div className={`flex flex-wrap gap-1 ${m.content ? 'mt-2' : ''}`}>
            {m.tool_calls.map(tc => (
              <span
                key={tc.id}
                className="tag font-mono font-medium text-[11.5px]"
                title={JSON.stringify(tc.input)}
                dir="ltr"
              >
                <Wrench size={12} aria-hidden="true" /> {tc.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
