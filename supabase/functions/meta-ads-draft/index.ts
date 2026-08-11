import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts'

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

  // Track a created campaign so we can roll it back if a later step in the
  // chain fails — otherwise a failed ad-set/creative leaves an orphan shell.
  let createdCampaignId: string | null = null
  let rollbackCtx: AdsContext | null = null

  try {
    const body = await req.json()
    const action  = body.action as 'dry_run' | 'create' | 'list' | 'delete' | 'spend'
    const ideaId  = String(body.idea_id ?? '').trim()
    const spec    = body.spec
    const imageUrl = body.image_url as string | undefined

    if (!action) throw new Error("'action' is required (dry_run|create|list|delete|spend)")
    if (action === 'create' && !ideaId) throw new Error("'idea_id' is required for create")
    if (action === 'create' && (!spec || typeof spec !== 'object')) {
      throw new Error("'spec' object is required for create")
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const ctx = await loadAdsContext(supabase)
    rollbackCtx = ctx

    if (action === 'dry_run') {
      return json({
        ok: true,
        ad_account_id: ctx.adAccountId,
        page_id:       ctx.pageId,
        ig_user_id:    ctx.igUserId,
        scopes:        ctx.scopes,
        pixel_id:      ctx.pixelId,
        token_source:  ctx.tokenSource,
        has_ads_management: ctx.scopes.includes('ads_management'),
      })
    }

    // ── list ── enumerate campaigns on the ad account (id/name/status). Used
    // for cleanup and to let the strategist see what already exists.
    if (action === 'list') {
      const r = await fetch(`${GRAPH}/${ctx.adAccountId}/campaigns?fields=id,name,status,effective_status,created_time&limit=100&access_token=${ctx.userToken}`)
      const j = await r.json()
      if (j.error) throw new Error(`campaigns list: ${j.error.message}`)
      return json({ ok: true, campaigns: j.data ?? [] })
    }

    // ── delete ── remove a campaign by id (Meta cascades to its ad sets/ads).
    // Best-effort clears any matching meta_ad_drafts row too.
    if (action === 'delete') {
      const campaignId = String(body.campaign_id ?? '').trim()
      if (!campaignId) throw new Error("'campaign_id' is required for delete")
      const r = await fetch(`${GRAPH}/${campaignId}?access_token=${ctx.userToken}`, { method: 'DELETE' })
      const j = await r.json()
      if (j.error) throw new Error(`delete ${campaignId}: ${j.error.message}`)
      await supabase.from('meta_ad_drafts').delete().eq('campaign_id', campaignId)
      return json({ ok: true, deleted: campaignId })
    }

    // ── spend ── account-level ad spend from Meta (authoritative). Returns
    // month-to-date and last month, in the ad account's currency + timezone
    // (date_preset lets Meta compute the month boundaries, not us). This is
    // also the "actual spend" signal the monthly budget guard will read.
    if (action === 'spend') {
      // Account currency for correct labelling (ad accounts are not always ILS).
      const accRes  = await fetch(`${GRAPH}/${ctx.adAccountId}?fields=currency,account_id,timezone_name&access_token=${ctx.userToken}`)
      const accJson = await accRes.json()
      const [monthToDate, lastMonth, committed] = await Promise.all([
        accountSpend(ctx, 'this_month'),
        accountSpend(ctx, 'last_month'),
        committedThisMonth(supabase),
      ])
      const monthlyCap = Number(Deno.env.get('META_MONTHLY_BUDGET_ILS') ?? 3000)
      return json({
        ok: true,
        currency:      accJson.currency ?? 'unknown',
        timezone:      accJson.timezone_name ?? 'unknown',
        month_to_date: round2(monthToDate),
        last_month:    round2(lastMonth),
        committed_drafts_this_month: round2(committed),
        monthly_cap:   monthlyCap,
        remaining_under_cap: round2(monthlyCap - monthToDate - committed),
      })
    }

    // ── insights ── LIVE per-campaign performance from Meta (spend, impressions,
    // clicks, CTR, CPC, purchases, CPA) over a date window. Powers on-demand
    // monitoring so the strategist can pull numbers itself instead of asking.
    if (action === 'insights') {
      const preset = String(body.date_preset ?? 'last_7d')
      const url = `${GRAPH}/${ctx.adAccountId}/insights?level=campaign&fields=campaign_name,spend,impressions,clicks,ctr,cpc,actions&date_preset=${encodeURIComponent(preset)}&limit=100&access_token=${ctx.userToken}`
      const r = await fetch(url)
      const j = await r.json()
      if (j.error) throw new Error(`insights: ${j.error.message}`)
      const rows = ((j.data ?? []) as any[]).map((d) => {
        const acts = (d.actions ?? []) as any[]
        const purchases = Number(acts.find((a) => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase')?.value ?? 0)
        const spend = Number(d.spend ?? 0)
        return {
          campaign:    d.campaign_name,
          spend:       round2(spend),
          impressions: Number(d.impressions ?? 0),
          clicks:      Number(d.clicks ?? 0),
          ctr:         round2(Number(d.ctr ?? 0)),
          cpc:         round2(Number(d.cpc ?? 0)),
          purchases,
          cpa:         purchases > 0 ? round2(spend / purchases) : null,
        }
      })
      return json({ ok: true, date_preset: preset, campaigns: rows })
    }

    // Dedupe — return existing draft if we already created one for this idea
    const { data: existing } = await supabase
      .from('meta_ad_drafts')
      .select('campaign_id, adset_id, ad_id, creative_id, warnings')
      .eq('idea_id', ideaId)
      .maybeSingle()
    if (existing?.campaign_id) {
      // Verify it still exists in Meta. The owner may have deleted the campaign
      // in Ads Manager, which leaves this dedup row stale — returning its dead
      // campaign_id would (wrongly) say "already exists". If it's gone, drop the
      // row and fall through to create a fresh campaign.
      let stillExists = false
      try {
        const chk = await fetch(`${GRAPH}/${existing.campaign_id}?fields=id&access_token=${ctx.userToken}`)
        const chkJson = await chk.json()
        stillExists = !chkJson.error && !!chkJson.id
      } catch { stillExists = false }
      if (stillExists) {
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
      await supabase.from('meta_ad_drafts').delete().eq('idea_id', ideaId)
    }

    if (!ctx.scopes.includes('ads_management')) {
      throw new Error("token missing 'ads_management' scope — re-auth Meta with the updated FLB config")
    }

    // ── Budget guard ── hard ceilings enforced in code BEFORE any Graph write,
    // so an over-budget request creates nothing (no rollback needed).
    //   • daily cap  — a single campaign may not exceed this per day.
    //   • monthly cap — total exposure = actual month-to-date spend (from Meta)
    //     + committed drafts this month + this campaign's planned spend.
    // Deliberately conservative: if either would be breached, refuse the draft.
    const dailyCap    = Number(Deno.env.get('META_MAX_DAILY_BUDGET_ILS') ?? 100)
    const monthlyCap  = Number(Deno.env.get('META_MONTHLY_BUDGET_ILS')   ?? 3000)
    const reqDaily    = Number(spec.daily_budget_ils ?? 60)
    const reqDuration = Math.max(1, Number(spec.duration_days ?? 14))
    if (reqDaily > dailyCap) {
      throw new Error(`daily budget ₪${reqDaily} exceeds per-campaign cap ₪${dailyCap} (META_MAX_DAILY_BUDGET_ILS)`)
    }
    const mtdSpend   = await accountSpend(ctx, 'this_month')
    const committed  = await committedThisMonth(supabase)
    const newPlanned = reqDaily * reqDuration
    const projected  = mtdSpend + committed + newPlanned
    if (projected > monthlyCap) {
      throw new Error(
        `monthly cap would be exceeded: actual ₪${round2(mtdSpend)} + committed ₪${round2(committed)} + this campaign ₪${round2(newPlanned)} = ₪${round2(projected)} > cap ₪${monthlyCap} (META_MONTHLY_BUDGET_ILS)`,
      )
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
    createdCampaignId = campaignId

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
      // Meta now REQUIRES advantage_audience on ad-set creation (OAuthException
      // 100 otherwise). 0 = keep the defined audience (no auto-expansion);
      // 1 = let Meta broaden it. We specify interests, so keep it off.
      targeting_automation: { advantage_audience: 0 },
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

    // ── 3+4. Creative — an EXISTING post/reel, or a fresh image + copy ───────
    const existingPost = (body as any).existing_post as { source?: string; id?: string } | undefined
    const creativeName = truncate(`${spec.campaign_name} — Creative`, 400)
    let creative: any

    if (existingPost?.id) {
      // Run an existing organic post/reel AS the ad (keeps its real engagement).
      // FB page post → object_story_id (PAGEID_POSTID). IG post/reel →
      // instagram_user_id + source_instagram_media_id. No image upload and no
      // link_data — the post's own content/link are used as-is.
      // A destination link + CTA — objectives like Traffic/Sales require a URL,
      // and an organic reel/post usually has none of its own.
      const linkForPost = appendUtm(spec.landing_page_url, buildUtm(spec.tracking, ideaId))
      const ctaForPost  = mapCta(spec.creative?.cta_button) || 'LEARN_MORE'
      const src = String(existingPost.source ?? 'ig').toLowerCase()
      if (src === 'fb' || src === 'facebook') {
        const rawId = String(existingPost.id)
        creative = await graphPost(`${GRAPH}/${ctx.adAccountId}/adcreatives`, ctx.userToken, {
          name: creativeName,
          object_story_id: rawId.includes('_') ? rawId : `${ctx.pageId}_${rawId}`,
        })
      } else {
        creative = await graphPost(`${GRAPH}/${ctx.adAccountId}/adcreatives`, ctx.userToken, {
          name: creativeName,
          instagram_user_id: ctx.igUserId,
          source_instagram_media_id: String(existingPost.id),
          call_to_action: JSON.stringify({ type: ctaForPost, value: { link: linkForPost } }),
        })
      }
    } else {
      // ── Fresh creative from an uploaded image + copy ──
      if (!imageUrl) throw new Error("image_url is required — pass a public URL Meta can fetch (or an existing_post)")
      const imageHash = await uploadAdImage(ctx.adAccountId, ctx.userToken, imageUrl)

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

      // instagram_actor_id was deprecated → v23 wants instagram_user_id; if Meta
      // rejects the IG param, retry without it (runs on the Page identity).
      const makeCreative = (storySpec: Record<string, any>) =>
        graphPost(`${GRAPH}/${ctx.adAccountId}/adcreatives`, ctx.userToken, {
          name: creativeName,
          object_story_spec: JSON.stringify(storySpec),
        })
      try {
        creative = await makeCreative({ page_id: ctx.pageId, instagram_user_id: ctx.igUserId, link_data: linkData })
      } catch (creErr: any) {
        if (/instagram/i.test(String(creErr?.message ?? '')) && ctx.igUserId) {
          warnings.push(`IG identity dropped from creative: ${creErr?.message ?? 'instagram param rejected'}`)
          creative = await makeCreative({ page_id: ctx.pageId, link_data: linkData })
        } else {
          throw creErr
        }
      }
    }
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
    // Roll back a half-built campaign so we never leave an orphan PAUSED shell.
    if (createdCampaignId && rollbackCtx) {
      try {
        await fetch(`${GRAPH}/${createdCampaignId}?access_token=${rollbackCtx.userToken}`, { method: 'DELETE' })
        console.log('[meta-ads-draft] rolled back campaign', createdCampaignId)
      } catch (rbErr) {
        console.error('[meta-ads-draft] rollback failed', rbErr)
      }
    }
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
  tokenSource:  'system_user' | 'oauth_user'
}

async function loadAdsContext(supabase: ReturnType<typeof createClient>): Promise<AdsContext> {
  const adAccountId = Deno.env.get('META_AD_ACCOUNT_ID')
  if (!adAccountId) throw new Error('META_AD_ACCOUNT_ID secret is required')

  // Prefer the System User token (permanent, business-owned, bypasses
  // App Review restrictions). Fall back to the OAuth user token from
  // oauth_tokens only when no system user token is configured.
  const systemUserToken = Deno.env.get('META_SYSTEM_USER_TOKEN')
  let userToken: string
  let tokenSource: 'system_user' | 'oauth_user'
  if (systemUserToken) {
    userToken = systemUserToken
    tokenSource = 'system_user'
  } else {
    tokenSource = 'oauth_user'
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

  return { userToken, adAccountId, pageId, igUserId, pixelId, scopes, tokenSource }
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
    const endpoint = url.split('?')[0].replace('https://graph.facebook.com', '')
    throw new Error(`[POST ${endpoint}] ${j.error.type ?? 'Graph'} ${j.error.code ?? ''}: ${j.error.message} ${j.error.error_user_msg ? `(${j.error.error_user_msg})` : ''}`)
  }
  return j
}

function round2(n: number): number { return Math.round(n * 100) / 100 }

// Account-level ad spend from Meta for a date_preset (e.g. this_month,
// last_month). Meta computes the range in the ad account's own timezone.
async function accountSpend(ctx: AdsContext, preset: string): Promise<number> {
  const url = `${GRAPH}/${ctx.adAccountId}/insights?fields=spend&level=account&date_preset=${preset}&access_token=${ctx.userToken}`
  const r = await fetch(url)
  const j = await r.json()
  if (j.error) throw new Error(`insights ${preset}: ${j.error.message}`)
  return Number(j.data?.[0]?.spend ?? 0)
}

// Planned spend already committed by drafts created this calendar month —
// sum of daily_budget_ils × duration_days across meta_ad_drafts rows. Deleted
// drafts are gone from the table, so they drop out automatically.
async function committedThisMonth(supabase: ReturnType<typeof createClient>): Promise<number> {
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const { data } = await supabase
    .from('meta_ad_drafts')
    .select('daily_budget_ils, spec, created_at')
    .gte('created_at', monthStart)
  let sum = 0
  for (const row of (data ?? []) as any[]) {
    const daily    = Number(row.daily_budget_ils ?? 0)
    const duration = Math.max(1, Number(row?.spec?.duration_days ?? 14))
    sum += daily * duration
  }
  return sum
}

// Upload the creative image and return its hash. Tries the cheap URL-fetch
// path first; some app access levels reject that with OAuthException #3, so we
// fall back to uploading the raw bytes (base64) which is more broadly allowed.
async function uploadAdImage(adAccountId: string, token: string, imageUrl: string): Promise<string> {
  // /adimages response shape: { images: { "<filename>": { hash, url, ... } } }
  const hashOf = (res: any): string | null => {
    const imagesObj = res?.images ?? {}
    const firstKey  = Object.keys(imagesObj)[0]
    return firstKey ? (imagesObj[firstKey].hash ?? null) : null
  }

  let urlErr: unknown = null
  try {
    const res = await graphPost(`${GRAPH}/${adAccountId}/adimages`, token, { url: imageUrl })
    const hash = hashOf(res)
    if (hash) return hash
  } catch (e) {
    urlErr = e
  }

  // Bytes fallback — fetch the image ourselves and hand Meta the raw data.
  const img = await fetch(imageUrl)
  if (!img.ok) throw new Error(`could not fetch image_url (HTTP ${img.status})`)
  const bytesB64 = encodeBase64(new Uint8Array(await img.arrayBuffer()))
  const res2 = await graphPost(`${GRAPH}/${adAccountId}/adimages`, token, { bytes: bytesB64 })
  const hash2 = hashOf(res2)
  if (hash2) return hash2

  throw new Error(
    `image upload returned no hash (url path: ${urlErr instanceof Error ? urlErr.message : 'n/a'})`,
  )
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
  // The spec's landing_page_url can arrive messy — the model sometimes packs
  // commentary or multiple URLs into it. Extract the FIRST clean http(s) URL,
  // drop any existing query/hash + trailing punctuation, then append our UTM.
  const raw = String(url ?? '')
  const m = raw.match(/https?:\/\/[^\s"'<>)\]]+/)
  const base = (m ? m[0] : 'https://www.minuto.co.il')
    .replace(/[.,;!?]+$/, '')
    .split('?')[0]
    .split('#')[0]
  const qs = Object.entries(utm).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  return `${base}?${qs}`
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
