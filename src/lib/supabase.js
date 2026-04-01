import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables!');
}

/**
 * Module-level Clerk token getter.
 * Set once on app boot via setClerkTokenGetter(getToken) so the fetch
 * interceptor below can inject a fresh JWT on every Supabase request.
 */
let _getClerkToken = null;

export const setClerkTokenGetter = (fn) => {
  _getClerkToken = fn;
};

/**
 * Supabase client with a custom fetch interceptor.
 *
 * Every request automatically carries the current Clerk JWT as the
 * Authorization header.  Supabase verifies the JWT with the shared
 * JWT secret and sets auth.jwt() → RLS policies read auth.jwt() ->> 'sub'
 * to identify the user.
 *
 * We disable Supabase's own auth session management entirely — Clerk is
 * the sole auth provider.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: {
    fetch: async (url, options = {}) => {
      if (_getClerkToken) {
        try {
          const token = await _getClerkToken({ template: 'supabase' });
          if (token) {
            // Supabase v2 passes headers as a Headers instance, not a plain
            // object.  Spreading a Headers instance yields {} so we must use
            // the Headers API to preserve the existing apikey header while
            // injecting our Clerk JWT.
            const headers = new Headers(options.headers || {});
            headers.set('Authorization', `Bearer ${token}`);
            options = { ...options, headers };
          }
        } catch (e) {
          // Token fetch failed (e.g. user signed out mid-request) — fall
          // through with no Authorization header; RLS will block access.
          console.warn('[supabase] Could not get Clerk token:', e?.message);
        }
      }
      return fetch(url, options);
    },
  },
});

// Legacy export kept for backwards compat — no longer used.
export const getCurrentUserId = (user) => (user ? user.id : null);
