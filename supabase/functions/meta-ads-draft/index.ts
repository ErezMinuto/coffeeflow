import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Creates a PAUSED ad campaign in Meta Ads Manager from a build_meta_campaign
// spec. The owner reviews + activates manually in Ads Manager.
//
// API call chain (all status=PAUSED until the owner flips it):
//   1. POST /act_X/campaigns                — campaign shell
//   2. POST /act_X/adsets                   — targeting + budget + optimization
//   3. POST /act_X/adimages    (url=...)    — Meta fetches the image URL
//   4. POST /act_X/adcreatives              — image hash + copy + page/IG IDs
//   5. POST /act_X/ads                      — binds creative to adset
//
// Drafts are recorded in meta_ad_drafts (keyed by idea_id) so re-clicking
// "Build draft" returns the existing campaign instead of creating dupes.
//
// Body: { action: 'dry_run'|'create', idea_id: string, spec: BuildMetaSpec, image_url?: string }
//   dry_run: verifies token+scope+pixel, returns context (no writes)
//   create:  runs the full chain
//
// Returns: { campaign_id, edit_url, warnings: string[] }

const GRAPH = 'https://graph.facebook.com/v23.0'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST')    return json({ error: 'POST only' }, 405)

  try {
    const body = await req.json()
    const action  = body.action as 'dry_run' | 'create'
    const ideaId  = String(body.idea_id ?? '').trim()
    const spec    = body.spec
    const imageUrl = body.image_url as string | undefined

    if (!action) throw new Error("'action' is required (dry_run|create)")
    if (action === 'create' && !ideaId) throw new Error("'idea_id' is required for create")
    if (action === 'create' && (!spec || typeof spec !== 'object')) {
      throw new Error("'spec' object is required for create")
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const ctx = await loadAdsContext(supabase)

    if (action === 'dry_run') {
      return json({
        ok: true,
        ad_account_id: ctx.adAccountId,
        page_id:       ctx.pageId,
        ig_user_id:    ctx.igUserId,
        scopes:        ctx.scopes,
        pixel_id:      ctx.pixelId,
        has_ads_management: ctx.scopes.includes('ads_management'),
      })
    }

    // Dedupe — return existing draft if we already created one for this idea
    const { data: existing } = await supabase
      .from('meta_ad_drafts')
      .select('campaign_id, adset_id, ad_id, creative_id, warnings')
      .eq('idea_id', ideaId)
      .maybeSingle()
    if (existing?.campaign_id) {
      return json({
        ok: true,
        existed: true,
        campaign_id: existing.campaign_id,
        adset_id:    existing.adset_id,
        ad_id:       existing.ad_id,
        creative_id: existing.creative_id,
        edit_url:    adsManagerEditUrl(ctx.adAccountId, existing.campaign_id),
        warnings:    existing.warnings ?? [],
      })
    }

    if (!ctx.scopes.includes('ads_management')) {
      throw new Error("token missing 'ads_management' scope — re-auth Meta with the updated FLB config")
    }

    const warnings: string[] = []

    // ── 1. Campaign ────────────────────────────────────────────────────────
    // CBO (Campaign Budget Optimization) — budget + bid_strategy live on the
    // campaign, not the ad set. Meta's modern default and required for several
    // objectives. Putting budget on the ad set triggers errors about
    // is_adset_budget_sharing_enabled / SOURCE / budget_remaining / etc.
    const objective = mapObjective(spec.objective)
    const dailyBudgetAgorot = String(Math.round(Number(spec.daily_budget_ils ?? 60) * 100))
    const campaign  = await graphPost(`${GRAPH}/${ctx.adAccountId}/campaigns`, ctx.userToken, {
      name:                   String(spec.campaign_name ?? 'Untitled').slice(0, 400),
      objective,
      status:                 'PAUSED',
      special_ad_categories:  JSON.stringify([]),
      buying_type:            'AUCTION',
      daily_budget:           dailyBudgetAgorot,
      bid_strategy:           'LOWEST_COST_WITHOUT_CAP',
    })
    const campaignId = campaign.id

    // ── 2. Ad Set ──────────────────────────────────────────────────────────
    const ageMin = parseAgeMin(spec.audience?.age_range) ?? 18
    const ageMax = parseAgeMax(spec.audience?.age_range) ?? 65

    // Resolve interest names to Targeting IDs. Failures are non-fatal —
    // the ad set still saves with whatever resolved + a warning.
    const interestNames: string[] = Array.isArray(spec.audience?.interests_or_behaviors)
      ? spec.audience.interests_or_behaviors.map((x: any) => String(x)).filter(Boolean)
      : []
    const resolvedInterests: Array<{ id: string; name: string }> = []
    for (const name of interestNames) {
      const r = await resolveInterest(name, ctx.userToken)
      if (r) resolvedInterests.push(r)
      else   warnings.push(`interest not resolved: "${name}"`)
    }

    const targeting: any = {
      geo_locations: { countries: ['IL'] },
      age_min: ageMin,
      age_max: ageMax,
      publisher_platforms:  ['facebook', 'instagram'],
    }
    if (resolvedInterests.length > 0) {
      targeting.flexible_spec = [{ interests: resolvedInterests }]
    }

    const optimizationGoal = pickOptimizationGoal(objective, ctx.pixelId)
    const promotedObject   = (objective === 'OUTCOME_SALES' && ctx.pixelId)
      ? { pixel_id: ctx.pixelId, custom_event_type: 'PURCHASE' }
      : undefined
    if (objective === 'OUTCOME_SALES' && !ctx.pixelId) {
      warnings.push('no Meta Pixel found on ad account — falling back to LINK_CLICKS optimization')
    }

    // Ad set has NO budget/bid_strategy under CBO — those live on the campaign.
    const startTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()  // +24h
    const adsetParams: Record<string, string> = {
      name:               truncate(`${spec.campaign_name} — Ad Set`, 400),
      campaign_id:        campaignId,
      billing_event:      'IMPRESSIONS',
      optimization_goal:  optimizationGoal,
      targeting:          JSON.stringify(targeting),
      status:             'PAUSED',
      start_time:         startTime,
    }
    if (promotedObject) adsetParams.promoted_object = JSON.stringify(promotedObject)

    const adset    = await graphPost(`${GRAPH}/${ctx.adAccountId}/adsets`, ctx.userToken, adsetParams)
    const adsetId  = adset.id

    // ── 3. Image upload ────────────────────────────────────────────────────
    if (!imageUrl) throw new Error("image_url is required — pass a public URL Meta can fetch")
    const imgRes = await graphPost(`${GRAPH}/${ctx.adAccountId}/adimages`, ctx.userToken, {
      url: imageUrl,
    })
    // /adimages response shape: { images: { "<filename>": { hash, url, ... } } }
    const imagesObj = imgRes.images ?? {}
    const firstKey  = Object.keys(imagesObj)[0]
    const imageHash = firstKey ? imagesObj[firstKey].hash : null
    if (!imageHash) throw new Error("image upload did not return a hash — check image_url is public + valid")

    // ── 4. Ad Creative ─────────────────────────────────────────────────────
    const utm = buildUtm(spec.tracking, ideaId)
    const linkWithUtm = appendUtm(spec.landing_page_url, utm)

    const linkData: Record<string, any> = {
      link:       linkWithUtm,
      image_hash: imageHash,
      message:    truncate(String(spec.creative?.primary_text ?? ''), 1500),
    }
    if (spec.creative?.headline)    linkData.name        = truncate(String(spec.creative.headline), 255)
    if (spec.creative?.description) linkData.description = truncate(String(spec.creative.description), 255)
    const ctaType = mapCta(spec.creative?.cta_button)
    if (ctaType) linkData.call_to_action = { type: ctaType, value: { link: linkWithUtm } }

    const creative = await graphPost(`${GRAPH}/${ctx.adAccountId}/adcreatives`, ctx.userToken, {
      name: truncate(`${spec.campaign_name} — Creative`, 400),
      object_story_spec: JSON.stringify({
        page_id:            ctx.pageId,
        instagram_actor_id: ctx.igUserId,
        link_data:          linkData,
      }),
    })
    const creativeId = creative.id

    // ── 5. Ad ──────────────────────────────────────────────────────────────
    const ad = await graphPost(`${GRAPH}/${ctx.adAccountId}/ads`, ctx.userToken, {
      name:     truncate(`${spec.campaign_name} — Ad`, 400),
      adset_id: adsetId,
      creative: JSON.stringify({ creative_id: creativeId }),
      status:   'PAUSED',
    })
    const adId = ad.id

    // ── Persist ────────────────────────────────────────────────────────────
    await supabase.from('meta_ad_drafts').insert({
      idea_id:          ideaId,
      ad_account_id:    ctx.adAccountId,
      campaign_id:      campaignId,
      adset_id:         adsetId,
      ad_id:            adId,
      creative_id:      creativeId,
      campaign_name:    spec.campaign_name,
      objective,
      daily_budget_ils: Number(spec.daily_budget_ils ?? 60),
      spec,
      warnings,
      status:           'PAUSED',
    })

    return json({
      ok: true,
      campaign_id: campaignId,
      adset_id:    adsetId,
      ad_id:       adId,
      creative_id: creativeId,
      edit_url:    adsManagerEditUrl(ctx.adAccountId, campaignId),
      warnings,
    })
  } catch (err: any) {
    console.error('[meta-ads-draft]', err?.message, err?.stack)
    return json({ ok: false, error: err?.message ?? 'unknown error' }, 400)
  }
})

// ── Helpers ──────────────────────────────────────────────────────────────────

interface AdsContext {
  userToken:    string
  adAccountId:  string   // includes act_ prefix
  pageId:       string
  igUserId:     string
  pixelId:      string | null
  scopes:       string[]
}

async function loadAdsContext(supabase: ReturnType<typeof createClient>): Promise<AdsContext> {
  const adAccountId = Deno.env.get('META_AD_ACCOUNT_ID')
  if (!adAccountId) throw new Error('META_AD_ACCOUNT_ID secret is required')

  // Prefer the System User token (permanent, business-owned, bypasses
  // App Review restrictions). Fall back to the OAuth user token from
  // oauth_tokens only when no system user token is configured.
  const systemUserToken = Deno.env.get('META_SYSTEM_USER_TOKEN')
  let userToken: string
  if (systemUserToken) {
    userToken = systemUserToken
  } else {
    const { data: tokenRow, error } = await supabase
      .from('oauth_tokens').select('access_token').eq('platform', 'meta').single()
    if (error || !tokenRow) throw new Error('Meta not connected — re-auth via Settings')
    userToken = tokenRow.access_token as string
  }

  // Permissions — tells us if ads_management is granted after the recent
  // FLB-config update. We surface the actual list so dry_run can show it.
  const permRes = await fetch(`${GRAPH}/me/permissions?access_token=${userToken}`)
  const permJson = await permRes.json()
  if (permJson.error) throw new Error(`me/permissions: ${permJson.error.message}`)
  const scopes: string[] = (permJson.data ?? [])
    .filter((p: any) => p.status === 'granted')
    .map((p: any) => p.permission)

  // Page + IG account from the first page the user manages
  const accRes = await fetch(`${GRAPH}/me/accounts?fields=id,name,instagram_business_account&access_token=${userToken}`)
  const accJson = await accRes.json()
  if (accJson.error) throw new Error(`me/accounts: ${accJson.error.message}`)
  const page = accJson.data?.[0]
  if (!page) throw new Error('no FB page accessible by the user — re-pick Page during Meta auth')
  const pageId   = page.id as string
  const igUserId = page.instagram_business_account?.id as string

  // Pixel ID — prefer the explicit secret over auto-discovery. Auto-discovery
  // picks the first pixel in /adspixels, which can be a stale third-party one
  // (e.g. AdScale) rather than the canonical Minuto pixel.
  let pixelId: string | null = Deno.env.get('META_PIXEL_ID') ?? null
  if (!pixelId) {
    try {
      const pxRes = await fetch(`${GRAPH}/${adAccountId}/adspixels?fields=id,name&access_token=${userToken}`)
      const pxJson = await pxRes.json()
      if (!pxJson.error) pixelId = pxJson.data?.[0]?.id ?? null
    } catch { /* non-fatal */ }
  }

  return { userToken, adAccountId, pageId, igUserId, pixelId, scopes }
}

async function graphPost(url: string, token: string, params: Record<string, string>): Promise<any> {
  const body = new URLSearchParams({ ...params, access_token: token })
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const j = await r.json()
  if (j.error) {
    throw new Error(`${j.error.type ?? 'Graph'} ${j.error.code ?? ''}: ${j.error.message} ${j.error.error_user_msg ? `(${j.error.error_user_msg})` : ''}`)
  }
  return j
}

async function resolveInterest(name: string, token: string): Promise<{ id: string; name: string } | null> {
  const url = `${GRAPH}/search?type=adinterest&q=${encodeURIComponent(name)}&limit=1&access_token=${token}`
  try {
    const r = await fetch(url)
    const j = await r.json()
    if (j.error) return null
    const hit = j.data?.[0]
    if (!hit?.id) return null
    return { id: hit.id, name: hit.name ?? name }
  } catch { return null }
}

// "OUTCOME_SALES" is the modern enum; "Sales" is what the agent emits.
function mapObjective(label: any): string {
  const s = String(label ?? '').toLowerCase()
  if (s.includes('catalog')) return 'OUTCOME_SALES'
  if (s.includes('sales'))   return 'OUTCOME_SALES'
  if (s.includes('lead'))    return 'OUTCOME_LEADS'
  if (s.includes('engage'))  return 'OUTCOME_ENGAGEMENT'
  if (s.includes('aware'))   return 'OUTCOME_AWARENESS'
  if (s.includes('app'))     return 'OUTCOME_APP_PROMOTION'
  return 'OUTCOME_TRAFFIC'  // safe default
}

function pickOptimizationGoal(objective: string, pixelId: string | null): string {
  if (objective === 'OUTCOME_SALES'      && pixelId) return 'OFFSITE_CONVERSIONS'
  if (objective === 'OUTCOME_SALES')                 return 'LINK_CLICKS'
  if (objective === 'OUTCOME_LEADS')                 return 'LEAD_GENERATION'
  if (objective === 'OUTCOME_ENGAGEMENT')            return 'POST_ENGAGEMENT'
  if (objective === 'OUTCOME_AWARENESS')             return 'REACH'
  return 'LINK_CLICKS'
}

function mapCta(label: any): string | null {
  const s = String(label ?? '').toUpperCase().replace(/\s+/g, '_')
  // Meta's CTA enum — covers the agent's likely outputs
  const allowed = new Set([
    'SHOP_NOW', 'ORDER_NOW', 'LEARN_MORE', 'SIGN_UP', 'BUY_NOW',
    'BOOK_TRAVEL', 'CONTACT_US', 'DOWNLOAD', 'GET_OFFER', 'GET_QUOTE',
    'SUBSCRIBE', 'WATCH_MORE',
  ])
  if (allowed.has(s)) return s
  return 'SHOP_NOW'
}

function parseAgeMin(range: any): number | null {
  const m = String(range ?? '').match(/(\d+)\s*[-–]\s*(\d+)/)
  return m ? Math.max(13, Math.min(65, parseInt(m[1], 10))) : null
}
function parseAgeMax(range: any): number | null {
  const m = String(range ?? '').match(/(\d+)\s*[-–]\s*(\d+)/)
  return m ? Math.max(13, Math.min(65, parseInt(m[2], 10))) : null
}

function buildUtm(tracking: any, ideaId: string): Record<string, string> {
  return {
    utm_source:   String(tracking?.utm_source   ?? 'meta'),
    utm_medium:   String(tracking?.utm_medium   ?? 'paid_social'),
    utm_campaign: String(tracking?.utm_campaign ?? slug(ideaId)),
    utm_content:  String(tracking?.utm_content  ?? 'draft'),
  }
}
function appendUtm(url: any, utm: Record<string, string>): string {
  const base = String(url ?? 'https://www.minuto.co.il')
  const sep = base.includes('?') ? '&' : '?'
  const qs = Object.entries(utm).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  return `${base}${sep}${qs}`
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'draft'
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}

function adsManagerEditUrl(adAccountId: string, campaignId: string): string {
  // adAccountId is "act_<digits>"; Ads Manager URL wants just the digits.
  const numeric = adAccountId.replace(/^act_/, '')
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns/edit?act=${numeric}&selected_campaign_ids=${campaignId}`
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
