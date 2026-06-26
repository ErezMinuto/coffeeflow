// Shared transactional-email helper (Resend).
//
// Three edge functions independently grew the SAME ~15-line Resend POST:
// health-watchdog (system alerts), organic-worker-instagram (post-ready
// notices), and now strategist-brain (weekly brief). This is the one copy.
// Each caller still owns its own HTML/subject — only the transport, env
// wiring, and the never-throw contract live here.
//
// CONTRACT: sendOwnerEmail NEVER throws. A missing key or a Resend hiccup
// must never fail or retry the caller's job (a watchdog alert, a published
// post, an expensive reasoning run). It returns a short status string for
// the caller to log.

const RESEND_KEY        = Deno.env.get('RESEND_API_KEY') ?? ''
const SENDER_EMAIL      = Deno.env.get('SENDER_EMAIL') ?? 'info@minuto.co.il'
const ADMIN_ALERT_EMAIL = Deno.env.get('ADMIN_ALERT_EMAIL') ?? 'erez@minuto.co.il'

export interface SendEmailArgs {
  subject: string
  html:    string
  // Defaults to ADMIN_ALERT_EMAIL (the owner). Pass an array to reach others.
  to?:     string | string[]
  // Override the From display name; address is always SENDER_EMAIL.
  fromName?: string
}

/**
 * Send one HTML email via Resend. Best-effort: returns a status string,
 * never throws. 'sent (...)' on success; 'skipped (...)' / 'failed (...)'
 * / 'error: ...' otherwise.
 */
export async function sendOwnerEmail(args: SendEmailArgs): Promise<string> {
  if (!RESEND_KEY) return 'skipped (no RESEND_API_KEY)'
  const to = args.to == null ? [ADMIN_ALERT_EMAIL] : Array.isArray(args.to) ? args.to : [args.to]
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    `${args.fromName ?? 'Minuto'} <${SENDER_EMAIL}>`,
        to,
        subject: args.subject,
        html:    args.html,
      }),
    })
    if (!res.ok) return `failed (${res.status}: ${(await res.text()).slice(0, 200)})`
    const data = await res.json().catch(() => ({} as { id?: string }))
    return `sent (${(data as { id?: string })?.id ?? 'ok'})`
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** The resolved owner address, for callers that log/branch on the recipient. */
export const OWNER_EMAIL = ADMIN_ALERT_EMAIL
