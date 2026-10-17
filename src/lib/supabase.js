import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables!');
}

/**
 * Module-level Clerk token getter.
 * Set once on app boot via setClerkTokenGetter(getToken) so the fetch
 * wrapper below can inject a fresh JWT on every Supabase request.
 *
 * Clerk issues JWTs via `getToken({ template: 'supabase' })` (configured in
 * the Clerk dashboard as a JWT template). That JWT's `sub` claim is the
 * Clerk user_id, which is what Supabase's RLS policies key off of via
 * `auth.jwt() ->> 'sub'` (see public.is_admin(), get_role_for_user, etc.).
 */
let _getClerkToken = null;

export const setClerkTokenGetter = (fn) => {
  const wasSet = _getClerkToken != null;
  _getClerkToken = fn;
  // Realtime took its first token when the client was created, before sign-in.
  // Re-auth it as soon as a getter exists rather than at the next heartbeat.
  if (!wasSet && fn) {
    supabase.realtime.setAuth().catch((e) => console.warn('[supabase] realtime auth refresh failed:', e));
  }
};

/**
 * The client's `accessToken` option, not a custom fetch: it covers REST,
 * functions and storage AND realtime. Realtime keeps its own websocket and
 * never goes through fetch, so with a fetch wrapper every useSupabaseData
 * subscription joined as anon — and would go silent once anon loses access to
 * the staff tables. Realtime re-reads this on every heartbeat.
 *
 * With no token (signed out, template missing) it returns the anon key, which
 * is exactly how requests went out before a token existed.
 */
async function currentToken() {
  if (_getClerkToken) {
    try {
      const token = await _getClerkToken();
      if (token) return token;
    } catch (err) {
      console.warn('[supabase] Clerk token fetch failed, falling back to anon:', err?.message);
    }
  }
  return supabaseAnonKey;
}

/**
 * Supabase client using the anon key + the Clerk JWT on every request,
 * realtime included. Security is enforced by RLS policies that read
 * `auth.jwt() ->> 'sub'`. Clerk is the sole auth provider.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  accessToken: currentToken,
});

