import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.116.0'
import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts'
import {
  claimConflict, claimIdea, committedThisMonth, finalizeClaim, isClaim, isServiceCaller,
  parseAction, releaseClaim, syncDraftBudget,
} from './guards.ts'

// Creates a PAUSED Google Ads campaign from a draft_google_campaign spec —
// the Google twin of meta-ads-draft. The owner reviews + activates manually
// in the Google Ads UI.
//
// Two campaign shapes, both PAUSED until the owner flips them:
//
//   SEARCH           budget → campaign → geo/language criteria → ad group
//                    → keywords → Responsive Search Ad
//   PERFORMANCE_MAX  budget → campaign (+ Merchant Center shopping setting)
//                    → text assets + image assets → asset group
//                    → asset-group asset links → listing-group filter
//
// Everything goes out as ONE googleAds:mutate call with temp resource names
// (-1, -2, …). Google applies a mutate atomically when partialFailure is
// false, so a failure part-way through writes nothing — no rollback dance
// like the Meta side needs.
//
// Body: { action, idea_id?, spec?, validate_only?, ... }
//   dry_run        account context + a validateOnly mutate of the real spec
//   accounts       which customers this OAuth connection can actually reach
//   create         the full chain
//   insights       live per-campaign performance (GAQL)
//   search_terms   what people actually typed — feeds negative keywords
//   update_campaign  name / status / daily budget
//   update_targeting keywords, negatives, geo, language
//   list / delete / spend
//
// Returns: { ok, campaign_id, edit_url, warnings: string[] }
//
// Callers must present the service-role key (see isServiceCaller). verify_jwt
// is off, so without that check anyone could edit, enable or delete campaigns.

const ADS_API = 'https://googleads.googleapis.com/v24'

// Israel. Hebrew + English are the languages Minuto advertises in.
const GEO_ISRAEL = 'geoTargetConstants/2376'
const LANG_HEBREW = 'languageConstants/1027'
const LANG_ENGLISH = 'languageConstants/1000'

// Google's hard limits on ad text. Exceeding any of these is a mutate error,
// so we truncate + warn rather than letting the API reject the whole batch.
// Google requires every campaign to declare this since v24.
const NOT_POLITICAL = 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'

const RSA_HEADLINE_MAX = 30
const RSA_DESCRIPTION_MAX = 90
const PMAX_LONG_HEADLINE_MAX = 90
const PMAX_BUSINESS_NAME_MAX = 25
const PMAX_SHORT_DESCRIPTION_MAX = 60

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const authorized = await isServiceCaller(req, {
    supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
    serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  })
  if (!authorized) return json({ ok: false, error: 'unauthorized — this function only accepts the service-role key' }, 401)

  try {
    const body = await req.json()
    const action = parseAction(body.action)
    const ideaId = String(body.idea_id ?? '').trim()
    const spec = body.spec

    if (action === 'create' && !ideaId) throw new Error("'idea_id' is required for create")
    if (action === 'create' && (!spec || typeof spec !== 'object')) {
      throw new Error("'spec' object is required for create")
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // ── accounts ── which customers this OAuth connection can actually reach.
    // Answered WITHOUT loading the account context, because the reason to ask
    // is usually that the configured customer is the one being refused.
    if (action === 'accounts') {
      const bare = await bareContext(supabase)
      let accessible: string[] = []
      let listError: string | null = null
      try { accessible = await listAccessibleCustomers(bare) }
      catch (e: unknown) { listError = e instanceof Error ? e.message : String(e) }
      // The shopping settings of campaigns already running — the ground truth
      // for which Merchant Center account and feed label a new Performance Max
      // campaign should point at.
      let shopping: unknown[] = []
      let shoppingError: string | null = null
      try {
        const ctxFull = await loadAdsContext(supabase)
        const rows = await gaql(ctxFull, `
          SELECT campaign.id, campaign.name, campaign.status,
                 campaign.advertising_channel_type,
                 campaign.shopping_setting.merchant_id,
                 campaign.shopping_setting.feed_label
          FROM campaign
          WHERE campaign.advertising_channel_type IN ('SHOPPING', 'PERFORMANCE_MAX')
            AND campaign.status != 'REMOVED'
          ORDER BY campaign.id DESC
        `, 'shopping_settings')
        shopping = (rows as any[])
          .filter((r) => r.campaign?.shoppingSetting?.merchantId)
          .map((r) => ({
            campaign_id: String(r.campaign.id),
            name: r.campaign.name,
            status: r.campaign.status,
            channel_type: r.campaign.advertisingChannelType,
            merchant_id: String(r.campaign.shoppingSetting.merchantId),
            feed_label: r.campaign.shoppingSetting.feedLabel ?? null,
          }))
      } catch (e: unknown) { shoppingError = e instanceof Error ? e.message : String(e) }

      return json({
        ok: true,
        configured_customer_id: bare.customerId,
        configured_login_customer_id: bare.configuredLoginCustomerId,
        oauth_account: bare.oauthAccountName,
        accessible_customers: accessible,
        configured_customer_is_accessible: accessible.includes(bare.customerId),
        list_error: listError,
        shopping_campaigns: shopping,
        shopping_error: shoppingError,
      })
    }

    const ctx = await loadAdsContext(supabase)

    // ── dry_run ── no writes. Reports the account context the strategist needs
    // (currency, conversion tracking, Merchant Center) and, when a spec is
    // supplied, runs it through Google's own validateOnly mutate. That is the
    // cheapest possible proof that the developer token can actually mutate and
    // that the spec is well-formed, without creating anything.
    if (action === 'dry_run') {
      const out: Record<string, unknown> = {
        ok: true,
        customer_id: ctx.customerId,
        // Non-null means the account sits under a manager. Set it as
        // GOOGLE_LOGIN_CUSTOMER_ID to skip the discovery round-trip.
        login_customer_id: ctx.loginCustomerId,
        descriptive_name: ctx.descriptiveName,
        currency: ctx.currency,
        time_zone: ctx.timeZone,
        conversion_tracking_status: ctx.conversionTrackingStatus,
        conversion_tracking_active: ctx.conversionTrackingActive,
        merchant_id: ctx.merchantId ?? null,
        merchant_feed_label: ctx.merchantFeedLabel,
        merchant_ids_seen_in_account: ctx.merchantCandidates,
        merchant_center_linked: !!ctx.merchantId,
        channel_types_in_account: await accountChannelTypes(ctx),
        daily_cap_ils: dailyCap(),
        monthly_cap_ils: monthlyCap(),
      }

      if (spec && typeof spec === 'object') {
        const built = await buildOperations(ctx, spec, ideaId || 'dry_run')
        out.spec_warnings = built.warnings
        out.operation_count = built.operations.length
        try {
          await mutate(ctx, built.operations, true)
          out.validate_only_result = 'PASSED — Google accepted the spec; nothing was created'
          out.can_mutate = true
        } catch (e: unknown) {
          out.validate_only_result = `REJECTED — ${e instanceof Error ? e.message : String(e)}`
          out.can_mutate = false
        }
      }
      return json(out)
    }

    // ── list ── campaigns on the account, so the strategist can see what
    // already exists before proposing something that duplicates it.
    if (action === 'list') {
      const rows = await gaql(ctx, `
        SELECT campaign.id, campaign.name, campaign.status,
               campaign.advertising_channel_type, campaign.bidding_strategy_type,
               campaign_budget.amount_micros
        FROM campaign
        WHERE campaign.status != 'REMOVED'
        ORDER BY campaign.id DESC
      `, 'list')
      return json({
        ok: true,
        customer_id: ctx.customerId,
        campaigns: rows.map((r: any) => ({
          campaign_id: String(r.campaign?.id ?? ''),
          name: r.campaign?.name ?? null,
          status: r.campaign?.status ?? null,
          channel_type: r.campaign?.advertisingChannelType ?? null,
          bidding_strategy: r.campaign?.biddingStrategyType ?? null,
          daily_budget_ils: microsToIls(r.campaignBudget?.amountMicros),
        })),
      })
    }

    // ── delete ── remove a campaign (Google cascades to its ad groups/ads).
    // Best-effort clears the matching google_ad_drafts row too.
    if (action === 'delete') {
      const target = await resolveCampaign(ctx, body.campaign_id)
      const campaignId = target.id
      await mutate(ctx, [{
        campaignOperation: { remove: `customers/${ctx.customerId}/campaigns/${campaignId}` },
      }], false)
      await supabase.from('google_ad_drafts').delete().eq('campaign_id', campaignId)
      return json({ ok: true, deleted: campaignId, campaign_name: target.name })
    }

    // ── spend ── authoritative account spend from Google, month-to-date and
    // last month, in the account's own currency + timezone. The monthly budget
    // guard reads this rather than trusting our own records.
    if (action === 'spend') {
      const [mtd, last, committed] = await Promise.all([
        accountSpend(ctx, ...monthToDateRange(ctx.timeZone)),
        accountSpend(ctx, ...lastMonthRange(ctx.timeZone)),
        committedThisMonth(supabase),
      ])
      return json({
        ok: true,
        currency: ctx.currency,
        timezone: ctx.timeZone,
        month_to_date: round2(mtd),
        last_month: round2(last),
        committed_drafts_this_month: round2(committed),
        monthly_cap: monthlyCap(),
        remaining_under_cap: round2(monthlyCap() - mtd - committed),
      })
    }

    // ── insights ── LIVE per-campaign performance. Uses all_conversions, not
    // conversions: new conversion actions default to "Secondary" in the Google
    // UI and are invisible to metrics.conversions. Same gotcha google-sync hit.
    if (action === 'insights') {
      const [since, until] = presetRange(String(body.date_preset ?? 'last_7d'), ctx.timeZone)
      const rows = await gaql(ctx, `
        SELECT campaign.id, campaign.name, campaign.status,
               campaign.advertising_channel_type,
               metrics.cost_micros, metrics.impressions, metrics.clicks,
               metrics.ctr, metrics.average_cpc,
               metrics.all_conversions, metrics.all_conversions_value,
               metrics.conversions, metrics.conversions_value
        FROM campaign
        WHERE segments.date BETWEEN '${since}' AND '${until}'
          AND campaign.status != 'REMOVED'
      `, 'insights')

      // One row per campaign per day comes back — fold them together.
      const agg = new Map<string, any>()
      for (const r of rows as any[]) {
        const id = String(r.campaign?.id ?? '')
        const cur = agg.get(id) ?? {
          campaign_id: id,
          campaign: r.campaign?.name ?? null,
          status: r.campaign?.status ?? null,
          channel_type: r.campaign?.advertisingChannelType ?? null,
          cost_micros: 0, impressions: 0, clicks: 0,
          all_conversions: 0, all_conversions_value: 0,
          conversions: 0, conversions_value: 0,
        }
        const m = r.metrics ?? {}
        cur.cost_micros += Number(m.costMicros ?? 0)
        cur.impressions += Number(m.impressions ?? 0)
        cur.clicks += Number(m.clicks ?? 0)
        cur.all_conversions += Number(m.allConversions ?? 0)
        cur.all_conversions_value += Number(m.allConversionsValue ?? 0)
        cur.conversions += Number(m.conversions ?? 0)
        cur.conversions_value += Number(m.conversionsValue ?? 0)
        agg.set(id, cur)
      }

      const campaigns = [...agg.values()].map((c) => {
        const spend = microsToIls(c.cost_micros) ?? 0
        // all_conversions is the superset; fall back only when it is empty.
        const conv = c.all_conversions > 0 ? c.all_conversions : c.conversions
        const convValue = c.all_conversions_value > 0 ? c.all_conversions_value : c.conversions_value
        return {
          campaign_id: c.campaign_id,
          campaign: c.campaign,
          status: c.status,
          channel_type: c.channel_type,
          spend: round2(spend),
          impressions: c.impressions,
          clicks: c.clicks,
          ctr: c.impressions > 0 ? round2((c.clicks / c.impressions) * 100) : 0,
          cpc: c.clicks > 0 ? round2(spend / c.clicks) : 0,
          conversions: round2(conv),
          conversion_value: round2(convValue),
          cpa: conv > 0 ? round2(spend / conv) : null,
          roas: spend > 0 ? round2(convValue / spend) : null,
          conversion_metric_used: c.all_conversions > 0 ? 'all_conversions' : 'conversions',
        }
      }).sort((a, b) => b.spend - a.spend)

      return json({ ok: true, since, until, currency: ctx.currency, campaigns })
    }

    // ── search_terms ── the actual queries that triggered our ads. Google has
    // no Meta equivalent; this is the raw material for negative keywords and
    // for finding demand we are not yet bidding on.
    if (action === 'search_terms') {
      const [since, until] = presetRange(String(body.date_preset ?? 'last_30d'), ctx.timeZone)
      const limit = Math.min(200, Math.max(1, Number(body.limit ?? 60)))
      const rows = await gaql(ctx, `
        SELECT search_term_view.search_term, search_term_view.status,
               campaign.name, ad_group.name,
               metrics.impressions, metrics.clicks, metrics.cost_micros,
               metrics.all_conversions
        FROM search_term_view
        WHERE segments.date BETWEEN '${since}' AND '${until}'
        ORDER BY metrics.cost_micros DESC
        LIMIT ${limit}
      `, 'search_terms')

      const terms = (rows as any[]).map((r) => {
        const m = r.metrics ?? {}
        const spend = microsToIls(m.costMicros) ?? 0
        const conv = Number(m.allConversions ?? 0)
        return {
          search_term: r.searchTermView?.searchTerm ?? null,
          // ADDED = we bid on it; NONE = it matched but is not a keyword yet;
          // EXCLUDED = already negated.
          status: r.searchTermView?.status ?? null,
          campaign: r.campaign?.name ?? null,
          ad_group: r.adGroup?.name ?? null,
          impressions: Number(m.impressions ?? 0),
          clicks: Number(m.clicks ?? 0),
          spend: round2(spend),
          conversions: round2(conv),
          // Spend with nothing to show for it — the negative-keyword candidates.
          wasted_spend: conv === 0 ? round2(spend) : 0,
        }
      })
      return json({ ok: true, since, until, currency: ctx.currency, search_terms: terms })
    }

    // ── update_campaign ── name / status / daily budget. The daily cap applies
    // to edits as well, so a live campaign can't be raised above it either.
    if (action === 'update_campaign') {
      const target = await resolveCampaign(ctx, body.campaign_id)
      const campaignId = target.id

      const ops: any[] = []
      const changed: Record<string, unknown> = {}
      const campaignFields: string[] = []
      const campaignUpdate: any = { resourceName: `customers/${ctx.customerId}/campaigns/${campaignId}` }

      if (body.name != null) {
        campaignUpdate.name = String(body.name).slice(0, 255)
        campaignFields.push('name')
        changed.name = campaignUpdate.name
      }
      if (body.status != null) {
        const st = String(body.status).toUpperCase()
        if (!['ENABLED', 'PAUSED'].includes(st)) throw new Error('status must be ENABLED or PAUSED')
        campaignUpdate.status = st
        campaignFields.push('status')
        changed.status = st
      }
      if (campaignFields.length) {
        ops.push({ campaignOperation: { update: campaignUpdate, updateMask: campaignFields.join(',') } })
      }

      if (body.daily_budget_ils != null) {
        const req = Number(body.daily_budget_ils)
        if (!(req > 0)) throw new Error('daily_budget_ils must be a positive number')
        if (req > dailyCap()) {
          throw new Error(`daily budget ₪${req} exceeds per-campaign cap ₪${dailyCap()} (GOOGLE_MAX_DAILY_BUDGET_ILS)`)
        }
        // The budget is its own resource — look up which one this campaign uses.
        const budgetRows = await gaql(ctx, `
          SELECT campaign.id, campaign_budget.resource_name
          FROM campaign
          WHERE campaign.id = ${Number(campaignId)}
        `, 'campaign_budget_lookup')
        const budgetResource = (budgetRows as any[])[0]?.campaignBudget?.resourceName
        if (!budgetResource) throw new Error(`no budget found for campaign ${campaignId}`)
        ops.push({
          campaignBudgetOperation: {
            update: { resourceName: budgetResource, amountMicros: ilsToMicros(req) },
            updateMask: 'amount_micros',
          },
        })
        changed.daily_budget_ils = req
      }

      if (!ops.length) throw new Error('nothing to update — pass name, status, and/or daily_budget_ils')
      const res = await mutate(ctx, ops, false)
      const warnings: string[] = []
      if (changed.daily_budget_ils != null) {
        const syncWarning = await syncDraftBudget(supabase, campaignId, Number(changed.daily_budget_ils))
        if (syncWarning) warnings.push(syncWarning)
      }
      return json({ ok: true, updated: campaignId, campaign_name: target.name, changed, warnings, result: res })
    }

    // ── update_targeting ── the Google analogue of changing a Meta audience:
    // keywords in, keywords out, negatives, and the campaign's geo/language.
    if (action === 'update_targeting') {
      const target = await resolveCampaign(ctx, body.campaign_id)
      const campaignId = target.id
      const t = (body.targeting ?? {}) as any
      const ops: any[] = []
      const warnings: string[] = []
      const applied: Record<string, unknown> = {}

      // Ad groups of this campaign — new keywords need one to live in.
      const adGroupRows = await gaql(ctx, `
        SELECT ad_group.id, ad_group.name, ad_group.resource_name
        FROM ad_group
        WHERE campaign.id = ${Number(campaignId)} AND ad_group.status != 'REMOVED'
      `, 'ad_groups')
      const adGroups = (adGroupRows as any[]).map((r) => r.adGroup).filter(Boolean)

      const addKeywords: string[] = asStringArray(t.add_keywords)
      if (addKeywords.length) {
        if (!adGroups.length) {
          throw new Error(`campaign ${campaignId} has no ad group to add keywords to (Performance Max campaigns have none — use asset groups instead)`)
        }
        const target = adGroups[0].resourceName
        const matchType = normalizeMatchType(t.match_type ?? 'PHRASE')
        for (const kw of addKeywords) {
          ops.push({
            adGroupCriterionOperation: {
              create: {
                adGroup: target,
                status: 'ENABLED',
                keyword: { text: kw, matchType },
              },
            },
          })
        }
        applied.added_keywords = addKeywords
        applied.added_to_ad_group = adGroups[0].name
      }

      const removeKeywords: string[] = asStringArray(t.remove_keywords)
      if (removeKeywords.length) {
        const existing = await gaql(ctx, `
          SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text
          FROM ad_group_criterion
          WHERE campaign.id = ${Number(campaignId)}
            AND ad_group_criterion.type = 'KEYWORD'
            AND ad_group_criterion.status != 'REMOVED'
            AND ad_group_criterion.negative = false
        `, 'existing_keywords')
        const byText = new Map<string, string>()
        for (const r of existing as any[]) {
          const text = r.adGroupCriterion?.keyword?.text
          if (text) byText.set(String(text).toLowerCase(), r.adGroupCriterion.resourceName)
        }
        const removed: string[] = []
        for (const kw of removeKeywords) {
          const rn = byText.get(kw.toLowerCase())
          if (rn) { ops.push({ adGroupCriterionOperation: { remove: rn } }); removed.push(kw) }
          else warnings.push(`keyword not found on this campaign, nothing removed: "${kw}"`)
        }
        applied.removed_keywords = removed
      }

      // Negatives go on the CAMPAIGN, so they cover every ad group at once.
      const negatives: string[] = asStringArray(t.negative_keywords)
      if (negatives.length) {
        const matchType = normalizeMatchType(t.negative_match_type ?? 'BROAD')
        for (const kw of negatives) {
          ops.push({
            campaignCriterionOperation: {
              create: {
                campaign: `customers/${ctx.customerId}/campaigns/${campaignId}`,
                negative: true,
                keyword: { text: kw, matchType },
              },
            },
          })
        }
        applied.negative_keywords = negatives
      }

      const geos: string[] = asStringArray(t.geo_target_constants)
      if (geos.length) {
        for (const g of geos) {
          ops.push({
            campaignCriterionOperation: {
              create: {
                campaign: `customers/${ctx.customerId}/campaigns/${campaignId}`,
                location: { geoTargetConstant: g.startsWith('geoTargetConstants/') ? g : `geoTargetConstants/${g}` },
              },
            },
          })
        }
        applied.geo_target_constants = geos
      }

      const langs: string[] = asStringArray(t.language_constants)
      if (langs.length) {
        for (const l of langs) {
          ops.push({
            campaignCriterionOperation: {
              create: {
                campaign: `customers/${ctx.customerId}/campaigns/${campaignId}`,
                language: { languageConstant: l.startsWith('languageConstants/') ? l : `languageConstants/${l}` },
              },
            },
          })
        }
        applied.language_constants = langs
      }

      if (!ops.length) {
        throw new Error('nothing to change — pass add_keywords, remove_keywords, negative_keywords, geo_target_constants and/or language_constants')
      }
      const res = await mutate(ctx, ops, body.validate_only === true)
      return json({ ok: true, campaign_id: campaignId, campaign_name: target.name, applied, warnings, validate_only: body.validate_only === true, result: res })
    }

    // ════════════════════════════════════════════════════════════════════════
    // create
    // ════════════════════════════════════════════════════════════════════════

    // Dedup — re-running the same idea_id returns the existing draft instead of
    // creating a twin. Verify it still exists in Google first, so the row
    // self-heals after the owner deletes the campaign in the UI.
    //
    // This doubles as the bookkeeping preflight. The Google mutate is atomic but
    // it is NOT undoable, so if the drafts table were missing we would create a
    // real campaign and only then fail to record it — an orphan nobody can dedup
    // against. Fail here, before anything is written.
    const { data: existing, error: draftsErr } = await supabase
      .from('google_ad_drafts')
      .select('*')
      .eq('idea_id', ideaId)
      .maybeSingle()

    if (draftsErr) {
      throw new Error(`cannot reach the google_ad_drafts table (${draftsErr.message}) — refusing to create a campaign we could not record. Apply the 20260915_google_ad_drafts migration first.`)
    }

    // Another request holds this idea_id and hasn't recorded its campaign yet.
    if (existing && isClaim(existing)) {
      const conflict = claimConflict(existing)
      return json(conflict.body, conflict.status)
    }

    if (existing) {
      const stillThere = await campaignExists(ctx, String(existing.campaign_id))
      if (stillThere) {
        return json({
          ok: true,
          already_exists: true,
          campaign_id: existing.campaign_id,
          campaign_type: existing.campaign_type,
          edit_url: adsUiUrl(ctx.customerId, String(existing.campaign_id)),
          warnings: existing.warnings ?? [],
        })
      }
      await supabase.from('google_ad_drafts').delete().eq('idea_id', ideaId)
    }

    // ── Budget guard ── hard ceilings enforced in code BEFORE the mutate, so an
    // over-budget request creates nothing.
    //   • daily cap   — a single campaign may not exceed this per day.
    //   • monthly cap — actual month-to-date spend (from Google) + drafts
    //     already committed this month + this campaign's planned spend.
    // The caps are stated in ₪, so an account in another currency would make
    // them meaningless — refuse rather than silently compare the wrong numbers.
    if (ctx.currency !== 'ILS') {
      throw new Error(`account currency is ${ctx.currency}, but the budget caps are expressed in ILS — refusing to create a campaign against caps that don't apply`)
    }
    const reqDaily = Number(spec.daily_budget_ils ?? 60)
    const reqDuration = Math.max(1, Number(spec.duration_days ?? 14))
    if (!(reqDaily > 0)) throw new Error('daily_budget_ils must be a positive number')
    if (reqDaily > dailyCap()) {
      throw new Error(`daily budget ₪${reqDaily} exceeds per-campaign cap ₪${dailyCap()} (GOOGLE_MAX_DAILY_BUDGET_ILS)`)
    }
    const mtdSpend = await accountSpend(ctx, ...monthToDateRange(ctx.timeZone))
    const committed = await committedThisMonth(supabase)
    const newPlanned = reqDaily * reqDuration
    const projected = mtdSpend + committed + newPlanned
    if (projected > monthlyCap()) {
      throw new Error(
        `monthly cap would be exceeded: actual ₪${round2(mtdSpend)} + committed ₪${round2(committed)} + this campaign ₪${round2(newPlanned)} = ₪${round2(projected)} > cap ₪${monthlyCap()} (GOOGLE_MONTHLY_BUDGET_ILS)`,
      )
    }

    const validateOnly = body.validate_only === true

    // Reserve the idea_id before anything reaches Google. The lookup above is
    // only a fast path — two requests can both pass it, so the unique
    // constraint is what actually decides which one creates the campaign.
    let claimId: number | null = null
    if (!validateOnly) {
      const claim = await claimIdea(supabase, {
        idea_id: ideaId,
        customer_id: ctx.customerId,
        campaign_name: spec.campaign_name,
        daily_budget_ils: reqDaily,
        spec,
      })
      if (claim.kind === 'taken') {
        if (isClaim(claim.row)) {
          const conflict = claimConflict(claim.row)
          return json(conflict.body, conflict.status)
        }
        return json({
          ok: true,
          already_exists: true,
          campaign_id: claim.row.campaign_id,
          campaign_type: claim.row.campaign_type,
          edit_url: adsUiUrl(ctx.customerId, String(claim.row.campaign_id)),
          warnings: claim.row.warnings ?? [],
        })
      }
      claimId = claim.id
    }

    let built: Awaited<ReturnType<typeof buildOperations>>
    let result: any
    try {
      built = await buildOperations(ctx, spec, ideaId)
      result = await mutate(ctx, built.operations, validateOnly)
    } catch (e) {
      // The mutate is atomic, so a failure here created nothing — free the
      // idea_id for a retry.
      if (claimId != null) await releaseClaim(supabase, claimId)
      throw e
    }

    if (validateOnly) {
      return json({
        ok: true,
        validate_only: true,
        campaign_type: built.campaignType,
        operation_count: built.operations.length,
        warnings: built.warnings,
        note: 'Google accepted the spec. Nothing was created — re-run without validate_only to build it.',
      })
    }

    // Resource names come back in mutate order; pull the ids we care about.
    // From here on the campaign exists in Google, so the claim is never
    // released: a row stuck at CREATING is the trail to the orphan.
    const created = collectCreatedIds(result)
    if (!created.campaignId) {
      throw new Error(`mutate succeeded but returned no campaign resource name — google_ad_drafts row ${claimId} left at CREATING: ${JSON.stringify(result).slice(0, 400)}`)
    }

    const recordError = await finalizeClaim(supabase, claimId!, {
      campaign_id: created.campaignId,
      budget_id: created.budgetId,
      ad_group_id: created.adGroupId,
      ad_id: created.adId,
      asset_group_id: created.assetGroupId,
      campaign_type: built!.campaignType,
      warnings: built!.warnings,
    })
    if (recordError) {
      return json({
        ok: false,
        error: `campaign ${created.campaignId} was created (PAUSED) in Google Ads but could not be recorded in google_ad_drafts (${recordError}). ` +
          `It is not tracked for dedup or the monthly cap — fix the row before creating more.`,
        campaign_id: created.campaignId,
        edit_url: adsUiUrl(ctx.customerId, created.campaignId),
      }, 500)
    }

    return json({
      ok: true,
      campaign_id: created.campaignId,
      campaign_type: built.campaignType,
      budget_id: created.budgetId,
      ad_group_id: created.adGroupId,
      ad_id: created.adId,
      asset_group_id: created.assetGroupId,
      edit_url: adsUiUrl(ctx.customerId, created.campaignId),
      warnings: built.warnings,
    })
  } catch (err: any) {
    console.error('[google-ads-draft]', err?.message, err?.stack)
    return json({ ok: false, error: err?.message ?? 'unknown error' }, 400)
  }
})

// ── Context ──────────────────────────────────────────────────────────────────

// supabase-js's generics don't survive being named through ReturnType, and
// these helpers only ever reach for the query-builder entry point — so they
// take the client structurally.
type SupabaseLike = { from: (table: string) => any }

interface AdsContext {
  customerId: string
  accessToken: string
  devToken: string
  // The header we actually send. Starts null: this account is reachable
  // directly, and naming a manager the OAuth user cannot reach is itself a
  // permission error. Only set when direct access is refused.
  loginCustomerId: string | null
  configuredLoginCustomerId: string | null
  oauthAccountName: string | null
  descriptiveName: string | null
  currency: string
  timeZone: string
  conversionTrackingStatus: string | null
  conversionTrackingActive: boolean
  merchantId: string | null
  // Merchant Center feed label the account's own campaigns use ('IL' here).
  // shopping_setting is rejected without the label matching the feed.
  merchantFeedLabel: string | null
  merchantCandidates: string[]
}

// Credentials and ids only — no Google call beyond the token refresh. Split out
// so the `accounts` diagnostic can run even when the configured customer is the
// thing being refused.
async function bareContext(supabase: SupabaseLike): Promise<AdsContext> {
  const devToken = Deno.env.get('GOOGLE_DEVELOPER_TOKEN')
  if (!devToken) throw new Error('GOOGLE_DEVELOPER_TOKEN not set')

  const rawCustomerId = Deno.env.get('GOOGLE_CUSTOMER_ID')
  if (!rawCustomerId) throw new Error('GOOGLE_CUSTOMER_ID not set')

  const { data: tokenRow } = await supabase
    .from('oauth_tokens').select('*').eq('platform', 'google').single()
  if (!tokenRow) throw new Error('Google not connected — no oauth_tokens row for platform=google')

  const accessToken = await refreshGoogleToken(String(tokenRow.refresh_token))
  await supabase.from('oauth_tokens').update({
    access_token: accessToken,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  }).eq('platform', 'google')

  return {
    customerId: rawCustomerId.replace(/-/g, ''),
    accessToken,
    devToken,
    loginCustomerId: null,
    configuredLoginCustomerId: Deno.env.get('GOOGLE_LOGIN_CUSTOMER_ID')?.replace(/-/g, '') || null,
    oauthAccountName: (tokenRow as any).account_name ?? null,
    descriptiveName: null,
    currency: 'unknown',
    timeZone: 'Asia/Jerusalem',
    conversionTrackingStatus: null,
    conversionTrackingActive: false,
    merchantId: Deno.env.get('GOOGLE_MERCHANT_ID')?.trim() || null,
    merchantFeedLabel: Deno.env.get('GOOGLE_MERCHANT_FEED_LABEL')?.trim() || null,
    merchantCandidates: [],
  }
}

async function loadAdsContext(supabase: SupabaseLike): Promise<AdsContext> {
  const ctx = await bareContext(supabase)
  const customerId = ctx.customerId

  // Live account facts — authoritative, and cheap. The budget guard compares ₪
  // against these, so reading them from a stale sync table would be wrong.
  const contextQuery = `
    SELECT customer.id, customer.descriptive_name, customer.currency_code,
           customer.time_zone,
           customer.conversion_tracking_setting.conversion_tracking_status
    FROM customer
    LIMIT 1
  `
  // Try direct access first, then fall back through the manager candidates.
  // An account under a manager (MCC) refuses any call that doesn't name that
  // manager in login-customer-id — but naming a manager the OAuth user cannot
  // reach is ALSO a permission error, so the configured id is a candidate to
  // try rather than a value to trust.
  let rows: any[] | null = null
  let firstError = ''
  const attempts: Array<string | null> = [null]
  if (ctx.configuredLoginCustomerId) attempts.push(ctx.configuredLoginCustomerId)

  for (const candidate of attempts) {
    ctx.loginCustomerId = candidate
    try { rows = await gaql(ctx, contextQuery, 'customer_context'); break }
    catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!firstError) firstError = msg
      if (!msg.includes('USER_PERMISSION_DENIED')) throw e
    }
  }

  // Still refused — ask Google which accounts this connection can reach and
  // try each as the manager, so a real MCC setup works without configuration.
  if (!rows) {
    const discovered = (await listAccessibleCustomers(ctx))
      .filter((id) => id !== customerId && !attempts.includes(id))
    for (const managerId of discovered) {
      ctx.loginCustomerId = managerId
      try { rows = await gaql(ctx, contextQuery, 'customer_context'); break }
      catch { /* next candidate */ }
    }
    if (!rows) {
      ctx.loginCustomerId = null
      throw new Error(`${firstError} — customer ${customerId} refused directly${ctx.configuredLoginCustomerId ? `, and via the configured manager ${ctx.configuredLoginCustomerId}` : ''}${discovered.length ? `, and via ${discovered.join(', ')}` : ''}. Check GOOGLE_CUSTOMER_ID and GOOGLE_LOGIN_CUSTOMER_ID, or re-authorise Google with a user who has access.`)
    }
  }
  if (ctx.loginCustomerId) console.log(`[google-ads-draft] using manager account ${ctx.loginCustomerId} for customer ${customerId}`)

  // Merchant Center id for Performance Max. When it isn't configured, read it
  // off a Shopping or PMax campaign that is already running — the account is a
  // better source of truth than an env var somebody has to keep in sync, and it
  // guarantees a new PMax campaign points at the same feed as the existing ones.
  if (!ctx.merchantId) {
    try {
      const linked = await gaql(ctx, `
        SELECT campaign.id, campaign.status,
               campaign.advertising_channel_type,
               campaign.shopping_setting.merchant_id,
               campaign.shopping_setting.feed_label
        FROM campaign
        WHERE campaign.advertising_channel_type IN ('SHOPPING', 'PERFORMANCE_MAX')
          AND campaign.status != 'REMOVED'
        ORDER BY campaign.id DESC
      `, 'merchant_id_discovery')

      // This account carries several merchant ids accumulated over the years,
      // most of them on long-paused campaigns whose links are dead. Prefer an
      // ENABLED campaign, then the most recently created one (campaign ids
      // ascend over time), so we land on the link that is actually current.
      const candidates = (linked as any[])
        .filter((r) => r.campaign?.shoppingSetting?.merchantId)
        .map((r) => ({
          id: String(r.campaign.shoppingSetting.merchantId),
          feedLabel: r.campaign.shoppingSetting.feedLabel ?? null,
          enabled: r.campaign.status === 'ENABLED',
          campaignId: Number(r.campaign.id ?? 0),
        }))
        .sort((a, b) => (Number(b.enabled) - Number(a.enabled)) || (b.campaignId - a.campaignId))

      if (candidates.length) {
        ctx.merchantId = candidates[0].id
        ctx.merchantFeedLabel = candidates[0].feedLabel
        ctx.merchantCandidates = [...new Set(candidates.map((c) => c.id))]
        console.log(`[google-ads-draft] merchant id ${ctx.merchantId} (feed ${ctx.merchantFeedLabel}) from campaign ${candidates[0].campaignId}, enabled=${candidates[0].enabled}; other ids seen: ${ctx.merchantCandidates.join(', ')}`)
      }
    } catch (e) {
      console.log('[google-ads-draft] merchant id discovery failed:', e instanceof Error ? e.message : e)
    }
  }
  const c = (rows as any[])[0]?.customer ?? {}
  ctx.descriptiveName = c.descriptiveName ?? null
  ctx.currency = c.currencyCode ?? 'unknown'
  ctx.timeZone = c.timeZone ?? 'Asia/Jerusalem'
  const status = c.conversionTrackingSetting?.conversionTrackingStatus ?? null
  ctx.conversionTrackingStatus = status
  // Anything other than NOT_CONVERSION_TRACKED means conversions are flowing
  // somewhere we can bid on — the precondition for the smart bidding strategies.
  ctx.conversionTrackingActive = !!status && status !== 'NOT_CONVERSION_TRACKED'

  return ctx
}

// ── Google API plumbing ──────────────────────────────────────────────────────

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

function apiHeaders(ctx: AdsContext): Record<string, string> {
  const h: Record<string, string> = {
    'Authorization': `Bearer ${ctx.accessToken}`,
    'developer-token': ctx.devToken,
    'Content-Type': 'application/json',
  }
  // Only needed when the account sits under a manager (MCC).
  if (ctx.loginCustomerId) h['login-customer-id'] = ctx.loginCustomerId
  return h
}

async function gaql(ctx: AdsContext, query: string, label: string): Promise<any[]> {
  const url = `${ADS_API}/customers/${ctx.customerId}/googleAds:search`
  const all: any[] = []
  let pageToken: string | undefined
  let pages = 0
  while (true) {
    const body: any = { query }
    if (pageToken) body.pageToken = pageToken
    const res = await fetch(url, { method: 'POST', headers: apiHeaders(ctx), body: JSON.stringify(body) })
    const raw = await res.text()
    let data: any
    try { data = JSON.parse(raw) }
    catch { throw new Error(`[${label}] non-JSON response (${res.status}): ${raw.slice(0, 200)}`) }
    if (data.error) throw new Error(`[${label}] ${googleErrorMessage(data.error)}`)
    if (Array.isArray(data.results)) all.push(...data.results)
    pageToken = data.nextPageToken
    pages++
    if (!pageToken || pages > 50) break
  }
  return all
}

// One atomic mutate. partialFailure stays false so Google applies all of the
// operations or none of them — a half-built campaign is never possible.
async function mutate(ctx: AdsContext, operations: any[], validateOnly: boolean): Promise<any> {
  const url = `${ADS_API}/customers/${ctx.customerId}/googleAds:mutate`
  const res = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(ctx),
    body: JSON.stringify({
      mutateOperations: operations,
      partialFailure: false,
      validateOnly,
      responseContentType: 'RESOURCE_NAME_ONLY',
    }),
  })
  const raw = await res.text()
  let data: any
  try { data = JSON.parse(raw) }
  catch { throw new Error(`mutate: non-JSON response (${res.status}): ${raw.slice(0, 300)}`) }
  if (data.error) throw new Error(`mutate: ${googleErrorMessage(data.error)}`)
  return data
}

// Google buries the useful part in error.details[].errors[]; the top-level
// message is usually just "Request contains an invalid argument."
function googleErrorMessage(error: any): string {
  const parts: string[] = []
  for (const d of error?.details ?? []) {
    for (const e of d?.errors ?? []) {
      const code = e.errorCode ? Object.values(e.errorCode).join('/') : ''
      const field = (e.location?.fieldPathElements ?? [])
        .map((f: any) => f.fieldName + (f.index != null ? `[${f.index}]` : ''))
        .join('.')
      parts.push([code, field, e.message].filter(Boolean).join(' @ '))
    }
  }
  if (!parts.length) return String(error?.message ?? JSON.stringify(error)).slice(0, 500)
  return parts.join(' | ').slice(0, 900)
}

// Every customer the OAuth user can reach, as bare ids. Unlike every other
// call this one takes no customer in the path, so it works even when the
// configured customer is unreachable — which is exactly when we need it.
async function listAccessibleCustomers(ctx: AdsContext): Promise<string[]> {
  const res = await fetch(`${ADS_API}/customers:listAccessibleCustomers`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${ctx.accessToken}`, 'developer-token': ctx.devToken },
  })
  const data = await res.json().catch(() => ({}))
  if (data.error) throw new Error(`listAccessibleCustomers: ${googleErrorMessage(data.error)}`)
  return ((data.resourceNames ?? []) as string[]).map((rn) => rn.split('/').pop() ?? '').filter(Boolean)
}

// Resolve a campaign reference to a real {id, name}. The strategist naturally
// reaches for the campaign NAME it just read in a performance report, and an
// unchecked Number() on that yields NaN — which produced a malformed query and,
// worse, invited the model to guess a numeric id instead. A guessed id can land
// on a REAL but unintended campaign and validate clean. So: accept a name or an
// id, verify it exists, refuse anything ambiguous, and always hand the caller
// back the name so the campaign being changed is visible in the tool result.
async function resolveCampaign(ctx: AdsContext, ref: string): Promise<{ id: string; name: string }> {
  const raw = String(ref ?? '').trim()
  if (!raw) throw new Error("'campaign_id' is required")

  if (/^\d+$/.test(raw)) {
    const rows = await gaql(ctx, `
      SELECT campaign.id, campaign.name FROM campaign
      WHERE campaign.id = ${raw} AND campaign.status != 'REMOVED'
    `, 'resolve_campaign_by_id')
    const hit = (rows as any[])[0]?.campaign
    if (!hit) throw new Error(`no campaign with id ${raw} on this account — take the id from get_google_campaign_performance rather than guessing it`)
    return { id: String(hit.id), name: hit.name ?? '' }
  }

  // Not numeric: treat it as a name. Exact match wins; otherwise refuse rather
  // than picking one of several partial matches.
  const escaped = raw.replace(/'/g, "\\'")
  const rows = await gaql(ctx, `
    SELECT campaign.id, campaign.name FROM campaign
    WHERE campaign.status != 'REMOVED' AND campaign.name = '${escaped}'
  `, 'resolve_campaign_by_name')
  const exact = (rows as any[]).map((r) => r.campaign).filter(Boolean)
  if (exact.length === 1) return { id: String(exact[0].id), name: exact[0].name }
  if (exact.length > 1) {
    throw new Error(`"${raw}" matches ${exact.length} campaigns (${exact.map((c: any) => c.id).join(', ')}) — pass the numeric campaign_id instead`)
  }
  throw new Error(`no campaign named "${raw}" on this account. Pass the numeric campaign_id from get_google_campaign_performance.`)
}

async function campaignExists(ctx: AdsContext, campaignId: string): Promise<boolean> {
  if (!campaignId) return false
  try {
    const rows = await gaql(ctx, `
      SELECT campaign.id FROM campaign
      WHERE campaign.id = ${Number(campaignId)} AND campaign.status != 'REMOVED'
    `, 'campaign_exists')
    return rows.length > 0
  } catch { return false }
}

async function accountChannelTypes(ctx: AdsContext): Promise<string[]> {
  try {
    const rows = await gaql(ctx, `
      SELECT campaign.advertising_channel_type FROM campaign
      WHERE campaign.status != 'REMOVED'
    `, 'channel_types')
    return [...new Set((rows as any[]).map((r) => r.campaign?.advertisingChannelType).filter(Boolean))]
  } catch { return [] }
}

async function accountSpend(ctx: AdsContext, since: string, until: string): Promise<number> {
  const rows = await gaql(ctx, `
    SELECT metrics.cost_micros FROM customer
    WHERE segments.date BETWEEN '${since}' AND '${until}'
  `, 'account_spend')
  let micros = 0
  for (const r of rows as any[]) micros += Number(r.metrics?.costMicros ?? 0)
  return microsToIls(micros) ?? 0
}

// ── Operation builders ───────────────────────────────────────────────────────

interface BuiltOperations {
  operations: any[]
  warnings: string[]
  campaignType: 'SEARCH' | 'PERFORMANCE_MAX'
}

async function buildOperations(ctx: AdsContext, spec: any, ideaId: string): Promise<BuiltOperations> {
  const type = String(spec.campaign_type ?? 'search').toLowerCase()
  if (type === 'performance_max' || type === 'pmax') return await buildPerformanceMax(ctx, spec, ideaId)
  if (type === 'search') return buildSearch(ctx, spec, ideaId)
  throw new Error(`unsupported campaign_type "${spec.campaign_type}" — use "search" or "performance_max"`)
}

// Temp resource names are negative ids that later operations reference. Google
// resolves them within the single mutate.
const TMP = {
  budget: -1,
  campaign: -2,
  adGroup: -3,
  assetGroup: -4,
  assetBase: -100,   // text + image assets count upward from here
}

function buildSearch(ctx: AdsContext, spec: any, ideaId: string): BuiltOperations {
  const warnings: string[] = []
  const cid = ctx.customerId
  const name = String(spec.campaign_name ?? 'Untitled').slice(0, 255)
  const daily = Number(spec.daily_budget_ils ?? 60)

  const utm = buildUtm(spec.tracking, ideaId)
  const finalUrl = appendUtm(spec.landing_page_url, utm)

  const { strategy, strategyWarning } = pickBiddingStrategy(ctx, spec, 'SEARCH')
  if (strategyWarning) warnings.push(strategyWarning)

  const ops: any[] = []

  ops.push({
    campaignBudgetOperation: {
      create: {
        resourceName: `customers/${cid}/campaignBudgets/${TMP.budget}`,
        name: `${name} — budget ${Date.now()}`.slice(0, 255),
        amountMicros: ilsToMicros(daily),
        deliveryMethod: 'STANDARD',
        explicitlyShared: false,
      },
    },
  })

  ops.push({
    campaignOperation: {
      create: {
        resourceName: `customers/${cid}/campaigns/${TMP.campaign}`,
        name,
        status: 'PAUSED',
        advertisingChannelType: 'SEARCH',
        campaignBudget: `customers/${cid}/campaignBudgets/${TMP.budget}`,
        // Required on every campaign since v24 (EU political advertising
        // regulation). Minuto sells coffee, so this is always a flat no.
        containsEuPoliticalAdvertising: NOT_POLITICAL,
        ...strategy,
        // Search + search partners, but never the Display network: Display on a
        // Search campaign spends the budget on low-intent placements.
        networkSettings: {
          targetGoogleSearch: true,
          targetSearchNetwork: spec.search_partners !== false,
          targetContentNetwork: false,
          targetPartnerSearchNetwork: false,
        },
      },
    },
  })

  // Geo + language live on the campaign as criteria.
  for (const geo of geoConstants(spec)) {
    ops.push({
      campaignCriterionOperation: {
        create: { campaign: `customers/${cid}/campaigns/${TMP.campaign}`, location: { geoTargetConstant: geo } },
      },
    })
  }
  for (const lang of languageConstants(spec)) {
    ops.push({
      campaignCriterionOperation: {
        create: { campaign: `customers/${cid}/campaigns/${TMP.campaign}`, language: { languageConstant: lang } },
      },
    })
  }
  for (const neg of asStringArray(spec.negative_keywords)) {
    ops.push({
      campaignCriterionOperation: {
        create: {
          campaign: `customers/${cid}/campaigns/${TMP.campaign}`,
          negative: true,
          keyword: { text: neg, matchType: 'BROAD' },
        },
      },
    })
  }

  const adGroup: any = {
    resourceName: `customers/${cid}/adGroups/${TMP.adGroup}`,
    name: String(spec.ad_group_name ?? `${name} — ad group`).slice(0, 255),
    campaign: `customers/${cid}/campaigns/${TMP.campaign}`,
    status: 'PAUSED',
    type: 'SEARCH_STANDARD',
  }
  // A CPC bid is only meaningful under manual bidding; setting it alongside a
  // smart strategy makes Google reject the ad group as incompatible.
  if (strategy.manualCpc) adGroup.cpcBidMicros = ilsToMicros(Number(spec.cpc_bid_ils ?? 4))
  ops.push({ adGroupOperation: { create: adGroup } })

  const keywords = asStringArray(spec.keywords)
  if (!keywords.length) throw new Error('a Search campaign needs at least one keyword — pass spec.keywords')
  const matchType = normalizeMatchType(spec.match_type ?? 'PHRASE')
  for (const kw of keywords) {
    ops.push({
      adGroupCriterionOperation: {
        create: {
          adGroup: `customers/${cid}/adGroups/${TMP.adGroup}`,
          status: 'ENABLED',
          keyword: { text: kw, matchType },
        },
      },
    })
  }

  // Responsive Search Ad. Google requires 3-15 headlines and 2-4 descriptions;
  // anything outside that is a hard rejection, so pad/trim and say so.
  const headlines = fitTexts(asStringArray(spec.creative?.headlines), RSA_HEADLINE_MAX, warnings, 'headline')
  const descriptions = fitTexts(asStringArray(spec.creative?.descriptions), RSA_DESCRIPTION_MAX, warnings, 'description')
  if (headlines.length < 3) throw new Error(`a Responsive Search Ad needs at least 3 headlines of ≤${RSA_HEADLINE_MAX} chars — got ${headlines.length}`)
  if (descriptions.length < 2) throw new Error(`a Responsive Search Ad needs at least 2 descriptions of ≤${RSA_DESCRIPTION_MAX} chars — got ${descriptions.length}`)
  if (headlines.length > 15) { warnings.push(`trimmed ${headlines.length} headlines to Google's maximum of 15`); headlines.length = 15 }
  if (descriptions.length > 4) { warnings.push(`trimmed ${descriptions.length} descriptions to Google's maximum of 4`); descriptions.length = 4 }

  const rsa: any = {
    headlines: headlines.map((text) => ({ text })),
    descriptions: descriptions.map((text) => ({ text })),
  }
  // Display-path segments shown after the domain; ≤15 chars each.
  if (spec.creative?.path1) rsa.path1 = String(spec.creative.path1).slice(0, 15)
  if (spec.creative?.path2) rsa.path2 = String(spec.creative.path2).slice(0, 15)

  ops.push({
    adGroupAdOperation: {
      create: {
        adGroup: `customers/${cid}/adGroups/${TMP.adGroup}`,
        status: 'PAUSED',
        ad: { finalUrls: [finalUrl], responsiveSearchAd: rsa },
      },
    },
  })

  return { operations: ops, warnings, campaignType: 'SEARCH' }
}

async function buildPerformanceMax(ctx: AdsContext, spec: any, ideaId: string): Promise<BuiltOperations> {
  const warnings: string[] = []
  const cid = ctx.customerId
  const name = String(spec.campaign_name ?? 'Untitled').slice(0, 255)
  const daily = Number(spec.daily_budget_ils ?? 60)

  // Performance Max only runs on value/conversion bidding, which needs
  // conversion tracking. Fail here with an explanation rather than letting
  // Google return an opaque bidding-strategy error.
  if (!ctx.conversionTrackingActive) {
    throw new Error(`Performance Max requires conversion tracking, but the account reports conversion_tracking_status=${ctx.conversionTrackingStatus ?? 'unknown'}. Set up conversion tracking in Google Ads first, or build a Search campaign instead.`)
  }

  const utm = buildUtm(spec.tracking, ideaId)
  const finalUrl = appendUtm(spec.landing_page_url, utm)

  const { strategy, strategyWarning } = pickBiddingStrategy(ctx, spec, 'PERFORMANCE_MAX')
  if (strategyWarning) warnings.push(strategyWarning)

  const ops: any[] = []

  ops.push({
    campaignBudgetOperation: {
      create: {
        resourceName: `customers/${cid}/campaignBudgets/${TMP.budget}`,
        name: `${name} — budget ${Date.now()}`.slice(0, 255),
        amountMicros: ilsToMicros(daily),
        deliveryMethod: 'STANDARD',
        explicitlyShared: false,
      },
    },
  })

  const campaign: any = {
    resourceName: `customers/${cid}/campaigns/${TMP.campaign}`,
    name,
    status: 'PAUSED',
    advertisingChannelType: 'PERFORMANCE_MAX',
    campaignBudget: `customers/${cid}/campaignBudgets/${TMP.budget}`,
    containsEuPoliticalAdvertising: NOT_POLITICAL,
    ...strategy,
  }
  // Final-URL expansion lets Google send traffic to pages nobody picked. v24
  // exposes no campaign field for it, so it cannot be set here — say so rather
  // than let the owner assume the destination is pinned.
  warnings.push('final URL expansion cannot be set through the API on this version — check "Final URL expansion" in the Google Ads UI before enabling this campaign, or it may send traffic to pages you did not choose')
  // Attaching the Merchant Center feed is what makes PMax a retail campaign
  // rather than a plain asset-group campaign.
  const merchantId = String(spec.merchant_id ?? ctx.merchantId ?? '').trim()
  if (merchantId) {
    campaign.shoppingSetting = { merchantId }
    const feedLabel = spec.feed_label ?? ctx.merchantFeedLabel
    if (feedLabel) campaign.shoppingSetting.feedLabel = String(feedLabel)
  } else {
    warnings.push('no Merchant Center id (spec.merchant_id / GOOGLE_MERCHANT_ID) — building an asset-group-only PMax campaign with no product feed')
  }
  ops.push({ campaignOperation: { create: campaign } })

  for (const geo of geoConstants(spec)) {
    ops.push({
      campaignCriterionOperation: {
        create: { campaign: `customers/${cid}/campaigns/${TMP.campaign}`, location: { geoTargetConstant: geo } },
      },
    })
  }
  for (const lang of languageConstants(spec)) {
    ops.push({
      campaignCriterionOperation: {
        create: { campaign: `customers/${cid}/campaigns/${TMP.campaign}`, language: { languageConstant: lang } },
      },
    })
  }

  // Asset group — PMax has no ad groups; assets hang off this instead.
  ops.push({
    assetGroupOperation: {
      create: {
        resourceName: `customers/${cid}/assetGroups/${TMP.assetGroup}`,
        campaign: `customers/${cid}/campaigns/${TMP.campaign}`,
        name: String(spec.asset_group_name ?? `${name} — assets`).slice(0, 255),
        finalUrls: [finalUrl],
        status: 'PAUSED',
      },
    },
  })

  // ── Text assets ──
  const headlines = fitTexts(asStringArray(spec.creative?.headlines), RSA_HEADLINE_MAX, warnings, 'headline')
  const longHeadlines = fitTexts(asStringArray(spec.creative?.long_headlines), PMAX_LONG_HEADLINE_MAX, warnings, 'long headline')
  const descriptions = fitTexts(asStringArray(spec.creative?.descriptions), RSA_DESCRIPTION_MAX, warnings, 'description')
  const businessName = String(spec.creative?.business_name ?? 'Minuto').slice(0, PMAX_BUSINESS_NAME_MAX)

  if (headlines.length < 3) throw new Error(`Performance Max needs at least 3 headlines of ≤${RSA_HEADLINE_MAX} chars — got ${headlines.length}`)
  if (!longHeadlines.length) throw new Error(`Performance Max needs at least 1 long headline of ≤${PMAX_LONG_HEADLINE_MAX} chars`)
  if (descriptions.length < 2) throw new Error(`Performance Max needs at least 2 descriptions of ≤${RSA_DESCRIPTION_MAX} chars — got ${descriptions.length}`)
  // Undocumented in the asset-requirements table but enforced by the API: an
  // asset group must carry at least one SHORT description. Without it Google
  // rejects the group as incomplete, confusingly reporting NOT_ENOUGH errors
  // for headlines too.
  if (!descriptions.some((d) => d.length <= PMAX_SHORT_DESCRIPTION_MAX)) {
    throw new Error(`Performance Max needs at least one SHORT description of ≤${PMAX_SHORT_DESCRIPTION_MAX} characters in addition to the longer ones. The shortest supplied is ${Math.min(...descriptions.map((d) => d.length))} chars.`)
  }
  if (headlines.length > 15) { warnings.push(`trimmed ${headlines.length} headlines to Google's maximum of 15`); headlines.length = 15 }
  if (longHeadlines.length > 5) { warnings.push(`trimmed ${longHeadlines.length} long headlines to Google's maximum of 5`); longHeadlines.length = 5 }
  if (descriptions.length > 5) { warnings.push(`trimmed ${descriptions.length} descriptions to Google's maximum of 5`); descriptions.length = 5 }

  // ORDER MATTERS. Google counts the assets already present in the request
  // when it validates the asset group at each link operation, so interleaving
  // create-then-link pairs makes the group look empty at the first link and
  // fails the whole mutate with NOT_ENOUGH_* for every asset type. The official
  // sample emits every Asset operation first, then every link. These three
  // buckets are concatenated in that order at the end.
  const assetOps: any[] = []
  const linkOps: any[] = []
  const campaignAssetOps: any[] = []

  let tmpAsset = TMP.assetBase
  const link = (assetTmp: number, fieldType: string) => {
    linkOps.push({
      assetGroupAssetOperation: {
        create: {
          assetGroup: `customers/${cid}/assetGroups/${TMP.assetGroup}`,
          asset: `customers/${cid}/assets/${assetTmp}`,
          fieldType,
        },
      },
    })
  }
  // Brand Guidelines (a PMax setting, ENABLED on this account) moves the
  // business name and the square logo off the asset group and onto the
  // CAMPAIGN — and it is exclusive: linking them at asset-group level too is
  // rejected with BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL. With it disabled
  // the opposite holds, hence the switch rather than a constant.
  const brandGuidelines = spec.brand_guidelines !== false
  const linkCampaign = (assetTmp: number, fieldType: string) => {
    campaignAssetOps.push({
      campaignAssetOperation: {
        create: {
          campaign: `customers/${cid}/campaigns/${TMP.campaign}`,
          asset: `customers/${cid}/assets/${assetTmp}`,
          fieldType,
        },
      },
    })
  }
  const addText = (text: string, fieldType: string, skipGroupLink = false) => {
    const rn = tmpAsset--
    assetOps.push({
      assetOperation: {
        create: { resourceName: `customers/${cid}/assets/${rn}`, textAsset: { text } },
      },
    })
    if (!skipGroupLink) link(rn, fieldType)
    return rn
  }
  // Brand assets go to exactly ONE level, whichever the Brand Guidelines
  // setting dictates.
  const addBrandAsset = (rn: number, fieldType: string) => {
    if (brandGuidelines) linkCampaign(rn, fieldType)
    else link(rn, fieldType)
  }

  for (const h of headlines) addText(h, 'HEADLINE')
  for (const h of longHeadlines) addText(h, 'LONG_HEADLINE')
  for (const d of descriptions) addText(d, 'DESCRIPTION')
  addBrandAsset(addText(businessName, 'BUSINESS_NAME', brandGuidelines), 'BUSINESS_NAME')

  // ── Image assets ──
  // Google's minimum viable PMax asset set is one 1:1 logo, one 1.91:1
  // marketing image and one 1:1 square marketing image. We validate the real
  // pixel dimensions before upload so a wrong-shaped product photo produces a
  // sentence the owner can act on, not a raw API error.
  const imageSlots: Array<{ key: string; fieldType: string; ratio: number; minW: number; minH: number; label: string }> = [
    { key: 'logo_url', fieldType: 'LOGO', ratio: 1, minW: 128, minH: 128, label: 'logo (1:1, min 128×128)' },
    { key: 'marketing_image_url', fieldType: 'MARKETING_IMAGE', ratio: 1.91, minW: 600, minH: 314, label: 'marketing image (1.91:1, min 600×314)' },
    { key: 'square_marketing_image_url', fieldType: 'SQUARE_MARKETING_IMAGE', ratio: 1, minW: 300, minH: 300, label: 'square marketing image (1:1, min 300×300)' },
  ]

  const missing: string[] = []
  for (const slot of imageSlots) {
    const url = spec.creative?.[slot.key]
    if (!url) { missing.push(slot.label); continue }
    const fetched = await fetchImage(String(url))
    const dims = imageDimensions(fetched.bytes)
    if (!dims) {
      warnings.push(`could not read the dimensions of ${slot.key} (${fetched.contentType || 'unknown type'}) — uploading unvalidated; Google may reject it`)
    } else {
      const actual = dims.width / dims.height
      if (Math.abs(actual - slot.ratio) > 0.05) {
        throw new Error(`${slot.key} is ${dims.width}×${dims.height} (ratio ${actual.toFixed(2)}:1) but Google requires ${slot.label}. Crop it or supply a different image.`)
      }
      if (dims.width < slot.minW || dims.height < slot.minH) {
        throw new Error(`${slot.key} is ${dims.width}×${dims.height}, below Google's minimum for a ${slot.label}.`)
      }
    }
    const rn = tmpAsset--
    assetOps.push({
      assetOperation: {
        create: {
          resourceName: `customers/${cid}/assets/${rn}`,
          name: `${slug(ideaId)}_${slot.fieldType.toLowerCase()}_${Date.now()}`.slice(0, 120),
          imageAsset: { data: encodeBase64(fetched.bytes) },
        },
      },
    })
    if (slot.fieldType === 'LOGO') addBrandAsset(rn, 'LOGO')
    else link(rn, slot.fieldType)
  }
  if (missing.length) {
    // The Google Ads help centre says a retail campaign generates the minimum
    // asset set from the product feed. That is NOT true of the API path: a
    // create with a Merchant Center feed attached and no marketing image was
    // still rejected with NOT_ENOUGH_MARKETING_IMAGE_ASSET. These are hard
    // requirements whether or not a feed is present.
    throw new Error(`Performance Max needs image assets that Google will not generate for an API-created asset group, feed or no feed. Missing: ${missing.join('; ')}. Pass them as creative.logo_url / creative.marketing_image_url / creative.square_marketing_image_url.`)
  }

  // ── Listing group filter ──
  // With a Merchant Center feed attached, the asset group must say which
  // products it covers. A single root UNIT_INCLUDED node means "all products".
  // Assets, then links, then campaign-level brand assets — see the ordering
  // note above.
  ops.push(...assetOps, ...linkOps, ...campaignAssetOps)

  if (merchantId) {
    ops.push({
      assetGroupListingGroupFilterOperation: {
        create: {
          assetGroup: `customers/${cid}/assetGroups/${TMP.assetGroup}`,
          type: 'UNIT_INCLUDED',
          listingSource: 'SHOPPING',
        },
      },
    })
  }

  return { operations: ops, warnings, campaignType: 'PERFORMANCE_MAX' }
}

// ── Bidding ──────────────────────────────────────────────────────────────────

// Smart bidding needs conversion data to bid on. When the account has none,
// a Search campaign silently degrades to manual CPC with a warning rather
// than failing; Performance Max cannot degrade and is rejected earlier.
function pickBiddingStrategy(
  ctx: AdsContext, spec: any, channel: 'SEARCH' | 'PERFORMANCE_MAX',
): { strategy: any; strategyWarning: string | null } {
  const asked = String(spec.bidding_strategy ?? '').toLowerCase()
  const targetRoas = Number(spec.target_roas ?? 0)
  const targetCpaIls = Number(spec.target_cpa_ils ?? 0)

  if (channel === 'PERFORMANCE_MAX') {
    if (asked === 'maximize_conversions' || targetCpaIls > 0) {
      const s: any = { maximizeConversions: {} }
      if (targetCpaIls > 0) s.maximizeConversions.targetCpaMicros = ilsToMicros(targetCpaIls)
      return { strategy: s, strategyWarning: null }
    }
    const s: any = { maximizeConversionValue: {} }
    if (targetRoas > 0) s.maximizeConversionValue.targetRoas = targetRoas
    return { strategy: s, strategyWarning: null }
  }

  if (asked === 'manual_cpc') return { strategy: { manualCpc: { enhancedCpcEnabled: false } }, strategyWarning: null }
  if (asked === 'maximize_clicks') return { strategy: { targetSpend: {} }, strategyWarning: null }

  if (!ctx.conversionTrackingActive) {
    return {
      strategy: { manualCpc: { enhancedCpcEnabled: false } },
      strategyWarning: `account reports conversion_tracking_status=${ctx.conversionTrackingStatus ?? 'unknown'}, so conversion-based bidding is unavailable — fell back to manual CPC`,
    }
  }
  if (asked === 'maximize_conversion_value' || targetRoas > 0) {
    const s: any = { maximizeConversionValue: {} }
    if (targetRoas > 0) s.maximizeConversionValue.targetRoas = targetRoas
    return { strategy: s, strategyWarning: null }
  }
  const s: any = { maximizeConversions: {} }
  if (targetCpaIls > 0) s.maximizeConversions.targetCpaMicros = ilsToMicros(targetCpaIls)
  return { strategy: s, strategyWarning: null }
}

// ── Images ───────────────────────────────────────────────────────────────────

async function fetchImage(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`could not fetch image ${url} (HTTP ${res.status})`)
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get('content-type'),
  }
}

// Minimal PNG/JPEG header parsing — enough to check Google's aspect-ratio and
// minimum-size rules before we upload. Returns null for formats we can't read,
// in which case the caller uploads unvalidated and warns.
function imageDimensions(b: Uint8Array): { width: number; height: number } | null {
  // PNG: 8-byte signature, then the IHDR chunk whose width/height are the two
  // big-endian uint32s at offsets 16 and 20.
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    return { width: dv.getUint32(16), height: dv.getUint32(20) }
  }
  // JPEG: walk the marker segments to the first Start-Of-Frame, which carries
  // height then width as big-endian uint16s.
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const marker = b[i + 1]
      // SOF0-SOF3 / SOF5-SOF7 / SOF9-SOF11 / SOF13-SOF15 carry the dimensions.
      const isSof = marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      const segLength = (b[i + 2] << 8) | b[i + 3]
      if (isSof) {
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] }
      }
      if (segLength <= 0) break
      i += 2 + segLength
    }
  }
  return null
}

// ── Small helpers ────────────────────────────────────────────────────────────

function dailyCap(): number { return Number(Deno.env.get('GOOGLE_MAX_DAILY_BUDGET_ILS') ?? 100) }
function monthlyCap(): number { return Number(Deno.env.get('GOOGLE_MONTHLY_BUDGET_ILS') ?? 3500) }

function ilsToMicros(ils: number): string { return String(Math.round(ils * 1_000_000)) }
function microsToIls(micros: unknown): number | null {
  if (micros == null) return null
  return Number(micros) / 1_000_000
}
function round2(n: number): number { return Math.round(n * 100) / 100 }

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string' && v.trim()) return [v.trim()]
  return []
}

function normalizeMatchType(v: unknown): 'EXACT' | 'PHRASE' | 'BROAD' {
  const s = String(v ?? '').toUpperCase()
  return s === 'EXACT' || s === 'BROAD' ? s : 'PHRASE'
}

// Google counts characters, and Hebrew copy runs long. Truncating silently
// would ship a half-sentence headline, so each trim is reported.
function fitTexts(texts: string[], max: number, warnings: string[], label: string): string[] {
  const out: string[] = []
  for (const t of texts) {
    if (t.length > max) {
      warnings.push(`${label} over ${max} chars, truncated: "${t}"`)
      out.push(t.slice(0, max).trim())
    } else out.push(t)
  }
  return out
}

function geoConstants(spec: any): string[] {
  const given = asStringArray(spec.geo_target_constants)
  if (!given.length) return [GEO_ISRAEL]
  return given.map((g) => (g.startsWith('geoTargetConstants/') ? g : `geoTargetConstants/${g}`))
}

function languageConstants(spec: any): string[] {
  const given = asStringArray(spec.language_constants)
  if (!given.length) return [LANG_HEBREW, LANG_ENGLISH]
  return given.map((l) => (l.startsWith('languageConstants/') ? l : `languageConstants/${l}`))
}

function buildUtm(tracking: any, ideaId: string): Record<string, string> {
  return {
    utm_source: String(tracking?.utm_source ?? 'google'),
    utm_medium: String(tracking?.utm_medium ?? 'cpc'),
    utm_campaign: String(tracking?.utm_campaign ?? slug(ideaId)),
    utm_content: String(tracking?.utm_content ?? 'draft'),
  }
}

function appendUtm(url: any, utm: Record<string, string>): string {
  // The spec's landing_page_url can arrive messy — the model sometimes packs
  // commentary or several URLs into it. Take the FIRST clean http(s) URL, drop
  // any existing query/hash and trailing punctuation, then append our UTM.
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

// A mutate response is a positional array of per-operation results; each entry
// is keyed by the operation kind it came from.
function collectCreatedIds(result: any): {
  campaignId: string | null; budgetId: string | null
  adGroupId: string | null; adId: string | null; assetGroupId: string | null
} {
  const out = { campaignId: null, budgetId: null, adGroupId: null, adId: null, assetGroupId: null } as any
  const idOf = (rn: unknown): string | null => {
    const s = String(rn ?? '')
    const m = s.match(/\/([^/~]+)(?:~([^/]+))?$/)
    if (!m) return null
    return m[2] ?? m[1]
  }
  for (const r of result?.mutateOperationResponses ?? []) {
    if (r.campaignResult?.resourceName && !out.campaignId) out.campaignId = idOf(r.campaignResult.resourceName)
    if (r.campaignBudgetResult?.resourceName && !out.budgetId) out.budgetId = idOf(r.campaignBudgetResult.resourceName)
    if (r.adGroupResult?.resourceName && !out.adGroupId) out.adGroupId = idOf(r.adGroupResult.resourceName)
    if (r.adGroupAdResult?.resourceName && !out.adId) out.adId = idOf(r.adGroupAdResult.resourceName)
    if (r.assetGroupResult?.resourceName && !out.assetGroupId) out.assetGroupId = idOf(r.assetGroupResult.resourceName)
  }
  return out
}

function adsUiUrl(customerId: string, campaignId: string): string {
  return `https://ads.google.com/aw/campaigns?campaignId=${campaignId}&__c=${customerId}`
}

// ── Date ranges ──────────────────────────────────────────────────────────────

// Google reports in the ACCOUNT's timezone, so month boundaries and "today"
// have to be computed there rather than in UTC or in the worker's local time.
function todayInZone(timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const [y, m, d] = parts.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
const shiftDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000)

function monthToDateRange(timeZone: string): [string, string] {
  const today = todayInZone(timeZone)
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
  return [iso(first), iso(today)]
}

function lastMonthRange(timeZone: string): [string, string] {
  const today = todayInZone(timeZone)
  const firstThis = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
  const lastPrev = shiftDays(firstThis, -1)
  const firstPrev = new Date(Date.UTC(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth(), 1))
  return [iso(firstPrev), iso(lastPrev)]
}

function presetRange(preset: string, timeZone: string): [string, string] {
  const today = todayInZone(timeZone)
  const back = (n: number): [string, string] => [iso(shiftDays(today, -n)), iso(shiftDays(today, -1))]
  switch (preset) {
    case 'today': return [iso(today), iso(today)]
    case 'yesterday': return [iso(shiftDays(today, -1)), iso(shiftDays(today, -1))]
    case 'last_3d': return back(3)
    case 'last_14d': return back(14)
    case 'last_30d': return back(30)
    case 'last_90d': return back(90)
    case 'this_month': return monthToDateRange(timeZone)
    case 'last_month': return lastMonthRange(timeZone)
    default: return back(7)
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
