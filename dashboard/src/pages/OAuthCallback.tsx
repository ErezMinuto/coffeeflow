import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Loader2, CheckCircle, XCircle } from 'lucide-react'

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

  useEffect(() => {
    const code = searchParams.get('code')
    const err = searchParams.get('error')

    if (err || !code) {
      setError(err || 'No authorization code received')
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-50">
      <div className="card text-center max-w-sm w-full">
        {status === 'loading' && (
          <>
            <Loader2 className="animate-spin mx-auto text-brand-500 mb-4" size={32} />
            <h3 className="font-display font-semibold text-surface-900">מתחבר ל-{platform}...</h3>
            <p className="text-sm text-surface-400 mt-2">אנא המתן</p>
          </>
        )}
        {status === 'success' && (
          <>
            <CheckCircle className="mx-auto text-green-500 mb-4" size={32} />
            <h3 className="font-display font-semibold text-surface-900">החיבור הצליח!</h3>
            <p className="text-sm text-surface-400 mt-2">מועבר להגדרות...</p>
          </>
        )}
        {status === 'error' && (
          <>
            <XCircle className="mx-auto text-red-500 mb-4" size={32} />
            <h3 className="font-display font-semibold text-surface-900">שגיאה בחיבור</h3>
            <p className="text-sm text-red-500 mt-2 font-mono text-xs">{error}</p>
            <button onClick={() => navigate('/settings')} className="btn-secondary mt-4">
              חזור להגדרות
            </button>
          </>
        )}
      </div>
    </div>
  )
}
