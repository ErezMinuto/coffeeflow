import { useState, useRef, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Send, Loader2, Megaphone, Sparkles, ExternalLink, CheckCircle2 } from 'lucide-react'

interface ToolCall { name: string; input: any; result: any }
interface Msg { role: 'user' | 'assistant'; content: string; tools?: ToolCall[] }

const STORAGE_KEY = 'marketing_brain_chat'

// Renders the outcome of a tool the brain fired (paid draft / organic queue).
function ToolChip({ t }: { t: ToolCall }) {
  const r = t.result
  if (t.name === 'draft_meta_campaign' && r?.ok && r?.edit_url) {
    return (
      <a href={r.edit_url} target="_blank" rel="noopener noreferrer"
         className="mt-2 inline-flex items-center gap-1.5 badge bg-white text-brand-700 border border-brand-100">
        <Megaphone size={12} /> טיוטה מושהית · פתח ב-Ads Manager <ExternalLink size={11} />
      </a>
    )
  }
  if (t.name === 'queue_organic_task') {
    return (
      <span className="mt-2 inline-flex items-center gap-1.5 badge bg-white text-emerald-700 border border-emerald-100">
        <CheckCircle2 size={12} /> משימה אורגנית נשלחה לסוכן ה-SEO
      </span>
    )
  }
  return null
}

export function BrainChat() {
  const [messages, setMessages] = useState<Msg[]>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') } catch { return [] }
  })
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
    } catch (e: any) {
      setMessages((m) => [...m, { role: 'assistant', content: `⚠ ${e?.message ?? 'שגיאה'}` }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-[72vh] bg-white border border-surface-200 rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-surface-100 flex items-center gap-2 flex-wrap">
        <Sparkles size={16} className="text-brand-500" />
        <h3 className="font-display font-semibold text-surface-900">מוח שיווקי</h3>
        <span className="text-xs text-surface-400">אורגני + ממומן · מבוסס נתונים · מאשר לפני שמבצע</span>
        {messages.length > 0 && (
          <button onClick={() => setMessages([])} className="ms-auto text-xs text-surface-400 hover:text-surface-700 cursor-pointer">נקה שיחה</button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-surface-400 text-sm mt-10 leading-relaxed">
            דברו עם המוח השיווקי.<br />
            לדוגמה: "מה הכי משתלם לעשות השבוע?" · "תבנה קמפיין ריטרגטינג" · "queue מחקר על ברזיל"
            <div className="mt-3 text-xs text-surface-300">שום דבר לא מתפרסם או מוציא כסף בלי אישור מפורש שלכם.</div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${
              m.role === 'user' ? 'bg-surface-100 text-surface-800' : 'bg-brand-50 text-surface-900'
            }`}>
              {m.content}
              {m.tools?.map((t, j) => <ToolChip key={j} t={t} />)}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-end">
            <div className="bg-brand-50 rounded-2xl px-4 py-2.5"><Loader2 size={16} className="animate-spin text-brand-500" /></div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="p-3 border-t border-surface-100">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            placeholder="שאלו את המוח השיווקי…"
            rows={1}
            disabled={loading}
            className="flex-1 resize-none overflow-y-auto border border-surface-200 rounded-xl px-3 py-2 text-sm leading-relaxed focus:border-brand-400 focus:outline-none disabled:opacity-60"
          />
          <button onClick={send} disabled={loading || !input.trim()}
            className="px-4 py-2 rounded-xl bg-brand-600 text-white hover:bg-brand-700 transition-colors disabled:opacity-50 cursor-pointer">
            <Send size={16} />
          </button>
        </div>
        <div className="text-[10px] text-surface-400 mt-1">Enter לשליחה · Shift+Enter לשורה חדשה</div>
      </div>
    </div>
  )
}
