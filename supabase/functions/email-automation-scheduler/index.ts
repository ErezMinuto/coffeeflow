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
  not_before_date?: string | null  // abandoned_cart only: ignore carts whose order_date is before this (go-live floor, YYYY-MM-DD). NULL = no floor.
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

interface CartItem {
  name: string
  quantity: number
  total: string  // line total in store currency (ILS), as returned by WC
  image_url: string  // product thumbnail from WC line_items[].image.src; '' if none
}

interface FirstOrderCandidate {
  customer_email: string
  customer_name: string | null
  woo_order_id: number
  order_date: string  // YYYY-MM-DD
  cart_items?: CartItem[]  // abandoned_cart only — line items from the pending WC order
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Renders {{ var }} placeholders in a template string. */
function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*([\w_]+)\s*\}\}/g, (_, key) => {
    const v = vars[key]
    return v === undefined || v === null ? '' : String(v)
  })
}

/** Escape text interpolated into email HTML (WC product names are untrusted). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Map a WC orders-endpoint line_items array to our CartItem shape. */
function mapLineItems(raw: any): CartItem[] {
  if (!Array.isArray(raw)) return []
  return raw.map((li: any) => ({
    name: (String(li?.name ?? '').trim()) || 'מוצר',
    quantity: Number(li?.quantity ?? 1) || 1,
    total: String(li?.total ?? '').trim(),
    image_url: String(li?.image?.src ?? '').trim(),
  }))
}

/**
 * Build the RTL cart-contents block for abandoned-cart emails. Returns ''
 * when there are no items, so templates that include {{ cart_items_html }}
 * render nothing (no empty heading) rather than a stray box. first_purchase
 * and refill_reminder never set cart_items, so they're unaffected.
 *
 * Each row: product thumbnail (right, RTL start) · name · qty + line total
 * (left). Thumbnail falls back to a neutral box when the line item has no
 * image so the columns stay aligned. Inline styles + table layout for
 * email-client compatibility (no flexbox/grid).
 */
function renderCartItemsHtml(items: CartItem[]): string {
  if (!items || items.length === 0) return ''
  const rows = items.map(it => {
    const thumb = it.image_url
      ? `<img src="${escapeHtml(it.image_url)}" width="52" height="52" alt="" style="display: block; width: 52px; height: 52px; border-radius: 8px; object-fit: cover; border: 1px solid #e0d8c8;" />`
      : `<div style="width: 52px; height: 52px; border-radius: 8px; background: #e9e3d6;"></div>`
    return `
          <tr>
            <td width="52" style="padding: 8px 0;" valign="middle">${thumb}</td>
            <td style="padding: 8px 12px; color: #2a2a2a; font-size: 15px;" valign="middle">${escapeHtml(it.name)}</td>
            <td style="padding: 8px 0; color: #6a6a6a; font-size: 14px; white-space: nowrap;" align="left" valign="middle">× ${it.quantity}${it.total ? ` &middot; ₪${escapeHtml(it.total)}` : ''}</td>
          </tr>`
  }).join('')
  return `
        <div style="margin: 8px 0 24px; padding: 16px 20px; background: #f6f3ee; border-radius: 8px;">
          <p style="margin: 0 0 10px; font-weight: bold; color: #3D4A2E; font-size: 15px;">מה שחיכה בעגלה</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}
          </table>
        </div>`
}

/**
 * Test-send helper for abandoned_cart_*: pull the most recent real pending
 * order's line items so the preview shows genuine product names + images
 * (not placeholders). Returns [] on any failure; caller supplies a static
 * fallback so a test-send never breaks just because WC is unreachable.
 */
async function fetchSampleCartItems(): Promise<CartItem[]> {
  if (!WOO_KEY || !WOO_SECRET) return []
  try {
    const params = new URLSearchParams({
      status: 'pending', per_page: '1', orderby: 'date', order: 'desc',
      _fields: 'line_items',
    })
    const url = `${WOO_URL}/wp-json/wc/v3/orders?${params.toString()}&consumer_key=${encodeURIComponent(WOO_KEY)}&consumer_secret=${encodeURIComponent(WOO_SECRET)}`
    const res = await fetch(url)
    if (!res.ok) return []
    const orders = await res.json()
    return Array.isArray(orders) && orders[0] ? mapLineItems(orders[0].line_items) : []
  } catch { return [] }
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
/**
 * Returns the set of normalized email addresses that have explicitly
 * opted into marketing communications (newsletter signup, callback
 * form with marketing-consent box, manual import flagged opted_in).
 *
 * Owner's explicit decision (2026-04-29): all marketing-style
 * automations (welcome, refill, future review/win-back) target ONLY
 * opted-in customers. Privacy policy promises this; sending to
 * non-opted-in buyers would violate it. Customers who buy without
 * subscribing get a transactional purchase confirmation from
 * WooCommerce but no marketing follow-up.
 *
 * Side benefit: makes the welcome coupon a newsletter-signup
 * incentive ("subscribe and get 10% off your first order"),
 * driving list growth.
 */
async function fetchOptedInEmails(supabase: any): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('marketing_contacts')
    .select('email')
    .eq('opted_in', true)
  if (error) throw new Error(`opted-in query: ${error.message}`)
  const set = new Set<string>()
  for (const r of (data ?? [])) {
    const e = (r.email ?? '').toLowerCase().trim()
    if (e) set.add(e)
  }
  return set
}

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

  // Marketing-consent gate: only customers who explicitly opted into
  // our list qualify. Past buyers who never subscribed get nothing —
  // that's the privacy-compliant default. See fetchOptedInEmails docs.
  const optedIn = await fetchOptedInEmails(supabase)

  const candidates: FirstOrderCandidate[] = []
  for (const [email, orders] of byEmail.entries()) {
    if ((orderCount.get(email) ?? 0) !== 1) continue
    if (!optedIn.has(email)) continue
    candidates.push(orders[0])
  }
  return candidates
}

/**
 * Find customers due for a refill reminder.
 *
 * Cadence model:
 *   • 1 coffee order  → cadence = template.delay_days (default 21)
 *   • 2+ coffee orders → cadence = avg interval between coffee orders
 *
 * Eligibility window: days_since_last_coffee_order between cadence and
 * (cadence + max_lookback_days - delay_days), giving up to ~14 days of
 * grace if cron skips a day.
 *
 * Sanity bounds: skip cadence < 7 days (probably wholesale or test
 * orders) or > 90 days (probably abandoned, win-back territory).
 *
 * Coffee filter: only orders with at least one woo_order_items_enriched
 * row whose product_category = 'coffee' count. Equipment-only orders
 * don't trigger refill.
 *
 * Per-cycle dedup: handled by the unique index in the DB —
 * uniq_automation_per_customer_per_order on
 * (trigger_type, customer_email, woo_order_id). Same customer can get
 * multiple reminders over their lifetime, one per coffee order.
 */
async function findRefillCandidates(
  supabase: any, delayDays: number, maxLookbackDays: number
): Promise<FirstOrderCandidate[]> {
  // Pull all paid orders for customers with at least one coffee item.
  // Joining woo_orders → woo_order_items_enriched in code rather than
  // SQL because supabase-js doesn't expose joins through the REST
  // endpoint cleanly. Two queries → in-memory join.

  const { data: coffeeItemRows, error: itemsErr } = await supabase
    .from('woo_order_items_enriched')
    .select('order_id')
    .eq('product_category', 'coffee')
  if (itemsErr) throw new Error(`coffee items query: ${itemsErr.message}`)

  const coffeeOrderIds = new Set<number>()
  for (const r of (coffeeItemRows ?? [])) coffeeOrderIds.add(r.order_id)

  if (coffeeOrderIds.size === 0) return []

  // woo_orders has no customer_name column (verified — billing.first_name
  // isn't synced from WC, only billing.email). Greeting falls back to
  // "חבר/ה" via the standard fallback in processAutomation.
  const { data: ordersRaw, error: ordersErr } = await supabase
    .from('woo_orders')
    .select('woo_order_id, customer_email, order_date, status')
    .in('status', ['completed', 'processing'])
    .not('customer_email', 'is', null)
    .order('order_date', { ascending: true })
  if (ordersErr) throw new Error(`woo_orders query: ${ordersErr.message}`)

  // Group by email; keep only orders that contain coffee.
  const byEmail = new Map<string, Array<{ id: number; date: string; name: string | null }>>()
  for (const o of (ordersRaw ?? [])) {
    if (!coffeeOrderIds.has(o.woo_order_id)) continue
    const email = (o.customer_email ?? '').toLowerCase().trim()
    if (!email) continue
    if (!byEmail.has(email)) byEmail.set(email, [])
    byEmail.get(email)!.push({
      id: o.woo_order_id,
      date: o.order_date,
      // billing_first_name isn't on woo_orders; the column doesn't exist
      // on the table per the schema. Customer name will be NULL until a
      // future sync brings it in. Greeting falls back to "חבר/ה".
      name: null,
    })
  }

  // Pre-fetch all refill_reminder rows so we can filter (trigger, email,
  // order_id) tuples without per-candidate roundtrips. Cheap because the
  // table is small.
  const { data: existingRefills } = await supabase
    .from('email_automations')
    .select('customer_email, woo_order_id')
    .eq('trigger_type', 'refill_reminder')
  const alreadyReminded = new Set<string>()
  for (const r of (existingRefills ?? [])) {
    alreadyReminded.add(`${r.customer_email}::${r.woo_order_id}`)
  }

  // Marketing-consent gate: only customers who explicitly opted into
  // our list qualify. Same rule as first_purchase. See fetchOptedInEmails.
  const optedIn = await fetchOptedInEmails(supabase)

  const today = Date.now()
  const candidates: FirstOrderCandidate[] = []

  for (const [email, orders] of byEmail.entries()) {
    if (orders.length === 0) continue
    if (!optedIn.has(email)) continue

    // Compute cadence in days.
    let cadenceDays: number
    if (orders.length === 1) {
      cadenceDays = delayDays  // first-time customer default (e.g. 21)
    } else {
      const earliest = new Date(orders[0].date).getTime()
      const latest = new Date(orders[orders.length - 1].date).getTime()
      cadenceDays = ((latest - earliest) / 86400_000) / (orders.length - 1)
    }

    // Sanity bounds.
    if (cadenceDays < 7 || cadenceDays > 90) continue

    const lastOrder = orders[orders.length - 1]
    const daysSince = (today - new Date(lastOrder.date).getTime()) / 86400_000

    // Eligibility window: cadence ≤ daysSince ≤ cadence + grace.
    // Using maxLookbackDays - delayDays as grace gives 14 by default
    // (35 - 21 = 14). Floor of cadence is the lower bound.
    const lower = Math.floor(cadenceDays)
    const upper = lower + Math.max(maxLookbackDays - delayDays, 7)
    if (daysSince < lower || daysSince > upper) continue

    // Already reminded for this specific last order? Skip.
    if (alreadyReminded.has(`${email}::${lastOrder.id}`)) continue

    candidates.push({
      customer_email: email,
      customer_name: null,
      woo_order_id: lastOrder.id,
      order_date: lastOrder.date,
    })
  }
  return candidates
}

/**
 * Find customers who abandoned a checkout — placed a WooCommerce order but
 * never completed payment (status='pending'). Used by both abandoned_cart_1
 * (day-1 reminder) and abandoned_cart_2 (day-4 follow-up). Pass
 * prerequisiteTrigger = null for cart_1, or 'abandoned_cart_1' for cart_2 —
 * cart_2 only fires for orders that actually received cart_1.
 *
 * Data source — why we query WC live instead of woo_orders:
 *   woo-orders-sync only fetches completed+processing orders (the owner's
 *   "only real revenue" invariant; see woo-orders-sync line 181). Pending
 *   orders never land in our DB. Adding them to the sync would pollute
 *   RFM, the marketing-advisor, and the dashboard's order counts — all of
 *   which assume woo_orders = paid orders. Going direct to the WC REST
 *   API keeps that invariant intact and contains the abandoned-cart
 *   logic to this function.
 *
 * Recovery exclusion (applied to both cart_1 and cart_2):
 *   If the same customer has a completed/processing order in woo_orders
 *   dated on or after their pending order, they already came back on
 *   their own — skip. Cheaper to over-skip than to spam.
 *
 * Prerequisite check (cart_2 only):
 *   Only include orders that already have a 'sent' row with the
 *   prerequisite trigger and matching woo_order_id. Prevents cart_2 from
 *   firing alone when cart_1 was disabled/failed — sending "still thinking?"
 *   without a prior "did you forget?" reads as rude.
 *
 * Two-email cap is enforced by the per-order unique index:
 *   uniq_automation_per_customer_per_order on
 *   (trigger_type, customer_email, woo_order_id). Each cart can receive
 *   at most one row per trigger type, so cart_1 + cart_2 = two emails max.
 *
 * Consent gate:
 *   NO opted-in filter. Owner's explicit choice — the customer handed
 *   us their email to complete a purchase, so recovery is the industry-
 *   standard exception to the marketing-consent rule used by
 *   first_purchase / refill_reminder.
 *
 * Operator caveat baked into reality: WooCommerce auto-cancels pending
 * orders after `hold_stock_minutes` (default 60 min). If that's set
 * low, orders flip 'pending' → 'cancelled' before delay_days passes
 * and this finder returns zero candidates. Diagnose via:
 *   POST /email-automation-scheduler {"dry_run": true}
 * which logs the WC fetch count.
 */
/**
 * Live recovery lookup: latest PAID (completed/processing) order date per
 * customer email, fetched straight from WooCommerce — NOT the synced
 * woo_orders table.
 *
 * Why live: woo_orders lags real-time payments (on 2026-06-01 the sync had
 * frozen at order 80722 / 2026-05-26 while live abandoned carts were already
 * at 80800+). A stale table makes the recovery check blind to anyone who
 * paid in the gap, so we'd email a customer who already bought — exactly the
 * spam we're trying to avoid. Querying WC live closes the gap: if the
 * customer completed ANY order on/after their abandoned cart's date, they
 * decided to buy and we skip them.
 *
 * Returns a map of lowercased email → latest paid order date (YYYY-MM-DD).
 * Fetches every order placed since `afterIso` (bounded by the lookback
 * window, so 1–2 pages) and keeps only completed/processing.
 */
async function fetchLatestPaidByEmail(afterIso: string): Promise<Map<string, string>> {
  const latestPaid = new Map<string, string>()
  if (!WOO_KEY || !WOO_SECRET) throw new Error('recovery: WOO_KEY/WOO_SECRET not configured')
  let page = 1
  for (;;) {
    const params = new URLSearchParams({
      after: afterIso,
      per_page: '100',
      page: String(page),
      orderby: 'date',
      order: 'asc',
      _fields: 'id,date_created,status,billing',
    })
    const url = `${WOO_URL}/wp-json/wc/v3/orders?${params.toString()}&consumer_key=${encodeURIComponent(WOO_KEY)}&consumer_secret=${encodeURIComponent(WOO_SECRET)}`
    const res = await fetch(url)
    if (!res.ok) {
      const t = await res.text()
      throw new Error(`recovery: WC orders fetch ${res.status}: ${t.slice(0, 300)}`)
    }
    const orders = await res.json()
    if (!Array.isArray(orders)) {
      throw new Error(`recovery: WC returned non-array (likely auth/redirect failure): ${JSON.stringify(orders).slice(0, 200)}`)
    }
    if (orders.length === 0) break
    for (const o of orders) {
      const status = String(o?.status ?? '')
      if (status !== 'completed' && status !== 'processing') continue  // 'paid' = decided to buy
      const email = ((o?.billing?.email ?? '') as string).toLowerCase().trim()
      if (!email) continue
      const od = String(o?.date_created ?? '').split('T')[0]
      if (!od) continue
      const prev = latestPaid.get(email)
      if (!prev || od > prev) latestPaid.set(email, od)
    }
    if (orders.length < 100) break
    page++
  }
  return latestPaid
}

async function findAbandonedCartCandidates(
  supabase: any,
  delayDays: number,
  maxLookbackDays: number,
  prerequisiteTrigger: string | null,
  notBeforeDate: string | null,
): Promise<FirstOrderCandidate[]> {
  if (maxLookbackDays < delayDays) {
    console.warn(`[email-automation] abandoned_cart: max_lookback_days (${maxLookbackDays}) < delay_days (${delayDays}) — no orders can ever qualify. Fix the template.`)
    return []
  }
  if (!WOO_KEY || !WOO_SECRET) {
    throw new Error('abandoned_cart: WOO_KEY/WOO_SECRET not configured')
  }

  // Window: order placed between (now - maxLookback) and (now - delay).
  // ISO timestamps because the WC `after` / `before` filters take ISO 8601.
  const upper = new Date(Date.now() - delayDays * 86400_000).toISOString()
  const lower = new Date(Date.now() - maxLookbackDays * 86400_000).toISOString()

  // Auth via query string for the same reason createCoupon does — some
  // WAF/CDN setups strip the Authorization header on /wp-json requests.
  // Read-only GET so no POST-to-GET 301 risk here, but consistency is
  // useful for future debugging.
  const params = new URLSearchParams({
    status: 'pending',
    after: lower,
    before: upper,
    per_page: '100',
    orderby: 'date',
    order: 'asc',
    _fields: 'id,date_created,status,billing,line_items',
  })
  const url = `${WOO_URL}/wp-json/wc/v3/orders?${params.toString()}&consumer_key=${encodeURIComponent(WOO_KEY)}&consumer_secret=${encodeURIComponent(WOO_SECRET)}`
  const res = await fetch(url)
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`abandoned_cart: WC orders fetch ${res.status}: ${t.slice(0, 300)}`)
  }
  const orders = await res.json()
  if (!Array.isArray(orders)) {
    throw new Error(`abandoned_cart: WC returned non-array (likely auth/redirect failure): ${JSON.stringify(orders).slice(0, 200)}`)
  }
  console.log(`[email-automation] abandoned_cart: WC returned ${orders.length} pending orders in window [${lower}, ${upper}]`)

  // Normalize to internal candidate shape. Drop rows without an email
  // (some pending orders, e.g. created via admin, won't have one).
  type PendingOrder = { woo_order_id: number; email: string; first_name: string | null; order_date: string; cart_items: CartItem[] }
  const pending: PendingOrder[] = []
  for (const o of orders) {
    const email = ((o?.billing?.email ?? '') as string).toLowerCase().trim()
    if (!email) continue
    const cart_items = mapLineItems(o?.line_items)
    pending.push({
      woo_order_id: o.id,
      email,
      first_name: (o?.billing?.first_name ?? null) || null,
      order_date: String(o.date_created ?? '').split('T')[0],
      cart_items,
    })
  }
  if (pending.length === 0) return []

  // Recovery check: if the customer completed/processing ANY order on/after
  // their abandoned cart's date, they decided to buy and we must not spam
  // them with a reminder. Matched by email (case-insensitive — emails are
  // lowercased on both sides). Fetched LIVE from WooCommerce, not the synced
  // woo_orders table, because that table lags real-time payments and a stale
  // lookup would email people who already bought (see fetchLatestPaidByEmail).
  const latestPaid = await fetchLatestPaidByEmail(lower)

  // Prerequisite check (cart_2 only): require a prior 'sent' row with the
  // prerequisite trigger and matching woo_order_id. Pre-fetch all matching
  // rows once instead of querying per candidate.
  let prereqOrderIds: Set<number> | null = null
  if (prerequisiteTrigger) {
    const pendingIds = pending.map(p => p.woo_order_id)
    const { data: prereqRows, error: prereqErr } = await supabase
      .from('email_automations')
      .select('woo_order_id')
      .eq('trigger_type', prerequisiteTrigger)
      .eq('status', 'sent')
      .in('woo_order_id', pendingIds)
    if (prereqErr) throw new Error(`abandoned_cart prerequisite query: ${prereqErr.message}`)
    prereqOrderIds = new Set<number>()
    for (const r of (prereqRows ?? [])) {
      if (typeof r.woo_order_id === 'number') prereqOrderIds.add(r.woo_order_id)
    }
    console.log(`[email-automation] abandoned_cart: ${prereqOrderIds.size}/${pending.length} pending orders satisfy prerequisite '${prerequisiteTrigger}'`)
  }

  const surviving: FirstOrderCandidate[] = []
  for (const p of pending) {
    // Go-live floor: ignore carts abandoned before the trigger's start date
    // so enabling the automation doesn't blast the pre-existing backlog.
    // Compared by calendar date (order_date is the store-local date), which
    // matches the owner's "start from today's carts" intent. NULL = no floor.
    if (notBeforeDate && p.order_date < notBeforeDate) continue
    const lp = latestPaid.get(p.email)
    if (lp && lp >= p.order_date) continue   // already recovered — skip
    if (prereqOrderIds && !prereqOrderIds.has(p.woo_order_id)) continue  // cart_1 not sent yet
    surviving.push({
      customer_email: p.email,
      customer_name: p.first_name,
      woo_order_id: p.woo_order_id,
      order_date: p.order_date,
      cart_items: p.cart_items,
    })
  }

  // Per-customer dedup (owner rule 2026-05-31): if one customer abandoned
  // more than one cart in the window, remind about ONLY their most recent
  // one. Newest = latest order_date, tie-broken by higher woo_order_id (WC
  // ids are monotonic, so a higher id is the later order). Without this a
  // customer with N pending carts would get N emails on a single tick.
  // NOTE: the dedup key is the literal billing email. Gmail dot-variants
  // (yogev.zorea@ vs yogevzorea@) are DIFFERENT keys here even though Gmail
  // delivers both to one inbox, so those would still produce two emails.
  const latestPerEmail = new Map<string, FirstOrderCandidate>()
  for (const c of surviving) {
    const prev = latestPerEmail.get(c.customer_email)
    if (!prev ||
        c.order_date > prev.order_date ||
        (c.order_date === prev.order_date && c.woo_order_id > prev.woo_order_id)) {
      latestPerEmail.set(c.customer_email, c)
    }
  }
  return Array.from(latestPerEmail.values())
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

  // Coupon is optional — if template.coupon_percent is NULL, skip the
  // coupon creation entirely. Refill reminders default to no-coupon
  // because returning buyers are already coming back; a discount is
  // pure leakage. Owner can opt into a coupon by setting coupon_percent
  // on the template via the dashboard editor.
  let couponCode: string | null = null
  if (template.coupon_percent !== null && template.coupon_percent !== undefined && template.coupon_percent > 0) {
    try {
      const categoryIds = await resolveCategoryIdsCached(supabase, template)
      couponCode = await createCoupon(
        candidate.customer_email,
        template.coupon_percent,
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
  }

  // Render subject + body. customer_name might be null — fall back to
  // a friendly default so the greeting still reads well. coupon_code
  // is empty string when no coupon was created (template should not
  // reference it in that case; if it does, renders as empty).
  const firstName = (candidate.customer_name ?? 'חבר/ה').trim()
  const unsubscribeUrl = generateUnsubscribeUrl(candidate.customer_email)
  const vars = {
    first_name: firstName,
    coupon_code: couponCode ?? '',
    coupon_expiry_days: template.coupon_expiry_days,
    order_id: candidate.woo_order_id,
    unsubscribe_url: unsubscribeUrl,
    logo_url: DEFAULT_LOGO_URL,
    cart_items_html: renderCartItemsHtml(candidate.cart_items ?? []),
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
  // Review-send: render EACH real candidate's actual email (real name,
  // real cart, real images) and send it to the owner's address for copy
  // review — NOT to the customer. No coupon creation, no DB lock rows,
  // no 'sent' marking. Purely a preview of what live sends would look
  // like, so the owner can approve before flipping enabled=true.
  const reviewTo = typeof body.review_send === 'string' ? body.review_send : null
  // Owner can pass {trigger_type: 'refill_reminder'} alongside test_send
  // to QA a different template. Defaults to first_purchase to keep the
  // existing UI button working without changes.
  const testTrigger = typeof body.trigger_type === 'string' ? body.trigger_type : 'first_purchase'

  // ── Test-send path ─────────────────────────────────────────────────
  // Sends the chosen template's email to a specific address. Real
  // coupon (if the template has one), real send. Useful for QA and
  // content review without waiting for a real candidate to come in.
  if (testTo) {
    const { data: tmpl, error } = await supabase
      .from('email_automation_templates')
      .select('*')
      .eq('trigger_type', testTrigger)
      .maybeSingle()
    if (error || !tmpl) {
      return new Response(JSON.stringify({ error: `template not found: ${testTrigger}` }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
    try {
      // Coupon is optional — same logic as the production send path.
      let couponCode: string | null = null
      if (tmpl.coupon_percent !== null && tmpl.coupon_percent !== undefined && tmpl.coupon_percent > 0) {
        const categoryIds = await resolveCategoryIdsCached(supabase, tmpl)
        couponCode = await createCoupon(
          testTo,
          tmpl.coupon_percent,
          tmpl.coupon_expiry_days,
          categoryIds,
        )
      }
      const unsubscribeUrl = generateUnsubscribeUrl(testTo)
      // For abandoned_cart_* previews, show a REAL pending order's items
      // (names + images) so the test matches what a customer would receive.
      // Fall back to a static sample if there's no pending order / WC fails.
      let sampleCart: CartItem[] = []
      if (testTrigger.startsWith('abandoned_cart')) {
        sampleCart = await fetchSampleCartItems()
        if (sampleCart.length === 0) {
          sampleCart = [
            { name: 'אתיופיה יִרגָצֶ׳ף — 250 גרם', quantity: 1, total: '64.00', image_url: '' },
            { name: 'בלנד הבית אספרסו — 1 ק״ג', quantity: 2, total: '240.00', image_url: '' },
          ]
        }
      }
      const vars = {
        first_name: 'בוחן',
        coupon_code: couponCode ?? '',
        coupon_expiry_days: tmpl.coupon_expiry_days,
        order_id: 0,
        unsubscribe_url: unsubscribeUrl,
        logo_url: DEFAULT_LOGO_URL,
        cart_items_html: renderCartItemsHtml(sampleCart),
      }
      const subject = renderTemplate(tmpl.subject_template, vars)
      const html    = renderTemplate(tmpl.body_html_template, vars)
      const r = await sendEmail(testTo, subject, html, unsubscribeUrl)
      return new Response(JSON.stringify({ test_send: testTo, trigger: testTrigger, coupon: couponCode, ...r }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } })
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }
  }

  // ── Review-send path ───────────────────────────────────────────────
  // For the chosen trigger, find the REAL candidates and email each
  // candidate's actual rendered message to the review address. The
  // customer is never contacted; no coupon is minted; no email_automations
  // row is written, so this neither consumes the dedup lock nor marks
  // anyone 'sent'. Subject is prefixed with the destination customer so
  // the owner can tell the previews apart in their inbox.
  if (reviewTo) {
    const { data: tmpl, error } = await supabase
      .from('email_automation_templates')
      .select('*')
      .eq('trigger_type', testTrigger)
      .maybeSingle()
    if (error || !tmpl) {
      return new Response(JSON.stringify({ error: `template not found: ${testTrigger}` }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    let candidates: FirstOrderCandidate[] = []
    try {
      if (testTrigger === 'first_purchase') {
        candidates = await findFirstPurchaseCandidates(supabase, tmpl.delay_days, tmpl.max_lookback_days)
      } else if (testTrigger === 'refill_reminder') {
        candidates = await findRefillCandidates(supabase, tmpl.delay_days, tmpl.max_lookback_days)
      } else if (testTrigger === 'abandoned_cart_1') {
        candidates = await findAbandonedCartCandidates(supabase, tmpl.delay_days, tmpl.max_lookback_days, null, tmpl.not_before_date ?? null)
      } else if (testTrigger === 'abandoned_cart_2') {
        candidates = await findAbandonedCartCandidates(supabase, tmpl.delay_days, tmpl.max_lookback_days, 'abandoned_cart_1', tmpl.not_before_date ?? null)
      } else {
        return new Response(JSON.stringify({ error: `no finder for trigger: ${testTrigger}` }),
          { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
      }
    } catch (e: any) {
      return new Response(JSON.stringify({ error: `find candidates: ${e.message}` }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    const previews: any[] = []
    for (const c of candidates) {
      const firstName = (c.customer_name ?? 'חבר/ה').trim()
      const unsubscribeUrl = generateUnsubscribeUrl(c.customer_email)
      const vars = {
        first_name: firstName,
        coupon_code: '',  // review never mints a real coupon
        coupon_expiry_days: tmpl.coupon_expiry_days,
        order_id: c.woo_order_id,
        unsubscribe_url: unsubscribeUrl,
        logo_url: DEFAULT_LOGO_URL,
        cart_items_html: renderCartItemsHtml(c.cart_items ?? []),
      }
      const baseSubject = renderTemplate(tmpl.subject_template, vars)
      const subject = `[תצוגה → ${c.customer_email} · הזמנה ${c.woo_order_id}] ${baseSubject}`
      const html    = renderTemplate(tmpl.body_html_template, vars)
      const r = await sendEmail(reviewTo, subject, html, unsubscribeUrl)
      previews.push({
        would_send_to: c.customer_email,
        woo_order_id: c.woo_order_id,
        cart_item_count: (c.cart_items ?? []).length,
        sent_to_reviewer: r.ok,
        error: r.ok ? undefined : r.error,
      })
    }

    return new Response(JSON.stringify({
      review_send: reviewTo,
      trigger: testTrigger,
      enabled: tmpl.enabled,
      candidate_count: candidates.length,
      previews,
    }, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  // ── Main scheduler path ────────────────────────────────────────────
  // Iterate all enabled templates. Phase 1 only has 'first_purchase' but
  // this loop is the extension point — adding 'refill_reminder' or
  // 'review_request' later means writing a new findCandidates fn and
  // adding a case below; the rest is reused.
  // dry_run includes disabled templates (so the owner can preview what
  // a not-yet-enabled trigger would catch). Real runs only iterate the
  // enabled ones so we never accidentally send for a disabled trigger.
  const tmplQuery = supabase.from('email_automation_templates').select('*')
  const { data: templates, error: tErr } = dryRun
    ? await tmplQuery
    : await tmplQuery.eq('enabled', true)

  if (tErr) {
    return new Response(JSON.stringify({ error: `templates query: ${tErr.message}` }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const summary: Record<string, any> = { dryRun, runs: [] }

  for (const tmpl of (templates ?? []) as AutomationTemplate[]) {
    let candidates: FirstOrderCandidate[] = []
    if (tmpl.trigger_type === 'first_purchase') {
      candidates = await findFirstPurchaseCandidates(supabase, tmpl.delay_days, tmpl.max_lookback_days)
    } else if (tmpl.trigger_type === 'refill_reminder') {
      candidates = await findRefillCandidates(supabase, tmpl.delay_days, tmpl.max_lookback_days)
    } else if (tmpl.trigger_type === 'abandoned_cart_1') {
      candidates = await findAbandonedCartCandidates(supabase, tmpl.delay_days, tmpl.max_lookback_days, null, tmpl.not_before_date ?? null)
    } else if (tmpl.trigger_type === 'abandoned_cart_2') {
      candidates = await findAbandonedCartCandidates(supabase, tmpl.delay_days, tmpl.max_lookback_days, 'abandoned_cart_1', tmpl.not_before_date ?? null)
    } else {
      summary.runs.push({ trigger: tmpl.trigger_type, error: 'no handler implemented' })
      continue
    }

    if (dryRun) {
      summary.runs.push({
        trigger: tmpl.trigger_type,
        enabled: tmpl.enabled,  // surface so owner can tell which triggers would actually fire vs preview-only
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
