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
  _getClerkToken = fn;
};

/**
 * Custom fetch that injects the current Clerk JWT on every Supabase request.
 *
 * Without this, every request goes out with just the anon key, `auth.jwt()`
 * is NULL server-side, and all admin-gated RLS policies silently reject —
 * e.g. is_admin() returns false even for a user whose `user_roles` row has
 * role='admin'. That's the bug that broke employee approval, schedule
 * publishing, and anything else behind public.is_admin().
 *
 * We always send the anon key as `apikey` (required by PostgREST's role
 * resolution). If a Clerk token is available, we replace the default
 * anon-key Authorization with the Clerk JWT so Supabase can parse
 * `auth.jwt()->>'sub'` server-side.
 */
async function fetchWithClerkAuth(input, init = {}) {
  const headers = new Headers(init.headers || {});
  // apikey header is what PostgREST uses to resolve the role (anon).
  // Don't remove it — it's separate from Authorization.
  if (!headers.has('apikey')) headers.set('apikey', supabaseAnonKey);

  if (_getClerkToken) {
    try {
      const token = await _getClerkToken();
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
    } catch (err) {
      // If token fetch fails (e.g. user logged out), fall back to anon —
      // most reads still work; admin writes will be rejected and surface.
      console.warn('[supabase] Clerk token fetch failed, falling back to anon:', err?.message);
    }
  }

  return fetch(input, { ...init, headers });
}

/**
 * Supabase client using the anon key + Clerk JWT injected on every request.
 * Security is enforced by RLS policies that read `auth.jwt() ->> 'sub'`.
 * Clerk is the sole auth provider — Supabase's own session is disabled.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: {
    fetch: fetchWithClerkAuth,
  },
});

// Legacy export kept for backwards compat — no longer used.
export const getCurrentUserId = (user) => (user ? user.id : null);
