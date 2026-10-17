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
// bare anon key. Tables can then be limited to admins (is_admin()) without
// locking the dashboard out.
let getClerkToken: (() => Promise<string | null>) | null = null

// The client's `accessToken` option, rather than a custom fetch: it covers
// REST, functions and storage AND realtime. Realtime keeps its own socket and
// never goes through fetch, so with a fetch wrapper its subscriptions stayed
// anon — and would go silent once anon lost access to the tables. Realtime
// calls this again on every heartbeat, so the token stays fresh.
async function currentToken(): Promise<string> {
  if (getClerkToken) {
    try {
      const token = await getClerkToken()
      if (token) return token
    } catch (err) {
      console.warn('[supabase] Clerk token unavailable, falling back to anon:', (err as Error)?.message)
    }
  }
  // Signed out or no template: the anon key, exactly as before.
  return supabaseAnonKey
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  accessToken: currentToken,
})

export function setClerkTokenGetter(fn: (() => Promise<string | null>) | null): void {
  const wasSignedIn = getClerkToken != null
  getClerkToken = fn
  // Realtime took its first token when the client was created, before anyone
  // signed in. Hand it the user's token now rather than waiting for the next
  // heartbeat. Only on sign-in / sign-out: AuthGate calls this every render.
  if ((fn != null) !== wasSignedIn) {
    supabase.realtime.setAuth().catch((e) => console.warn('[supabase] realtime auth refresh failed:', e))
  }
}
