import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const body = await req.json()
    const { code, redirect_uri } = body

    const appId = Deno.env.get('META_APP_ID')!
    const appSecret = Deno.env.get('META_APP_SECRET')!

    console.log(`Exchanging code with app_id=${appId} redirect_uri=${redirect_uri}`)

    const params = new URLSearchParams({ client_id: appId, client_secret: appSecret, redirect_uri, code })
    const res = await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?${params}`)
    const data = await res.json()

    console.log('FB token response:', JSON.stringify(data))

    if (data.error) {
      throw new Error(`Facebook: ${data.error.message} [code ${data.error.code}]`)
    }

    // Exchange for long-lived token (60 days)
    const longParams = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: data.access_token,
    })
    const longRes = await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?${longParams}`)
    const longData = await longRes.json()

    console.log('Long-lived token response:', JSON.stringify(longData))

    if (longData.error) {
      throw new Error(`Facebook long-lived: ${longData.error.message} [code ${longData.error.code}]`)
    }

    const accessToken = longData.access_token || data.access_token
    const expiresAt = longData.expires_in
      ? new Date(Date.now() + longData.expires_in * 1000).toISOString()
      : null

    const meRes = await fetch(`https://graph.facebook.com/v18.0/me?fields=name&access_token=${accessToken}`)
    const me = await meRes.json()

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    await supabase.from('oauth_tokens').upsert({
      platform: 'meta',
      access_token: accessToken,
      expires_at: expiresAt,
      account_name: me.name,
    }, { onConflict: 'platform' })

    return new Response(JSON.stringify({ success: true, account: me.name }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (err) {
    console.error('meta-exchange-token error:', err.message)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
