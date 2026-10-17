import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables')
}

// Clerk token getter, set by AuthGate once the user is signed in. Mirrors the
// main app (src/lib/supabase.js): every Supabase request carries the signed-in
// user's Clerk JWT from the `supabase` JWT template, so the database sees
// role=authenticated and auth.jwt()->>'sub' = their Clerk user_id instead of a
// bare anon key. That is what lets anon access be removed from tables later
// without locking the dashboard out.
let getClerkToken: (() => Promise<string | null>) | null = null

export function setClerkTokenGetter(fn: (() => Promise<string | null>) | null): void {
  getClerkToken = fn
}

async function fetchWithClerkAuth(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  // apikey stays the anon key: it identifies the project to the gateway and is
  // separate from Authorization.
  if (!headers.has('apikey')) headers.set('apikey', supabaseAnonKey)
  if (getClerkToken) {
    try {
      const token = await getClerkToken()
      if (token) headers.set('Authorization', `Bearer ${token}`)
    } catch (err) {
      // No token (signed out, template missing): fall back to the anon key,
      // which is how every request went out before this change.
      console.warn('[supabase] Clerk token unavailable, falling back to anon:', (err as Error)?.message)
    }
  }
  return fetch(input, { ...init, headers })
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: { fetch: fetchWithClerkAuth },
})
