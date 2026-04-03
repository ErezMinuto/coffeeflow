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
 * Custom fetch that injects the current Clerk JWT as Authorization header.
 * Supabase verifies the JWT with the shared JWT secret → user is `authenticated`
 * → RLS policies read auth.jwt() ->> 'sub' to identify the user.
 */
const clerkFetch = async (input, init = {}) => {
  if (_getClerkToken) {
    try {
      const token = await _getClerkToken({ template: 'supabase' });
      if (token) {
        init.headers = {
          ...init.headers,
          Authorization: `Bearer ${token}`,
        };
      }
    } catch (_) {
      // If token fetch fails, fall back to anon key (request continues)
    }
  }
  return fetch(input, init);
};

/**
 * Supabase client with Clerk JWT injected on every request.
 * Clerk is the sole auth provider — Supabase's own session management is disabled.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: { fetch: clerkFetch },
});

// Legacy export kept for backwards compat — no longer used.
export const getCurrentUserId = (user) => (user ? user.id : null);
