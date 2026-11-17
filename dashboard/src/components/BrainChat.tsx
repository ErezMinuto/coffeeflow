import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useApp } from '../lib/context'
import { Send, Loader2, ExternalLink, CheckCircle2, AlertCircle } from 'lucide-react'

interface ToolCall { name: string; input: any; result: any }
interface Msg { role: 'user' | 'assistant'; content: string; tools?: ToolCall[] }

const STORAGE_KEY = 'marketing_brain_chat'

// Result chips: white, hairline, a small tone marker (channel dot or a green check).
const CHIP = 'mt-2 me-2 inline-flex items-center gap-1.5 min-h-8 px-2.5 py-1 rounded-md border border-surface-200 bg-white text-[12.5px] font-medium text-surface-700 text-right'
const CHIP_LINK = `${CHIP} transition-[background-color,transform] duration-150 active:scale-[0.97] [@media(hover:hover)]:hover:bg-surface-50 [@media(hover:hover)]:hover:text-surface-900`

// Renders the outcome of a tool the brain fired (Meta draft / Google draft /
// organic queue). Read-only tools render nothing — their result is already in
// the brain's own reply.
function ToolChip({ t }: { t: ToolCall }) {
  const r = t.result
  if (t.name === 'draft_meta_campaign' && r?.ok && r?.edit_url) {
    return (
      <a href={r.edit_url} target="_blank" rel="noopener noreferrer" className={CHIP_LINK}>
        <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-[var(--meta)] shrink-0" />
        טיוטה מושהית ב-Meta · פתיחה ב-Ads Manager <ExternalLink size={13} aria-hidden="true" className="text-surface-400 shrink-0" />
      </a>
    )
  }
  // validate_only runs return ok without a campaign — Google checked the spec
  // and built nothing, so there is no link to offer.
  if (t.name === 'draft_google_campaign' && r?.ok && r?.edit_url) {
    return (
      <a href={r.edit_url} target="_blank" rel="noopener noreferrer" className={CHIP_LINK}>
        <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-[var(--google)] shrink-0" />
        קמפיין Google מושהה · פתיחה ב-Google Ads <ExternalLink size={13} aria-hidden="true" className="text-surface-400 shrink-0" />
      </a>
    )
  }
  if (t.name === 'draft_google_campaign' && r?.ok && r?.validate_only) {
    return (
      <span className={CHIP}>
        <CheckCircle2 size={14} aria-hidden="true" className="text-ok shrink-0" /> Google אישרה את המפרט · לא נוצר כלום
      </span>
    )
  }
  // delegate_to_agent: an email draft made from finished copy, or a piece
  // queued straight to the email / blog / IG agent. Links stay in-app.
  if (t.name === 'delegate_to_agent' && r?.ok && r?.link) {
    const agentLabel: Record<string, string> = { email: 'סוכן המייל', blog: 'כותב הבלוג', instagram: 'סוכן האינסטגרם' }
    const label = r.kind === 'email_draft'
      ? 'טיוטת מייל נוצרה · לא נשלחה · פתיחה בהיסטוריה'
      : `נשלח ל${agentLabel[r.agent] ?? 'סוכן'} · הטיוטה תגיע בעוד כמה דקות`
    return (
      <Link to={r.link} className={CHIP_LINK}>
        <CheckCircle2 size={14} aria-hidden="true" className="text-ok shrink-0" /> {label}
      </Link>
    )
  }
  if (t.name === 'queue_organic_task') {
    return (
      <span className={CHIP}>
        <CheckCircle2 size={14} aria-hidden="true" className="text-ok shrink-0" /> משימה אורגנית נשלחה לסוכן ה-SEO
      </span>
    )
  }
  return null
}

// Starters for an empty conversation. Tapping one fills the composer; nothing
// is sent until the person presses send.
const STARTERS = ['מה הכי משתלם לעשות השבוע?', 'בניית קמפיין ריטרגטינג', 'מחקר על פולי ברזיל לתור של הסוכנים']

// send() stores a failure as "⚠ <message>"; those render as an error line.
const ERR_PREFIX = '⚠ '

export function BrainChat() {
  const [messages, setMessages] = useState<Msg[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
  })
  const { campaignsDb } = useApp()
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, loading])
  // grow the composer with its content (up to ~6 lines) instead of scrolling a single line
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [input])
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40))) }, [messages])

  async function send() {
    const q = input.trim()
    if (!q || loading) return
    const history = messages.map((m) => ({ role: m.role, content: m.content }))
    setMessages((m) => [...m, { role: 'user', content: q }])
    setInput(''); setLoading(true)
    try {
      const { data, error } = await supabase.functions.invoke('marketing-advisor', {
        body: { agent: 'meta_ads_strategist', question: q, history },
      })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'הבקשה נכשלה')
      setMessages((m) => [...m, { role: 'assistant', content: data.answer || '', tools: data.tool_calls || [] }])
      // The campaigns list is loaded once per session: refresh it so a draft the
      // brain just made is there when the chip opens Marketing → History.
      if ((data.tool_calls || []).some((t: ToolCall) => t.name === 'delegate_to_agent' && t.result?.kind === 'email_draft')) {
        campaignsDb.refresh().catch(() => {})
      }
    } catch (e: any) {
      setMessages((m) => [...m, { role: 'assistant', content: `⚠ ${e?.message ?? 'שגיאה'}` }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <section aria-labelledby="brain-title" className="fade-up flex flex-col h-[70dvh] min-h-[440px] card-flush overflow-hidden">
      <div className="flex items-center gap-3 min-h-[52px] px-[18px] py-2 border-b border-surface-200">
        <div className="min-w-0">
          <h2 id="brain-title" className="text-[15px] font-semibold text-surface-900">מוח שיווקי</h2>
          <p className="text-[12.5px] text-surface-500">אורגני וממומן, על בסיס הנתונים. מבקש אישור לפני כל ביצוע.</p>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => setMessages([])}
            className="btn-ghost ms-auto shrink-0 h-8 px-2.5 text-[13px] text-surface-600"
          >
            ניקוי השיחה
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-5 lg:px-6 space-y-4">
        {messages.length === 0 && (
          <div className="max-w-sm mx-auto mt-6 text-center">
            <p className="text-[15px] font-medium text-surface-900">על מה עובדים השבוע?</p>
            <p className="text-[13px] text-surface-500 mt-1">שאלה, רעיון לקמפיין או משימה לסוכנים.</p>
            <div className="mt-4 flex flex-col gap-2">
              {STARTERS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => { setInput(q); inputRef.current?.focus() }}
                  className="min-h-10 px-3 rounded-lg border border-surface-200 text-sm text-surface-700 transition-[background-color,border-color,transform] duration-150 active:scale-[0.97] [@media(hover:hover)]:hover:bg-surface-50 [@media(hover:hover)]:hover:border-surface-300 cursor-pointer"
                >
                  {q}
                </button>
              ))}
            </div>
            <p className="mt-4 text-[12.5px] text-surface-400">שום דבר לא מתפרסם ולא מוציא כסף בלי אישור מפורש.</p>
          </div>
        )}
        {messages.map((m, i) => {
          const failed = m.role === 'assistant' && m.content.startsWith(ERR_PREFIX)
          return (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}`}>
              {failed ? (
                <div className="notice notice-danger max-w-[85%] w-auto text-[13px]">
                  <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
                  <span><span className="font-medium">הבקשה נכשלה.</span> <span dir="auto" className="break-words">{m.content.slice(ERR_PREFIX.length)}</span></span>
                </div>
              ) : (
                <div className={`max-w-[85%] rounded-[10px] px-4 py-2.5 text-sm whitespace-pre-wrap break-words leading-relaxed text-surface-900 ${
                  m.role === 'user' ? 'bg-surface-100' : 'bg-white border border-surface-200'
                }`}>
                  {m.content}
                  {m.tools && m.tools.length > 0 && (
                    <div className="whitespace-normal">{m.tools.map((t, j) => <ToolChip key={j} t={t} />)}</div>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {loading && (
          <div className="flex justify-end" role="status">
            <div className="inline-flex items-center gap-2 rounded-[10px] border border-surface-200 px-3.5 py-2.5 text-[13px] text-surface-500">
              <Loader2 size={15} aria-hidden="true" className="animate-spin" />
              עובד על תשובה…
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="p-3 border-t border-surface-200">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            placeholder="שאלה או בקשה למוח השיווקי…"
            aria-label="הודעה למוח השיווקי"
            rows={1}
            disabled={loading}
            className="field flex-1 resize-none overflow-y-auto py-[7px] leading-relaxed"
          />
          <button
            type="button"
            onClick={send}
            disabled={loading || !input.trim()}
            aria-label="שליחה"
            className="btn-primary w-[38px] px-0 shrink-0"
          >
            <Send size={16} aria-hidden="true" className="-scale-x-100" />
          </button>
        </div>
        <p className="hidden lg:block text-[12px] text-surface-400 mt-1.5">Enter לשליחה · Shift+Enter לשורה חדשה</p>
      </div>
    </section>
  )
}
