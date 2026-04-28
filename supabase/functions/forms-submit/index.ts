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

const CORS = {
  'Access-Control-Allow-Origin':  '*',  // public form endpoint, intentionally open
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const COFFEEFLOW_USER_ID = 'user_3A4KMEUku7p11snyPMiFv6VsL1Q'  // legacy pin — see context.tsx comment

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

/**
 * Light welcome email used for newsletter + callback signups. Different
 * from the first-purchase welcome — no coupon (we save that for actual
 * buyers), shorter copy, just sets expectations for what the subscriber
 * will get.
 */
function renderWelcomeEmail(firstName: string, logoUrl: string): { subject: string; html: string } {
  const greeting = firstName.trim() ? `היי ${escapeHtml(firstName.trim())},` : 'היי,'
  const subject = 'תודה שנרשמת לעדכונים של מינוטו ☕'
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
    }

    // 4. Welcome email (newsletter + callback)
    if (payload.type === 'newsletter' || payload.type === 'callback') {
      const welcome = renderWelcomeEmail(payload.name ?? '', DEFAULT_LOGO_URL)
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
