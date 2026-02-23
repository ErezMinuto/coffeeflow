import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables!');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  }
});

// Helper function to set Supabase JWT from Clerk
export const setSupabaseToken = async (getToken) => {
  try {
    const token = await getToken({ template: 'supabase' });
    
    if (token) {
      const { data, error } = await supabase.auth.setSession({
        access_token: token,
        refresh_token: 'placeholder' // Clerk handles refresh
      });
      
      if (error) {
        console.error('Error setting Supabase session:', error);
      }
      
      return data;
    }
  } catch (error) {
    console.error('Error getting Clerk token:', error);
  }
};

// Get current user ID
export const getCurrentUserId = async (user) => {
  if (!user) return null;
  return user.id;
};
