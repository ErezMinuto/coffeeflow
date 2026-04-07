import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

async function refreshGoogleToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: Deno.env.get('GOOGLE_CLIENT_ID')!,
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET')!,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json()
  if (data.error) throw new Error(`Token refresh failed: ${data.error_description || data.error}`)
  return data.access_token
}

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const startedAt = new Date().toISOString()
  let records = 0

  try {
    const devToken = Deno.env.get('GOOGLE_DEVELOPER_TOKEN')
    if (!devToken) throw new Error('GOOGLE_DEVELOPER_TOKEN not set')

    const { data: tokenRow } = await supabase
      .from('oauth_tokens')
      .select('*')
      .eq('platform', 'google')
      .single()

    if (!tokenRow) throw new Error('Google not connected')

    const accessToken = await refreshGoogleToken(tokenRow.refresh_token)
    await supabase.from('oauth_tokens').update({
      access_token: accessToken,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    }).eq('platform', 'google')

    const rawCustomerId = Deno.env.get('GOOGLE_CUSTOMER_ID')!
    const customerId = rawCustomerId.replace(/-/g, '')

    const today = new Date().toISOString().split('T')[0]
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

    const query = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.ctr,
        metrics.average_cpc,
        metrics.conversions,
        metrics.conversions_value,
        segments.date
      FROM campaign
      WHERE segments.date BETWEEN '${monthAgo}' AND '${today}'
        AND campaign.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 200
    `

    const url = `https://googleads.googleapis.com/v20/customers/${customerId}/googleAds:search`

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': devToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    })

    const rawText = await res.text()
    let data
    try {
      data = JSON.parse(rawText)
    } catch {
      throw new Error(`API returned non-JSON (${res.status}): ${rawText.substring(0, 200)}`)
    }

    if (data.error) throw new Error(JSON.stringify(data.error))

    for (const row of data.results || []) {
      const cost = (row.metrics.costMicros || 0) / 1_000_000
      const conversions = row.metrics.conversions || 0
      const convValue = row.metrics.conversionsValue || 0
      const roas = cost > 0 ? convValue / cost : 0

      await supabase.from('google_campaigns').upsert({
        campaign_id: row.campaign.id,
        date: row.segments.date,
        name: row.campaign.name,
        status: row.campaign.status,
        impressions: row.metrics.impressions || 0,
        clicks: row.metrics.clicks || 0,
        cost,
        ctr: row.metrics.ctr || 0,
        cpc: (row.metrics.averageCpc || 0) / 1_000_000,
        conversions,
        conversion_value: convValue,
        roas,
      }, { onConflict: 'campaign_id,date' })

      records++
    }

    await supabase.from('sync_log').insert({
      platform: 'google',
      status: 'success',
      records,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })

    return new Response(JSON.stringify({ success: true, records }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error('Google sync error:', err.message)
    await supabase.from('sync_log').insert({
      platform: 'google',
      status: 'error',
      error_msg: err.message,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    })

    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
