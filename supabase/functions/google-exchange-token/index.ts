import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { forbidden, hasRole } from '../_shared/role_caller.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  // verify_jwt is off, so the caller is checked here. Replaces the stored Google token, so only an admin finishing the OAuth
  // flow in the dashboard may call it.
  if (!(await hasRole(req, ['admin']))) return forbidden(corsHeaders)

  try {
    const body = await req.json()
    const { code, redirect_uri } = body

    // Exchange code for tokens
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: Deno.env.get('GOOGLE_CLIENT_ID')!,
        client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET')!,
        redirect_uri,
        grant_type: 'authorization_code',
      }),
    })

    const data = await res.json()
    if (data.error) throw new Error(data.error_description || data.error)

    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()

    // Get user info
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${data.access_token}` },
    })
    const user = await userRes.json()

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    await supabase.from('oauth_tokens').upsert({
      platform: 'google',
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: expiresAt,
      account_name: user.email,
    }, { onConflict: 'platform' })

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
