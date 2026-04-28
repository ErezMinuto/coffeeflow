/**
 * CoffeeFlow — Email Automation Scheduler
 *
 * Hourly cron + manual-trigger endpoint that runs the trigger-based email
 * automations defined in `email_automation_templates`. Phase 1 supports
 * `first_purchase`: send a welcome email with a unique 10% off coupon to
 * every customer N days after their first paid order.
 *
 * Why this exists separately from generate-campaign:
 *   generate-campaign blasts one campaign to many recipients. Automations
 *   are 1:1 trigger-driven sends with per-customer personalization (unique
 *   coupons, order-context). The flows are different enough that mixing
 *   them in one function would have produced spaghetti.
 *
 * Endpoints (POST body controls behavior):
 *   {} or {trigger:"cron"} — process all due automations (default cron call)
 *   {dry_run: true}        — find candidates + log them, no sends, no inserts
 *   {test_send: "email@x"} — send the welcome email to one specific address,
 *                             generates a real coupon, useful for QA
 *
 * Idempotency:
 *   Each (trigger_type, customer_email) is unique in `email_automations`.
 *   Re-runs of the cron skip already-processed customers.
 *
 * Failure semantics:
 *   - Coupon creation fails → row marked 'failed', no email sent (don't
 *     send broken coupon codes)
 *   - Resend send fails → row marked 'failed', error_msg stored
 *   - Migration not applied → 500 with clear error so it's obvious
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPA_URL  = Deno.env.get('SUPABASE_URL')!
const SUPA_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? ''
const SENDER_EMAIL = Deno.env.get('SENDER_EMAIL') ?? 'info@minuto.co.il'
const WOO_URL = Deno.env.get('WOO_URL') ?? 'https://www.minuto.co.il'
const WOO_KEY = Deno.env.get('WOO_KEY') ?? ''
const WOO_SECRET = Deno.env.get('WOO_SECRET') ?? ''
// Reuses the unsubscribe handler that generate-campaign already implements.
// Same URL pattern means /generate-campaign?action=unsubscribe&email=...&token=...
// works regardless of which function sent the original email.
const UNSUBSCRIBE_BASE = Deno.env.get('UNSUBSCRIBE_BASE_URL') ?? `${SUPA_URL}/functions/v1/generate-campaign`
// Logo URL is a template variable so the owner can swap it without
// touching code. Default to a known-existing URL on the storefront if
// none is configured; owner can update via Supabase Table Editor.
const DEFAULT_LOGO_URL = Deno.env.get('MINUTO_LOGO_URL') ?? 'https://www.minuto.co.il/wp-content/uploads/2024/01/minuto-logo.png'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface AutomationTemplate {
  trigger_type: string
  display_name: string
  enabled: boolean
  delay_days: number
  max_lookback_days: number  // upper bound on order_date — prevents historical backlog blast
  subject_template: string
  body_html_template: string
  coupon_percent: number | null
  coupon_expiry_days: number
  // Slugs are the human-readable source-of-truth. IDs are the cached
  // resolution from the WC API. Both are kept on the row because:
  //   - admin reads/edits the slugs (they appear in URLs)
  //   - the system uses the IDs (stable across slug renames)
  // Cache miss (empty IDs array) triggers re-resolution from slugs.
  coupon_product_category_slugs: string[]
  coupon_product_category_ids: number[]
}

interface FirstOrderCandidate {
  customer_email: string
  customer_name: string | null
  woo_order_id: number
  order_date: string  // YYYY-MM-DD
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Renders {{ var }} placeholders in a template string. */
function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([\w_]+)\s*\}\}/g, (_, key) => {
    const v = vars[key]
    return v === undefined || v === null ? '' : String(v)
  })
}

/**
 * Same shape as generate-campaign's unsubscribe URL — base64-encoded
 * `email:timestamp` token. Lets the existing /generate-campaign
 * ?action=unsubscribe handler process opt-outs from automation emails
 * without us needing to duplicate the unsubscribe flow here.
 */
function generateUnsubscribeUrl(email: string): string {
  const token = btoa(`${email}:${Date.now()}`)
  return `${UNSUBSCRIBE_BASE}?action=unsubscribe&email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`
}

/**
 * Build a unique coupon code per customer email. Use a stable hash so
 * the same email always maps to the same code (idempotent if we have to
 * regenerate). Uppercase + dashes for readability — matches what the
 * customer sees on the checkout page.
 */
async function buildCouponCode(email: string): Promise<string> {
  const enc = new TextEncoder()
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(email))
  const hex = Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  // Take first 6 hex chars — collision risk negligible at our scale
  // (would need ~4M customers for >50% birthday collision).
  return `MINUTO-${hex.slice(0, 6).toUpperCase()}`
}

/**
 * Resolve WooCommerce product category slugs to numeric category IDs.
 * Pure resolution, no caching — caller owns persistence.
 */
async function resolveCategoryIdsFromSlugs(slugs: string[]): Promise<number[]> {
  if (slugs.length === 0) return []
  const auth = btoa(`${WOO_KEY}:${WOO_SECRET}`)
  const ids: number[] = []
  for (const slug of slugs) {
    const url = `${WOO_URL}/wp-json/wc/v3/products/categories?slug=${encodeURIComponent(slug)}`
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } })
    if (!res.ok) {
      console.warn(`[email-automation] category lookup failed (${slug}): ${res.status}`)
      continue
    }
    const arr = await res.json()
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0].id === 'number') {
      ids.push(arr[0].id)
    } else {
      console.warn(`[email-automation] no category found for slug "${slug}"`)
    }
  }
  return ids
}

/**
 * Cache-aware resolution. Reads IDs from the template row first; only
 * hits the WC API and writes back to the row when the cache is empty.
 *
 * Why this design (vs always resolving from slugs):
 *   - WC category IDs are stable across slug renames. The owner can
 *     rename "פולי-קפה-טרי-מינוטו-specialty-coffee" → anything else
 *     in WC admin and our cached ID still points to the same category.
 *   - Avoids hitting the WC API on every coupon creation.
 *
 * Cache invalidation: the owner clears `coupon_product_category_ids`
 * on the template row (UPDATE ... SET coupon_product_category_ids =
 * ARRAY[]::INT[]) when they restructure categories — typically rare.
 *
 * Failure mode: if the cache is empty AND slug resolution returns
 * zero IDs from a non-empty slug list, we throw. Creating a coupon
 * with no category restriction would silently leak the discount onto
 * grinders/machines, which is the exact behavior we're protecting
 * against. Better to fail loudly.
 */
async function resolveCategoryIdsCached(
  supabase: any,
  template: AutomationTemplate,
): Promise<number[]> {
  const slugs = template.coupon_product_category_slugs ?? []
  const cached = template.coupon_product_category_ids ?? []
  if (slugs.length === 0) return []                         // no restriction by design
  if (cached.length > 0) return cached                      // cache hit, trust it

  // Cache miss → resolve and write back.
  const resolved = await resolveCategoryIdsFromSlugs(slugs)
  if (resolved.length === 0) {
    throw new Error(`Could not resolve any category IDs from slugs ${JSON.stringify(slugs)}. Verify slugs match WooCommerce category slugs (Products → Categories in WP admin). Refusing to create an unrestricted coupon — this would let the discount apply to grinders/machines.`)
  }

  const { error } = await supabase
    .from('email_automation_templates')
    .update({ coupon_product_category_ids: resolved, updated_at: new Date().toISOString() })
    .eq('trigger_type', template.trigger_type)
  if (error) {
    // Cache write failure is non-fatal — we still got the IDs, future
    // runs will just re-resolve. Log and continue.
    console.warn(`[email-automation] failed to cache category IDs: ${error.message}`)
  } else {
    console.log(`[email-automation] cached category IDs for ${template.trigger_type}: ${JSON.stringify(resolved)}`)
  }
  return resolved
}

/**
 * Create a unique single-use 10% off coupon in WooCommerce, restricted
 * to the customer's email AND (optionally) to a list of product
 * categories. Returns the coupon code on success, throws with a
 * descriptive message on failure (caller logs and skips send).
 */
async function createCoupon(
  email: string,
  percent: number,
  expiryDays: number,
  productCategoryIds: number[],
): Promise<string> {
  if (!WOO_KEY || !WOO_SECRET) {
    throw new Error('WOO_KEY/WOO_SECRET not configured')
  }
  const code = await buildCouponCode(email)
  const expires = new Date(Date.now() + expiryDays * 86400_000)
    .toISOString().split('T')[0] // YYYY-MM-DD

  const auth = btoa(`${WOO_KEY}:${WOO_SECRET}`)
  const body: Record<string, any> = {
    code,
    discount_type: 'percent',
    amount: String(percent),
    individual_use: true,
    usage_limit: 1,
    usage_limit_per_user: 1,
    email_restrictions: [email.toLowerCase().trim()],
    date_expires: expires,
    description: `Welcome coupon for ${email} — auto-generated by CoffeeFlow email-automation-scheduler`,
  }
  // Allowlist: when set, the discount only applies to line items in
  // these categories. Coffee-only welcome coupons set this to the
  // specialty-coffee category id. Empty array = no restriction.
  if (productCategoryIds.length > 0) {
    body.product_categories = productCategoryIds
  }

  // POST to /wp-json/wc/v3/coupons with two important details:
  // 1. Auth via query string (?consumer_key=K&consumer_secret=S) instead
  //    of the Authorization header. Some WAF/CDN setups (Cloudflare,
  //    Wordfence) strip or alter Authorization headers on POSTs to
  //    /wp-json paths, leading to silent downgrade-to-GET behavior.
  //    Query-string auth bypasses that path.
  // 2. `redirect: 'manual'` so we DON'T silently follow a 301 that
  //    converts POST→GET. If WC is redirecting our POST, we want to
  //    SEE the redirect and fail loudly instead of getting a "list of
  //    coupons" GET response back and thinking everything's fine.
  const couponUrl = `${WOO_URL}/wp-json/wc/v3/coupons?consumer_key=${encodeURIComponent(WOO_KEY)}&consumer_secret=${encodeURIComponent(WOO_SECRET)}`
  const res = await fetch(couponUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  })

  const responseText = await res.text()
  console.log(`[email-automation] WC coupon POST → ${res.status} for ${code} (body ${responseText.length} chars): ${responseText.slice(0, 300)}`)

  // Caught a redirect — surface it so we know if WC is downgrading our
  // POST. Owner can fix at the WP/Cloudflare level once we see this.
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') || '(no location header)'
    throw new Error(`WC coupon POST redirected (${res.status}) to ${location}. This converts our POST to GET on the redirect target. Fix at the WP/Cloudflare level (likely trailing-slash or HTTP→HTTPS redirect rule).`)
  }

  // Parse JSON FIRST so the inner throw isn't swallowed by an outer catch.
  let parsed: any = null
  try { parsed = JSON.parse(responseText) } catch { /* parsed stays null */ }

  // Real success: a 2xx with an object that has both id and code.
  if (res.ok && parsed?.id && parsed?.code) {
    console.log(`[email-automation] coupon created: id=${parsed.id} code=${parsed.code}`)
    return code
  }

  // 400 with "already exists" is the idempotent-retry case.
  if (res.status === 400 && responseText.includes('coupon_code_already_exists')) {
    console.log(`[email-automation] coupon ${code} already exists, reusing`)
    return code
  }

  // 200 with an array body = our POST was treated as a GET (list coupons)
  // somewhere along the path. This is THE bug we found in the field.
  if (res.ok && Array.isArray(parsed)) {
    throw new Error(`WC returned a coupon LIST (${parsed.length} items) in response to our POST. Something between us and WC is converting POST→GET (likely Cloudflare or a WordPress redirect rule). The coupon was NOT created. First items: ${responseText.slice(0, 200)}`)
  }

  throw new Error(`Woo coupon API ${res.status} (parsed=${parsed ? 'object' : 'unparseable'}): ${responseText.slice(0, 300)}`)
}

/**
 * Send via Resend. Mirrors the format used by generate-campaign
 * (Minuto <SENDER_EMAIL>) so DKIM/SPF reputation accumulates on one
 * sender identity instead of being split across functions.
 *
 * The List-Unsubscribe header surfaces a native unsubscribe button
 * in Gmail / Outlook / Apple Mail. Recommended even for transactional
 * emails — recipients who hit it instead of marking spam protects
 * sender reputation.
 */
async function sendEmail(
  to: string, subject: string, html: string, unsubscribeUrl: string
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!RESEND_KEY) return { ok: false, error: 'RESEND_API_KEY not configured' }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Minuto <${SENDER_EMAIL}>`,
      to: [to],
      subject,
      html,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  })

  if (!res.ok) {
    const t = await res.text()
    return { ok: false, error: `Resend ${res.status}: ${t.slice(0, 300)}` }
  }
  const body = await res.json()
  return { ok: true, id: body?.id ?? '' }
}

// ── Trigger handlers ─────────────────────────────────────────────────────────

/**
 * Find first-time-purchase customers eligible for the welcome email.
 * "First-time" = customer's only order in woo_orders. "Eligible" =
 * order_date is older than `delay_days` AND we haven't processed them yet.
 *
 * Important: we use order_date, not synced_at — synced_at can lag if the
 * sync was paused and then catches up, which would cause delayed
 * triggers to fire all at once on the same day.
 */
async function findFirstPurchaseCandidates(
  supabase: any, delayDays: number, maxLookbackDays: number
): Promise<FirstOrderCandidate[]> {
  const upperCutoff = new Date(Date.now() - delayDays * 86400_000)
    .toISOString().split('T')[0]
  // Lower cutoff prevents the historical-backlog blast: when this trigger
  // is enabled for the first time, we only want to catch customers whose
  // first order was within the lookback window — not every first-time
  // customer ever recorded.
  const lowerCutoff = new Date(Date.now() - maxLookbackDays * 86400_000)
    .toISOString().split('T')[0]

  // Sanity check — if config is upside-down, log loudly and bail rather
  // than silently sending nothing forever.
  if (maxLookbackDays < delayDays) {
    console.warn(`[email-automation] max_lookback_days (${maxLookbackDays}) < delay_days (${delayDays}) — no orders can ever qualify. Fix the template.`)
    return []
  }

  // Two-step query because Postgres RPC for COUNT(*)=1 across a join
  // is hairier than just doing it in code:
  // 1. Pull paid orders with email whose order_date falls in the window
  //    [now - max_lookback_days, now - delay_days].
  // 2. Filter to customers with exactly 1 order ever (their first).
  const { data: orders, error } = await supabase
    .from('woo_orders')
    .select('woo_order_id, customer_email, order_date, status')
    .in('status', ['completed', 'processing'])
    .gte('order_date', lowerCutoff)
    .lte('order_date', upperCutoff)
    .not('customer_email', 'is', null)
    .order('order_date', { ascending: true })

  if (error) throw new Error(`woo_orders query: ${error.message}`)

  // Group by email — keep only customers with a single order, and that
  // order is on/before cutoff (eligible for the welcome flow).
  const byEmail = new Map<string, FirstOrderCandidate[]>()
  for (const o of (orders ?? [])) {
    const email = (o.customer_email ?? '').toLowerCase().trim()
    if (!email) continue
    if (!byEmail.has(email)) byEmail.set(email, [])
    byEmail.get(email)!.push({
      customer_email: email,
      customer_name: null,  // filled in later if needed; we don't have it on woo_orders
      woo_order_id: o.woo_order_id,
      order_date: o.order_date,
    })
  }

  // Also exclude customers who have ANY order after cutoff — they're not
  // first-time-buyers if they've placed multiple orders, even if only
  // the first qualifies on date.
  const { data: allOrders } = await supabase
    .from('woo_orders')
    .select('customer_email')
    .in('status', ['completed', 'processing'])
    .not('customer_email', 'is', null)

  const orderCount = new Map<string, number>()
  for (const o of (allOrders ?? [])) {
    const email = (o.customer_email ?? '').toLowerCase().trim()
    if (!email) continue
    orderCount.set(email, (orderCount.get(email) ?? 0) + 1)
  }

  const candidates: FirstOrderCandidate[] = []
  for (const [email, orders] of byEmail.entries()) {
    if ((orderCount.get(email) ?? 0) === 1) {
      candidates.push(orders[0])
    }
  }
  return candidates
}

/**
 * Process a single automation: check it's not already done, generate
 * coupon, render email, send via Resend, log result.
 */
async function processAutomation(
  supabase: any,
  template: AutomationTemplate,
  candidate: FirstOrderCandidate,
): Promise<{ status: string; error?: string; coupon?: string; resend_id?: string }> {
  // INSERT-as-lock pattern. Previously we did "check if row exists, then
  // do work, then insert" which has a race window: two concurrent runs
  // both pass the check, both send, only one wins the insert. Owner
  // explicitly asked to be sure customers can't get the email twice.
  //
  // Fix: insert a 'pending' row UP FRONT. The UNIQUE(trigger_type,
  // customer_email) constraint physically refuses the second concurrent
  // insert, so the loser gets a 23505 error and we bail before doing any
  // expensive (and externally-visible) work — coupon creation, email send.
  // Postgres's unique constraint is the lock; no application-level race.
  const insertPayload = {
    trigger_type: template.trigger_type,
    customer_email: candidate.customer_email,
    customer_name: candidate.customer_name,
    woo_order_id: candidate.woo_order_id,
    status: 'pending',
    scheduled_for: new Date().toISOString(),
  }
  const { data: insertedRow, error: insertErr } = await supabase
    .from('email_automations')
    .insert(insertPayload)
    .select('id')
    .single()

  if (insertErr) {
    // 23505 = unique_violation. That's the expected/safe outcome when a
    // row already exists for this customer — silently skip, this is the
    // duplicate-prevention working as intended.
    if (insertErr.code === '23505' || /duplicate key|unique constraint/i.test(insertErr.message ?? '')) {
      return { status: 'skipped', error: 'already processed (unique constraint)' }
    }
    // Any other DB error is unexpected — surface it.
    return { status: 'failed', error: `lock insert: ${insertErr.message}` }
  }

  const lockId = insertedRow.id

  // From here on, we own the lock. Do the work and update the same row.

  // Generate coupon. If it fails, mark the row 'failed' and bail.
  let couponCode: string
  try {
    const categoryIds = await resolveCategoryIdsCached(supabase, template)
    couponCode = await createCoupon(
      candidate.customer_email,
      template.coupon_percent ?? 10,
      template.coupon_expiry_days,
      categoryIds,
    )
  } catch (e: any) {
    await supabase.from('email_automations').update({
      status: 'failed',
      error_msg: `coupon: ${e.message}`,
    }).eq('id', lockId)
    return { status: 'failed', error: `coupon: ${e.message}` }
  }

  // Render subject + body. customer_name might be null — fall back to
  // a friendly default so the greeting still reads well.
  const firstName = (candidate.customer_name ?? 'חבר/ה').trim()
  const unsubscribeUrl = generateUnsubscribeUrl(candidate.customer_email)
  const vars = {
    first_name: firstName,
    coupon_code: couponCode,
    coupon_expiry_days: template.coupon_expiry_days,
    order_id: candidate.woo_order_id,
    unsubscribe_url: unsubscribeUrl,
    logo_url: DEFAULT_LOGO_URL,
  }
  const subject = renderTemplate(template.subject_template, vars)
  const html    = renderTemplate(template.body_html_template, vars)

  const sendResult = await sendEmail(candidate.customer_email, subject, html, unsubscribeUrl)

  if (!sendResult.ok) {
    await supabase.from('email_automations').update({
      coupon_code: couponCode,
      status: 'failed',
      error_msg: `resend: ${sendResult.error}`,
    }).eq('id', lockId)
    return { status: 'failed', error: `resend: ${sendResult.error}`, coupon: couponCode }
  }

  // Success path — UPDATE the same row from 'pending' to 'sent'.
  await supabase.from('email_automations').update({
    coupon_code: couponCode,
    status: 'sent',
    sent_at: new Date().toISOString(),
    resend_email_id: sendResult.id,
  }).eq('id', lockId)

  return { status: 'sent', coupon: couponCode, resend_id: sendResult.id }
}

// ── HTTP entry point ─────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabase = createClient(SUPA_URL, SUPA_KEY)

  let body: any = {}
  try { body = await req.json() } catch { /* default empty */ }

  const dryRun  = body.dry_run === true
  const testTo  = typeof body.test_send === 'string' ? body.test_send : null

  // ── Test-send path ─────────────────────────────────────────────────
  // Sends the first_purchase email to a specific address. Real coupon,
  // real send. Useful for QA and content review without waiting for a
  // real first-time customer to come in.
  if (testTo) {
    const { data: tmpl, error } = await supabase
      .from('email_automation_templates')
      .select('*')
      .eq('trigger_type', 'first_purchase')
      .maybeSingle()
    if (error || !tmpl) {
      return new Response(JSON.stringify({ error: 'first_purchase template not found' }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    try {
      const categoryIds = await resolveCategoryIdsCached(supabase, tmpl)
      const couponCode = await createCoupon(
        testTo,
        tmpl.coupon_percent ?? 10,
        tmpl.coupon_expiry_days,
        categoryIds,
      )
      const unsubscribeUrl = generateUnsubscribeUrl(testTo)
      const vars = {
        first_name: 'בוחן',
        coupon_code: couponCode,
        coupon_expiry_days: tmpl.coupon_expiry_days,
        order_id: 0,
        unsubscribe_url: unsubscribeUrl,
        logo_url: DEFAULT_LOGO_URL,
      }
      const subject = renderTemplate(tmpl.subject_template, vars)
      const html    = renderTemplate(tmpl.body_html_template, vars)
      const r = await sendEmail(testTo, subject, html, unsubscribeUrl)
      return new Response(JSON.stringify({ test_send: testTo, coupon: couponCode, ...r }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } })
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
  }

  // ── Main scheduler path ────────────────────────────────────────────
  // Iterate all enabled templates. Phase 1 only has 'first_purchase' but
  // this loop is the extension point — adding 'refill_reminder' or
  // 'review_request' later means writing a new findCandidates fn and
  // adding a case below; the rest is reused.
  const { data: templates, error: tErr } = await supabase
    .from('email_automation_templates')
    .select('*')
    .eq('enabled', true)

  if (tErr) {
    return new Response(JSON.stringify({ error: `templates query: ${tErr.message}` }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const summary: Record<string, any> = { dryRun, runs: [] }

  for (const tmpl of (templates ?? []) as AutomationTemplate[]) {
    let candidates: FirstOrderCandidate[] = []
    if (tmpl.trigger_type === 'first_purchase') {
      candidates = await findFirstPurchaseCandidates(supabase, tmpl.delay_days, tmpl.max_lookback_days)
    } else {
      summary.runs.push({ trigger: tmpl.trigger_type, error: 'no handler implemented' })
      continue
    }

    if (dryRun) {
      summary.runs.push({
        trigger: tmpl.trigger_type,
        candidates_count: candidates.length,
        candidates_sample: candidates.slice(0, 5).map(c => c.customer_email),
      })
      continue
    }

    const results = { sent: 0, skipped: 0, failed: 0, errors: [] as string[] }
    for (const c of candidates) {
      const r = await processAutomation(supabase, tmpl, c)
      if      (r.status === 'sent')    results.sent++
      else if (r.status === 'skipped') results.skipped++
      else                             { results.failed++; if (r.error) results.errors.push(`${c.customer_email}: ${r.error}`) }
    }
    summary.runs.push({ trigger: tmpl.trigger_type, ...results })
  }

  return new Response(JSON.stringify(summary, null, 2),
    { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
