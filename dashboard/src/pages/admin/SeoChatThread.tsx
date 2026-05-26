import { useEffect, useRef, useState } from 'react'
import { Send, Wrench, Loader2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'

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
}

export default function SeoChatThread({ sessionId }: Props) {
  const [messages, setMessages] = useState<ChatRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [draft, setDraft]       = useState('')
  const [sending, setSending]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages.length, sending])

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
      if (invokeErr) throw invokeErr
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
    // itself (also gets min-h-0). This is the standard "flex children
    // don't respect parent overflow without min-h-0" trap.
    <section className="h-full flex flex-col bg-surface-50 min-h-0">
      <header className="h-10 px-3 flex items-center justify-between border-b border-surface-200 bg-white shrink-0">
        <h2 className="text-sm font-semibold text-surface-800">Chat</h2>
        <span className="text-[10px] font-mono text-surface-400" title="session id">{sessionId.slice(0, 8)}</span>
      </header>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="text-xs text-surface-500">Loading…</div>
        ) : messages.length === 0 ? (
          <div className="text-xs text-surface-500">
            Start typing below. Try: "what's pending?" or "queue an article about V60 brewing for beginners".
          </div>
        ) : (
          messages.map(m => <ChatBubble key={m.id} m={m} />)
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
