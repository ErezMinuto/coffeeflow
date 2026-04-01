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
});

// Legacy export kept for backwards compat — no longer used.
export const getCurrentUserId = (user) => (user ? user.id : null);
