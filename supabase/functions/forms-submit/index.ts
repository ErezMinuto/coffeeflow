/**
 * CoffeeFlow — Public form submission endpoint
 *
 * Replaces the Flashy form action URL on minuto.co.il. Three form types
 * supported, controlled by `?type=` or `body.type`:
 *
 *   newsletter — single-email subscription:
 *      • adds to marketing_contacts (opted_in=true, source='newsletter_form')
 *      • sends a light welcome email
 *
 *   contact — customer-service inquiry (name + email + phone + message):
 *      • forwards the message to info@minuto.co.il
 *      • sends an acknowledgment email to the customer
 *      • does NOT add to marketing_contacts (consent text is contact-only)
 *
 *   callback — "we'll call you back" inquiry (name + email + phone + message):
 *      • forwards the message to info@minuto.co.il
 *      • sends an acknowledgment email to the customer
 *      • adds to marketing_contacts (consent text covers marketing)
 *      • sends a light welcome email
 *
 * Every submission is logged to form_submissions for audit. The handler
 * is permissive on input validation (required fields per type) and
 * tolerant of network blips (best-effort sends, log failures, never
 * block the customer's UI on a slow downstream).
 *
 * Public endpoint: no auth required. Deploy with --no-verify-jwt.
 *
 * Anti-spam: lightweight honeypot field (`website` — bots fill it,
 * humans don't) + basic email format validation. Heavier rate limiting
 * deferred to a follow-up if abuse is observed.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPA_URL  = Deno.env.get('SUPABASE_URL')!
const SUPA_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? ''
const SENDER_EMAIL = Deno.env.get('SENDER_EMAIL') ?? 'info@minuto.co.il'
const INBOX_EMAIL = Deno.env.get('FORMS_INBOX_EMAIL') ?? 'info@minuto.co.il'
const DEFAULT_LOGO_URL = Deno.env.get('MINUTO_LOGO_URL') ?? 'https://www.minuto.co.il/content/uploads/2025/03/Frame-14.png'
// Resend Audience id used by generate-campaign for bulk sends. New form
// signups need to land here too, otherwise they'd be in marketing_contacts
// (Supabase) but invisible to the bulk-send pipeline that reads from the
// Resend Audience until someone runs sync-resend-contacts.
//
// No hardcoded fallback — fail loudly if the secret is missing instead of
// silently writing to whatever audience id was previously baked in. Easier
// to spot misconfigurations and prevents fork/prod cross-contamination.
const RESEND_AUDIENCE_ID = Deno.env.get('RESEND_AUDIENCE_ID')
if (!RESEND_AUDIENCE_ID) throw new Error('RESEND_AUDIENCE_ID secret is required')

const CORS = {
  'Access-Control-Allow-Origin':  '*',  // public form endpoint, intentionally open
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Legacy Clerk user_id pinned to ownership of marketing_contacts rows.
// Already a Supabase secret (verified via secrets list); previously this
// file hardcoded it as a copy. Now reads from the same source as every
// other function so a single edit propagates everywhere.
const COFFEEFLOW_USER_ID = Deno.env.get('COFFEEFLOW_USER_ID')
if (!COFFEEFLOW_USER_ID) throw new Error('COFFEEFLOW_USER_ID secret is required')

type FormType = 'newsletter' | 'contact' | 'callback'

interface SubmitPayload {
  type: FormType
  email: string
  name?: string
  phone?: string
  message?: string
  consent: boolean
  // Honeypot — must be empty/absent. Bots auto-fill all input fields.
  website?: string
}

// ── Validation ──────────────────────────────────────────────────────────────

function isValidEmail(s: string): boolean {
  // Permissive RFC-ish check; we don't want to reject edge cases that
  // major email providers accept. Stricter validation happens at Resend.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
}

function validatePayload(p: any): { ok: true; payload: SubmitPayload } | { ok: false; error: string } {
  if (!p || typeof p !== 'object') return { ok: false, error: 'Body must be JSON object' }
  const type = String(p.type ?? '').toLowerCase()
  if (!['newsletter', 'contact', 'callback'].includes(type)) {
    return { ok: false, error: `type must be one of: newsletter, contact, callback (got "${type}")` }
  }
  const email = String(p.email ?? '').trim().toLowerCase()
  if (!isValidEmail(email)) return { ok: false, error: 'Invalid email format' }

  // Honeypot: bots fill everything, including hidden fields
  if (p.website && String(p.website).trim().length > 0) {
    return { ok: false, error: 'Spam detected (honeypot triggered)' }
  }

  if (p.consent !== true) return { ok: false, error: 'Consent checkbox must be checked' }

  // Per-type field requirements
  if (type === 'contact' || type === 'callback') {
    if (!p.name || String(p.name).trim().length === 0) {
      return { ok: false, error: 'name required for contact/callback' }
    }
    if (!p.message || String(p.message).trim().length === 0) {
      return { ok: false, error: 'message required for contact/callback' }
    }
    // phone is encouraged but not required (some forms make it optional)
  }

  return {
    ok: true,
    payload: {
      type: type as FormType,
      email,
      name: p.name ? String(p.name).trim() : undefined,
      phone: p.phone ? String(p.phone).trim() : undefined,
      message: p.message ? String(p.message).trim() : undefined,
      consent: true,
    }
  }
}

// ── Email rendering ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const WOO_URL = Deno.env.get('WOO_URL') ?? 'https://www.minuto.co.il'
const WOO_KEY = Deno.env.get('WOO_KEY') ?? ''
const WOO_SECRET = Deno.env.get('WOO_SECRET') ?? ''

/**
 * Build a deterministic coupon code from the email — same email → same
 * code, so retrying a signup is idempotent on the WC side too.
 */
async function buildSubscriberCouponCode(email: string): Promise<string> {
  const enc = new TextEncoder()
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(`subscriber:${email}`))
  const hex = Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  return `MINUTO-SUB-${hex.slice(0, 6).toUpperCase()}`
}

/**
 * Create a 10% coupon for a new newsletter subscriber. Coffee-only
 * (specialty coffee category id 380, hardcoded — same as the first-
 * purchase coupon's category restriction). Email-restricted, single-
 * use, 60-day expiry. Returns the coupon code; caller embeds it in
 * the welcome email.
 *
 * Same WC POST hardening as email-automation-scheduler:
 *   • query-string auth instead of Authorization header
 *   • redirect:'manual' so we surface 30x silently-converting POSTs
 *   • response-shape validation (id + code present)
 *
 * Soft-fail behavior: if WC is down or coupon creation fails, we
 * return null so the welcome email still ships (without a coupon).
 * Subscribing to the list is more valuable than a perfect coupon
 * delivery — owner can manually send a coupon if any case slips
 * through.
 */
async function createSubscriberCoupon(email: string): Promise<string | null> {
  if (!WOO_KEY || !WOO_SECRET) return null
  const code = await buildSubscriberCouponCode(email)
  const expires = new Date(Date.now() + 60 * 86400_000).toISOString().split('T')[0]
  const couponUrl = `${WOO_URL}/wp-json/wc/v3/coupons?consumer_key=${encodeURIComponent(WOO_KEY)}&consumer_secret=${encodeURIComponent(WOO_SECRET)}`
  const body = {
    code,
    discount_type: 'percent',
    amount: '10',
    individual_use: true,
    usage_limit: 1,
    usage_limit_per_user: 1,
    email_restrictions: [email.toLowerCase().trim()],
    date_expires: expires,
    product_categories: [380],  // specialty coffee category — same as first_purchase coupons
    description: `Newsletter subscriber coupon for ${email} — auto-generated by forms-submit`,
  }
  try {
    const res = await fetch(couponUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    })
    const text = await res.text()
    if (res.status >= 300 && res.status < 400) {
      console.warn(`[forms-submit] coupon POST redirected (${res.status}); skipping coupon`)
      return null
    }
    let parsed: any = null
    try { parsed = JSON.parse(text) } catch {}
    if (res.ok && parsed?.id && parsed?.code) return code
    if (res.status === 400 && text.includes('coupon_code_already_exists')) return code
    console.warn(`[forms-submit] coupon create failed (${res.status}): ${text.slice(0, 200)}`)
    return null
  } catch (e) {
    console.warn(`[forms-submit] coupon create exception: ${(e as Error).message}`)
    return null
  }
}

/**
 * Welcome email for newsletter + callback signups. Now includes a 10%
 * coupon as the subscriber benefit (per the privacy policy section 2א
 * commitment: "subscribers receive a welcome benefit of 10% off
 * specialty coffee on their next order"). If coupon creation fails
 * (WC down, etc.), the welcome email still ships without the coupon
 * block — caller passes null couponCode in that case.
 */
function renderWelcomeEmail(firstName: string, logoUrl: string, couponCode: string | null): { subject: string; html: string } {
  const greeting = firstName.trim() ? `היי ${escapeHtml(firstName.trim())},` : 'היי,'
  const subject = couponCode
    ? '☕ ברוך/ה הבא/ה למינוטו — 10% הנחה על פולי קפה ספשלטי'
    : 'תודה שנרשמת לעדכונים של מינוטו ☕'
  // Render the coupon block only if WC coupon creation succeeded.
  // 60-day expiry matches createSubscriberCoupon's date_expires.
  // Coffee-only restriction is shown explicitly so the customer doesn't
  // try to apply it on equipment and feel cheated.
  const couponBlock = couponCode ? `
        <div style="background: #f6f3ee; border: 2px dashed #6A7D45; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
          <p style="margin: 0 0 8px; font-size: 14px; color: #6a6a6a;">קוד ההטבה שלך</p>
          <p style="margin: 0 0 12px; font-size: 28px; font-weight: bold; color: #3D4A2E; letter-spacing: 2px; font-family: 'Courier New', monospace;">${escapeHtml(couponCode)}</p>
          <p style="margin: 0 0 4px; font-size: 16px; color: #3D4A2E; font-weight: bold;">10% הנחה על פולי קפה ספשלטי</p>
          <p style="margin: 0 0 16px; font-size: 12px; color: #6a6a6a;">שימוש חד-פעמי · תקף 60 יום · פולי קפה בלבד</p>
          <a href="https://www.minuto.co.il/product-category/פולי-קפה-טרי-מינוטו-specialty-coffee/" style="display: inline-block; background: #6A7D45; color: white; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 15px;">
            לעמוד הפולים →
          </a>
        </div>` : ''
  const couponIntro = couponCode
    ? `<p style="margin: 0 0 16px;">כתודה על ההצטרפות, הכנו לך קופון 10% הנחה על פולי הקפה הספשלטי שלנו, להזמנה הקרובה.</p>`
    : ''
  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><title>תודה ממינוטו</title></head>
<body style="font-family: Arial, sans-serif; background: #f6f3ee; margin: 0; padding: 20px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
    <tr>
      <td style="background: linear-gradient(160deg, #3D4A2E 0%, #6A7D45 100%); padding: 28px 32px 20px; text-align: center; color: white;">
        <img src="${escapeHtml(logoUrl)}" alt="Minuto Cafe" style="max-height: 64px; width: auto; margin-bottom: 12px;" />
        <h1 style="margin: 0; font-size: 26px;">תודה שנרשמת ☕</h1>
        <p style="margin: 8px 0 0; font-size: 14px; opacity: 0.9;">בית קלייה ספשלטי, רחובות</p>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px; color: #2a2a2a; line-height: 1.7;">
        <p style="margin: 0 0 16px;">${greeting}</p>
        <p style="margin: 0 0 16px;">תודה שהצטרפת לרשימת התפוצה שלנו. כל כמה שבועות נשלח עדכונים על פולים חדשים מבית הקלייה, מאמרים על קפה ספשלטי, וטיפים להכנת קפה ביתי.</p>
        <p style="margin: 0 0 16px;">בלי ספאם, רק תוכן שיעניין אותך.</p>
${couponIntro}${couponBlock}
        <p style="margin: 24px 0 0; color: #6a6a6a; font-size: 14px;">שיהיה בכיף,<br>מינוטו קפה</p>
      </td>
    </tr>
    <tr>
      <td style="background: #f6f3ee; padding: 20px 32px; text-align: center; font-size: 12px; color: #8a8a8a; line-height: 1.7;">
        <p style="margin: 0;"><strong style="color: #3D4A2E;">מינוטו קפה בע"מ</strong></p>
        <p style="margin: 0;">אחד העם 22, רחובות</p>
        <p style="margin: 0;">📞 054-4490486 · 📧 <a href="mailto:info@minuto.co.il" style="color: #6A7D45;">info@minuto.co.il</a></p>
        <p style="margin: 8px 0 0;"><a href="https://www.minuto.co.il" style="color: #6A7D45;">minuto.co.il</a> · <a href="https://www.instagram.com/minuto_coffee/" style="color: #6A7D45;">@minuto_coffee</a></p>
      </td>
    </tr>
  </table>
</body>
</html>`
  return { subject, html }
}

/**
 * Acknowledgment email for contact + callback submissions. Tells the
 * customer we received their message and someone (Erez) will reply.
 * Echoes the message back so they have a record.
 */
function renderAckEmail(firstName: string, message: string, isCallback: boolean, logoUrl: string): { subject: string; html: string } {
  const greeting = firstName.trim() ? `היי ${escapeHtml(firstName.trim())},` : 'היי,'
  const subject = isCallback
    ? 'קיבלנו את פנייתך — נחזור אליך בהקדם'
    : 'קיבלנו את הודעתך — נענה בקרוב'
  const introLine = isCallback
    ? 'תודה על פנייתך. קיבלנו את הפרטים שלך, וניצור איתך קשר בהקדם האפשרי.'
    : 'תודה שכתבת אלינו. קיבלנו את הודעתך, ונענה אישית בקרוב.'
  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><title>קיבלנו את פנייתך</title></head>
<body style="font-family: Arial, sans-serif; background: #f6f3ee; margin: 0; padding: 20px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
    <tr>
      <td style="background: linear-gradient(160deg, #3D4A2E 0%, #6A7D45 100%); padding: 28px 32px 20px; text-align: center; color: white;">
        <img src="${escapeHtml(logoUrl)}" alt="Minuto Cafe" style="max-height: 64px; width: auto; margin-bottom: 12px;" />
        <h1 style="margin: 0; font-size: 22px;">${escapeHtml(subject)}</h1>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px; color: #2a2a2a; line-height: 1.7;">
        <p style="margin: 0 0 16px;">${greeting}</p>
        <p style="margin: 0 0 24px;">${introLine}</p>
        <div style="background: #f6f3ee; border-right: 4px solid #6A7D45; padding: 16px; border-radius: 8px; margin: 16px 0; color: #4a4a4a; font-size: 14px;">
          <strong style="color: #3D4A2E; display: block; margin-bottom: 8px;">ההודעה שקיבלנו:</strong>
          <div style="white-space: pre-wrap;">${escapeHtml(message)}</div>
        </div>
        <p style="margin: 16px 0 0; color: #6a6a6a; font-size: 14px;">שיהיה בכיף,<br>מינוטו קפה</p>
      </td>
    </tr>
    <tr>
      <td style="background: #f6f3ee; padding: 16px 32px; text-align: center; font-size: 12px; color: #8a8a8a;">
        <p style="margin: 0;">📞 054-4490486 · 📧 <a href="mailto:info@minuto.co.il" style="color: #6A7D45;">info@minuto.co.il</a></p>
      </td>
    </tr>
  </table>
</body>
</html>`
  return { subject, html }
}

/**
 * Forward email sent to info@minuto.co.il — plain, business-style, easy
 * to scan in inbox. Includes all submitted fields + the form type so
 * the team can route the response.
 */
function renderForwardEmail(payload: SubmitPayload): { subject: string; html: string } {
  const labelByType: Record<FormType, string> = {
    newsletter: 'הרשמה לניוזלטר',
    contact: 'פנייה דרך טופס "צור קשר"',
    callback: 'בקשה לחזרה ("חזור אליי")',
  }
  const subject = `[${labelByType[payload.type]}] ${payload.name ?? payload.email}`
  const lines = [
    `<strong>סוג טופס:</strong> ${escapeHtml(labelByType[payload.type])}`,
    payload.name ? `<strong>שם:</strong> ${escapeHtml(payload.name)}` : null,
    `<strong>אימייל:</strong> <a href="mailto:${escapeHtml(payload.email)}">${escapeHtml(payload.email)}</a>`,
    payload.phone ? `<strong>טלפון:</strong> <a href="tel:${escapeHtml(payload.phone)}">${escapeHtml(payload.phone)}</a>` : null,
    payload.message ? `<strong>הודעה:</strong><br><div style="white-space: pre-wrap; background: #f6f3ee; padding: 12px; border-right: 3px solid #6A7D45;">${escapeHtml(payload.message)}</div>` : null,
  ].filter(Boolean)
  const html = `<!DOCTYPE html><html dir="rtl" lang="he"><body style="font-family: Arial, sans-serif; padding: 20px; line-height: 1.6;">
  <h2 style="color: #3D4A2E;">${escapeHtml(labelByType[payload.type])}</h2>
  ${lines.map(l => `<p>${l}</p>`).join('\n')}
  <hr style="margin: 24px 0; border: none; border-top: 1px solid #ddd;" />
  <p style="font-size: 12px; color: #888;">מקור: minuto.co.il · התקבל: ${new Date().toISOString()}</p>
</body></html>`
  return { subject, html }
}

// ── Email send helper ───────────────────────────────────────────────────────

async function sendEmail(
  to: string, subject: string, html: string, replyTo?: string
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!RESEND_KEY) return { ok: false, error: 'RESEND_API_KEY not configured' }
  const body: Record<string, any> = {
    from: `Minuto <${SENDER_EMAIL}>`,
    to: [to],
    subject,
    html,
  }
  if (replyTo) body.reply_to = replyTo
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text()
    return { ok: false, error: `Resend ${res.status}: ${t.slice(0, 300)}` }
  }
  const data = await res.json()
  return { ok: true, id: data?.id ?? '' }
}

// ── Per-type processors ─────────────────────────────────────────────────────

/**
 * Push a contact to the Resend Audience used by generate-campaign for
 * bulk sends. Mirrors the logic in handlePublicSubscribe — POST to
 * /audiences/{id}/contacts with first/last name split. Resend treats
 * existing emails as idempotent (no error on duplicate).
 *
 * Failure is non-fatal: the contact is already in marketing_contacts
 * (Supabase source-of-truth), so the next manual sync-resend-contacts
 * run will reconcile. We log + continue rather than fail the whole
 * form submission.
 */
async function pushToResendAudience(
  email: string, name: string | undefined
): Promise<{ ok: boolean; error?: string }> {
  if (!RESEND_KEY) return { ok: false, error: 'RESEND_API_KEY not configured' }
  const nameParts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  const res = await fetch(`https://api.resend.com/audiences/${RESEND_AUDIENCE_ID}/contacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      first_name: nameParts[0] ?? '',
      last_name: nameParts.slice(1).join(' '),
      unsubscribed: false,
    }),
  })
  if (res.ok) return { ok: true }
  const text = await res.text()
  // Resend returns 422 for duplicates on the audience contacts endpoint
  // — treat as success, the contact is already there.
  if (res.status === 422 && /already.*exist|duplicate/i.test(text)) {
    return { ok: true }
  }
  return { ok: false, error: `Resend audience POST ${res.status}: ${text.slice(0, 200)}` }
}

async function addToMarketingContacts(
  supabase: any, email: string, name: string | undefined, phone: string | undefined, source: string
): Promise<void> {
  // Verified by query: the actual unique constraint on marketing_contacts
  // is just `UNIQUE (email)`, not `(user_id, email)`. The dashboard's
  // context.tsx has a comment claiming the latter — that comment is
  // stale. Using onConflict:'email' to match the real constraint.
  //
  // user_id is still set to the legacy Clerk pin so existing tooling
  // (generate-campaign etc) that may filter by user_id continues to
  // see these rows.
  const payload: Record<string, any> = {
    user_id: COFFEEFLOW_USER_ID,
    email,
    source,
    opted_in: true,
    updated_at: new Date().toISOString(),
  }
  if (name) payload.name = name
  if (phone) payload.phone = phone
  const { error } = await supabase
    .from('marketing_contacts')
    .upsert(payload, { onConflict: 'email' })
  if (error) {
    console.warn(`[forms-submit] marketing_contacts upsert failed for ${email}: ${error.message}`)
    throw error
  }
}

// ── HTTP entry point ────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }

  let raw: any
  try {
    raw = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Body must be valid JSON' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }

  const validation = validatePayload(raw)
  if (!validation.ok) {
    return new Response(JSON.stringify({ error: validation.error }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }

  const payload = validation.payload
  const supabase = createClient(SUPA_URL, SUPA_KEY)

  // Best-effort capture of IP + UA for spam triage. Cloudflare/Supabase
  // typically forward the real client IP via x-forwarded-for / cf-
  // connecting-ip — try those before falling back.
  const ip =
    req.headers.get('cf-connecting-ip') ??
    (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() ??
    null
  const ua = req.headers.get('user-agent') ?? null

  // Insert audit log first — even if downstream sends fail, we have a
  // record of the submission. Status fields get updated as we progress.
  const { data: logRow, error: logErr } = await supabase
    .from('form_submissions')
    .insert({
      form_type: payload.type,
      email: payload.email,
      name: payload.name ?? null,
      phone: payload.phone ?? null,
      message: payload.message ?? null,
      consent_given: payload.consent,
      ip_address: ip,
      user_agent: ua,
      status: 'received',
    })
    .select('id')
    .single()

  if (logErr || !logRow) {
    console.error(`[forms-submit] audit log insert failed: ${logErr?.message}`)
    // Continue anyway — better to deliver the message than lose the customer.
  }

  const logId = logRow?.id

  const result = {
    ok: true,
    type: payload.type,
    forward_sent: false,
    ack_sent: false,
    welcome_sent: false,
    added_to_list: false,
  }

  try {
    // 1. Forward to inbox (contact + callback only)
    if (payload.type === 'contact' || payload.type === 'callback') {
      const fwd = renderForwardEmail(payload)
      const r = await sendEmail(INBOX_EMAIL, fwd.subject, fwd.html, payload.email)
      if (r.ok) result.forward_sent = true
      else console.warn(`[forms-submit] forward send failed: ${r.error}`)
    }

    // 2. Acknowledgment to customer (contact + callback only)
    if (payload.type === 'contact' || payload.type === 'callback') {
      const ack = renderAckEmail(
        payload.name ?? '',
        payload.message ?? '',
        payload.type === 'callback',
        DEFAULT_LOGO_URL,
      )
      const r = await sendEmail(payload.email, ack.subject, ack.html)
      if (r.ok) result.ack_sent = true
      else console.warn(`[forms-submit] ack send failed: ${r.error}`)
    }

    // 3. Add to marketing list (newsletter + callback)
    //    Two writes, both idempotent on email:
    //      a) Supabase marketing_contacts — our source of truth, used
    //         for owner-facing dashboards and audience filtering.
    //      b) Resend Audience — what generate-campaign actually sends to
    //         when running bulk campaigns. Without this step, new
    //         subscribers would sit in our DB but be invisible to the
    //         bulk-send pipeline until a manual reconcile.
    //    Both writes are best-effort independent; one failing doesn't
    //    block the other.
    if (payload.type === 'newsletter' || payload.type === 'callback') {
      try {
        await addToMarketingContacts(
          supabase,
          payload.email,
          payload.name,
          payload.phone,
          `${payload.type}_form`,
        )
        result.added_to_list = true
      } catch (e: any) {
        console.warn(`[forms-submit] add-to-list failed: ${e.message}`)
      }
      const r = await pushToResendAudience(payload.email, payload.name)
      if (!r.ok) console.warn(`[forms-submit] Resend audience push failed: ${r.error}`)
    }

    // 4. Welcome email (newsletter + callback) — now ships a 10% coupon
    //    as the subscriber benefit. createSubscriberCoupon is idempotent
    //    on email (deterministic code from SHA-256), so retrying a signup
    //    re-uses the same coupon code rather than spamming WC. If WC is
    //    down, couponCode comes back null and the welcome email ships
    //    without the coupon block — we'd rather deliver a thank-you
    //    without the perk than block the customer entirely.
    if (payload.type === 'newsletter' || payload.type === 'callback') {
      const couponCode = await createSubscriberCoupon(payload.email)
      const welcome = renderWelcomeEmail(payload.name ?? '', DEFAULT_LOGO_URL, couponCode)
      const r = await sendEmail(payload.email, welcome.subject, welcome.html)
      if (r.ok) result.welcome_sent = true
      else console.warn(`[forms-submit] welcome send failed: ${r.error}`)
    }

    // 5. Update audit log with final status
    if (logId) {
      await supabase.from('form_submissions').update({
        status: 'processed',
        forward_sent: result.forward_sent,
        ack_sent: result.ack_sent,
        added_to_list: result.added_to_list,
      }).eq('id', logId)
    }
  } catch (e: any) {
    console.error(`[forms-submit] processing error: ${e.message}`)
    if (logId) {
      await supabase.from('form_submissions').update({
        status: 'failed',
        error_msg: e.message,
      }).eq('id', logId)
    }
    return new Response(JSON.stringify({ ok: false, error: 'Internal error processing form' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }

  return new Response(JSON.stringify(result), {
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })
})
