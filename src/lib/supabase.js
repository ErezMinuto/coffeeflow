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
 * Supabase client using the anon key.
 * Security is enforced by RLS policies that require the anon key to be present.
 * Clerk is the sole auth provider — Supabase's own session management is disabled.
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
