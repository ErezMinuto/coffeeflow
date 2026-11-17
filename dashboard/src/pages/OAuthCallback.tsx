import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { consumeOAuthState } from '../lib/utils'
import { AlertCircle, ArrowRight, Check, Loader2 } from 'lucide-react'

type Status = 'loading' | 'success' | 'error'

export function MetaCallback() {
  return <OAuthCallback platform="meta" edgeFunction="meta-exchange-token" />
}

export function GoogleCallback() {
  return <OAuthCallback platform="google" edgeFunction="google-exchange-token" />
}

function OAuthCallback({ platform, edgeFunction }: { platform: string, edgeFunction: string }) {
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState('')
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const started = useRef(false)

  useEffect(() => {
    // StrictMode runs effects twice in dev; the state is single-use, so only the first run may check it.
    if (started.current) return
    started.current = true

    const code = searchParams.get('code')
    const err = searchParams.get('error')

    if (err || !code) {
      setError(err || 'No authorization code received')
      setStatus('error')
      return
    }

    if (!consumeOAuthState(platform, searchParams.get('state'))) {
      setError('OAuth state mismatch: start the connection again from Settings')
      setStatus('error')
      return
    }

    exchangeToken(code)
  }, [])

  async function exchangeToken(code: string) {
    try {
      const { error } = await supabase.functions.invoke(edgeFunction, {
        body: {
          code,
          redirect_uri: `${window.location.origin}/auth/${platform}/callback`,
        }
      })

      if (error) throw error
      setStatus('success')
      setTimeout(() => navigate('/settings'), 1500)
    } catch (e: any) {
      setError(e.message || 'Token exchange failed')
      setStatus('error')
    }
  }

  const name = platform === 'meta' ? 'Meta' : platform === 'google' ? 'Google' : platform

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 px-4 py-10 bg-[#F7F6F2]" dir="rtl">
      <img src="/logo.png" alt="Minuto" className="h-[72px] w-auto object-contain" />
      <div className="w-full max-w-sm bg-white border border-surface-200 rounded-[10px] px-6 py-7 text-center" role="status" aria-live="polite">
        {status === 'loading' && (
          <>
            <StatusMark tone="neutral"><Loader2 size={20} aria-hidden="true" className="animate-spin" /></StatusMark>
            <h1 className="text-[17px] text-surface-900">מתחבר ל-{name}…</h1>
            <p className="text-sm text-surface-500 mt-1.5">זה לוקח רק כמה שניות.</p>
          </>
        )}
        {status === 'success' && (
          <>
            <StatusMark tone="ok"><Check size={20} aria-hidden="true" /></StatusMark>
            <h1 className="text-[17px] text-surface-900">{name} מחובר</h1>
            <p className="text-sm text-surface-500 mt-1.5">חוזרים להגדרות…</p>
          </>
        )}
        {status === 'error' && (
          <>
            <StatusMark tone="danger"><AlertCircle size={20} aria-hidden="true" /></StatusMark>
            <h1 className="text-[17px] text-surface-900">החיבור ל-{name} לא הצליח</h1>
            <p className="text-sm text-surface-500 mt-1.5">אפשר לחזור להגדרות ולנסות שוב.</p>
            {error && (
              <p dir="ltr" className="mt-4 px-3 py-2 rounded-lg bg-surface-50 border border-surface-200 text-surface-700 font-mono text-xs text-left break-words">{error}</p>
            )}
            <button onClick={() => navigate('/settings')} className="btn-secondary mt-5">
              <ArrowRight size={16} aria-hidden="true" />
              חזרה להגדרות
            </button>
          </>
        )}
      </div>
    </div>
  )
}

const MARK_TONE = {
  neutral: 'bg-surface-100 text-surface-600',
  ok:      'bg-[#EEF3E8] text-[#3F6B2A]',
  danger:  'bg-[#FDF1EF] text-[#B42318]',
} as const

function StatusMark({ tone, children }: { tone: keyof typeof MARK_TONE; children: React.ReactNode }) {
  return <span className={`grid place-items-center w-10 h-10 mx-auto mb-4 rounded-full ${MARK_TONE[tone]}`}>{children}</span>
}
