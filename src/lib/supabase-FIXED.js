import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables!');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  }
});

// Helper function to set Supabase JWT from Clerk
export const setSupabaseToken = async (getToken) => {
  try {
    const token = await getToken({ template: 'supabase' });
    
    if (token) {
      // Set the access token for all future requests
      supabase.realtime.setAuth(token);
      
      // Also set it in the headers for REST requests
      supabase.rest.headers['Authorization'] = `Bearer ${token}`;
      
      console.log('✅ Supabase token set successfully');
      return token;
    } else {
      console.error('❌ No token received from Clerk');
    }
  } catch (error) {
    console.error('❌ Error setting Supabase token:', error);
  }
};

// Get current user ID from Clerk
export const getCurrentUserId = (user) => {
  if (!user) return null;
  return user.id;
};
