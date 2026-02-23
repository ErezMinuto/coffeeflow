import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.REACT_APP_SUPABASE_URL;
const supabaseAnonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables!');
}

// Create supabase client with custom headers function
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  },
  global: {
    headers: {}
  }
});

// Store the token globally
let clerkToken = null;

// Helper function to set Supabase JWT from Clerk
export const setSupabaseToken = async (getToken) => {
  try {
    const token = await getToken({ template: 'supabase' });
    
    if (token) {
      clerkToken = token;
      
      // Override the headers for all requests
      supabase.rest.headers = {
        ...supabase.rest.headers,
        'Authorization': `Bearer ${token}`
      };
      
      console.log('✅ Supabase token set:', token.substring(0, 50) + '...');
      return token;
    } else {
      console.error('❌ No token received from Clerk');
    }
  } catch (error) {
    console.error('❌ Error setting Supabase token:', error);
  }
};

// Get current user ID
export const getCurrentUserId = (user) => {
  if (!user) return null;
  return user.id;
};
