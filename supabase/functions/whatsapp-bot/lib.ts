// Minuto WhatsApp Advisor — the pure parts of the webhook.
//
// Everything here is free of I/O so it can be unit-tested without Meta, Gemini
// or the database (lib_test.ts). index.ts wires it to the network.

// ── Webhook authentication ──────────────────────────────────────────────────
// The function is deployed --no-verify-jwt (Meta sends no Supabase JWT), so
// this HMAC is the ONLY thing standing between the internet and a paid Gemini
// call plus a message sent from Minuto's number. On 2026-10-17 google-ads-draft
// was found answering with no credentials at all for exactly this reason.
// Meta signs the raw request body with the app secret:
//   X-Hub-Signature-256: sha256=<hex hmac>
// It must be computed over the exact bytes received, before any JSON parsing.

export async function hmacSha256Hex(secret: string, body: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, body))
  return Array.from(sig, b => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time string compare, so the check leaks nothing about how many
 *  leading characters of a forged signature were right. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyMetaSignature(
  appSecret: string,
  header: string | null,
  body: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  if (!appSecret || !header) return false
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim())
  if (!m) return false
  const expected = await hmacSha256Hex(appSecret, body)
  return timingSafeEqual(expected, m[1].toLowerCase())
}

/** The GET handshake Meta performs once when the webhook URL is saved.
 *  Returns the challenge to echo back, or null to refuse. An unset verify
 *  token refuses everything rather than matching an empty hub.verify_token. */
export function verifyHandshake(params: URLSearchParams, verifyToken: string): string | null {
  if (!verifyToken) return null
  if (params.get('hub.mode') !== 'subscribe') return null
  const token = params.get('hub.verify_token') ?? ''
  if (!timingSafeEqual(token, verifyToken)) return null
  return params.get('hub.challenge')
}

// ── Inbound payload ─────────────────────────────────────────────────────────

export interface InboundMessage {
  waMessageId: string
  waId: string             // customer's WhatsApp id (their phone number, digits only)
  phoneNumberId: string    // OUR receiving number's Cloud API id
  profileName: string | null
  type: string             // Meta's message type: text, button, interactive, image, …
  text: string | null      // what the customer said, when it is something we can read
  timestamp: string | null
  // Present on the first message from a click-to-WhatsApp ad: which ad/post
  // brought them. Stored for attribution; never shown to the model.
  referral: Record<string, unknown> | null
}

/** Flattens Meta's entry[].changes[].value envelope into the messages it
 *  carries. Delivery/read status callbacks carry no `messages` and yield []. */
export function parseInbound(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = []
  const p = payload as any
  if (p?.object !== 'whatsapp_business_account' || !Array.isArray(p.entry)) return out
  for (const entry of p.entry) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue
      const value = change.value ?? {}
      const phoneNumberId = String(value.metadata?.phone_number_id ?? '')
      const contacts: any[] = Array.isArray(value.contacts) ? value.contacts : []
      for (const msg of value.messages ?? []) {
        if (!msg?.id || !msg?.from) continue
        const contact = contacts.find(c => c?.wa_id === msg.from)
        out.push({
          waMessageId: String(msg.id),
          waId: String(msg.from),
          phoneNumberId,
          profileName: contact?.profile?.name ?? null,
          type: String(msg.type ?? 'unknown'),
          text: extractText(msg),
          timestamp: msg.timestamp ? String(msg.timestamp) : null,
          referral: msg.referral && typeof msg.referral === 'object' ? msg.referral : null,
        })
      }
    }
  }
  return out
}

// ── Coexistence: messages the team sends from the WhatsApp Business app ─────
// The number is shared between this bot and the Business app on the shop's
// phone. Meta reports what a person types in the app as `smb_message_echoes`
// (from = our number, to = the customer). index.ts treats any echo in a lead's
// chat as a human taking over, and the bot stays silent there for good.

export interface EchoMessage {
  waMessageId: string
  waId: string             // the CUSTOMER the team member wrote to
  phoneNumberId: string
  type: string
  text: string | null
}

export function parseEchoes(payload: unknown): EchoMessage[] {
  const out: EchoMessage[] = []
  const p = payload as any
  if (p?.object !== 'whatsapp_business_account' || !Array.isArray(p.entry)) return out
  for (const entry of p.entry) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'smb_message_echoes') continue
      const value = change.value ?? {}
      const phoneNumberId = String(value.metadata?.phone_number_id ?? '')
      for (const msg of value.message_echoes ?? []) {
        if (!msg?.id || !msg?.to) continue
        out.push({
          waMessageId: String(msg.id),
          waId: String(msg.to),
          phoneNumberId,
          type: String(msg.type ?? 'unknown'),
          text: extractText(msg),
        })
      }
    }
  }
  return out
}

function extractText(msg: any): string | null {
  switch (msg.type) {
    case 'text':        return nonEmpty(msg.text?.body)
    case 'button':      return nonEmpty(msg.button?.text)
    case 'interactive': return nonEmpty(msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title)
    default:            return null   // image, audio, sticker, location… not handled on day one
  }
}

function nonEmpty(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === '' ? null : s
}

/** WHATSAPP_TEST_WA_IDS → set of WhatsApp ids. Meta's wa_id is digits only, so
 *  "+972-54-123 4567" and "972541234567" both match. Entries too short to be a
 *  phone number are dropped rather than matching something by accident. */
export function parseWaIdList(raw: string | undefined | null): Set<string> {
  return new Set(
    (raw ?? '').split(',').map(x => x.replace(/\D/g, '')).filter(x => x.length >= 8),
  )
}

/** Logs must not hold a customer's full phone number. */
export function maskWaId(waId: string): string {
  return waId.length <= 4 ? '****' : `${'*'.repeat(waId.length - 4)}${waId.slice(-4)}`
}

// ── Conversation → Gemini ───────────────────────────────────────────────────

export interface StoredMessage {
  direction: 'in' | 'out' | 'human'   // human = a team member writing from the Business app
  body: string
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: { text: string }[]
}

/** Gemini requires the history to start with a user turn and to alternate.
 *  Consecutive messages from the same side (a customer sending three lines in
 *  a row) are merged into one turn rather than dropped. */
export function toGeminiContents(history: StoredMessage[]): GeminiContent[] {
  const out: GeminiContent[] = []
  for (const m of history) {
    const role = m.direction === 'in' ? 'user' : 'model'
    const last = out[out.length - 1]
    if (last && last.role === role) last.parts[0].text += `\n${m.body}`
    else out.push({ role, parts: [{ text: m.body }] })
  }
  while (out.length && out[0].role !== 'user') out.shift()
  return out
}

// ── Catalog ─────────────────────────────────────────────────────────────────
// Mirrors fetchMinutoCoffeeCatalog (seo-agent/services/cmsApi.ts): Minuto's own
// roasted line only, never green coffee or resold Veneto/Toddy. Kept as a copy
// rather than an import so a change here can never redeploy the SEO stack.

export const MINUTO_COFFEE_CATEGORIES = [
  'פולי קפה טרי - קפה ספשלטי specialty coffee',
  'תערובות קפה מינוטו',
]

export function isOffBrand(name: string): boolean {
  return /ירוק|green coffee|unroasted|raw coffee|veneto|ונטו|toddy|טודי/i.test(name)
}

export interface CatalogProduct {
  name: string
  price: string | null
  permalink: string | null
  stock_status: string | null
  short_description: string | null
  description: string | null
}

const MAX_DESC = 700

/** The catalog block the model is grounded in. The model may recommend ONLY
 *  products listed here, and only with facts stated here: the blog writer once
 *  received names alone and invented every attribute (2026-09-02). */
export function formatCatalog(products: CatalogProduct[]): string {
  const inStock = products.filter(p => !isOffBrand(p.name) && p.stock_status !== 'outofstock')
  if (!inStock.length) return '(הקטלוג לא זמין כרגע)'
  return inStock.map(p => {
    const desc = (p.short_description || p.description || '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESC)
    return [
      `- ${p.name}`,
      p.price ? `  מחיר: ₪${p.price}` : null,
      p.permalink ? `  קישור: ${p.permalink}` : null,
      desc ? `  תיאור: ${desc}` : '  תיאור: (אין תיאור, אל תמציאו מאפיינים)',
    ].filter(Boolean).join('\n')
  }).join('\n')
}

// ── Outbound ────────────────────────────────────────────────────────────────

// WhatsApp reply buttons: at most 3 per message, each title at most 20
// characters, and the message body at most 1024 characters. Sent inside an
// open customer conversation they need no template.
export const MAX_BUTTONS = 3
export const MAX_BUTTON_TITLE = 20
export const MAX_INTERACTIVE_BODY = 1024

export interface BotReply {
  text: string
  buttons: string[]
}

/** Cleans the model's button labels into something the Cloud API accepts:
 *  trimmed, non-empty, unique, at most 3, each cut to 20 characters. */
export function sanitizeButtons(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const b of raw) {
    const t = typeof b === 'string' ? b.replace(/\s+/g, ' ').trim().slice(0, MAX_BUTTON_TITLE).trim() : ''
    if (t && !out.includes(t)) out.push(t)
    if (out.length === MAX_BUTTONS) break
  }
  return out
}

/** The model answers {"text": "...", "buttons": ["..."]}. Anything that is not
 *  that shape is treated as plain text, so a malformed answer still reaches
 *  the customer as a message instead of failing the reply. */
export function parseBotReply(raw: string): BotReply {
  const trimmed = raw.trim()
  try {
    const j = JSON.parse(trimmed)
    if (j && typeof j === 'object' && typeof j.text === 'string' && j.text.trim()) {
      return { text: j.text.trim(), buttons: sanitizeButtons(j.buttons) }
    }
  } catch { /* plain text */ }
  return { text: trimmed, buttons: [] }
}

/** Cloud API message bodies for one reply. Long text goes out as plain
 *  messages first; the buttons ride on the last part when it fits the
 *  1024-character interactive limit, and are dropped otherwise. */
export function buildOutboundMessages(waId: string, reply: BotReply): { body: Record<string, unknown>; text: string; buttons: string[] }[] {
  const parts = splitForWhatsApp(reply.text)
  const last = parts[parts.length - 1]
  const withButtons = reply.buttons.length > 0 && last !== undefined && last.length <= MAX_INTERACTIVE_BODY
  return parts.map((part, i) => {
    const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: waId }
    if (withButtons && i === parts.length - 1) {
      return {
        text: part,
        buttons: reply.buttons,
        body: {
          ...base,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: part },
            action: { buttons: reply.buttons.map((title, n) => ({ type: 'reply', reply: { id: `opt${n + 1}`, title } })) },
          },
        },
      }
    }
    return { text: part, buttons: [], body: { ...base, type: 'text', text: { body: part, preview_url: true } } }
  })
}

const WA_TEXT_LIMIT = 4096

/** WhatsApp rejects text bodies over 4096 characters. Split on paragraph,
 *  then line, then hard boundaries so a long answer still arrives whole. */
export function splitForWhatsApp(text: string, limit = WA_TEXT_LIMIT): string[] {
  const clean = text.trim()
  if (clean.length <= limit) return clean ? [clean] : []
  const parts: string[] = []
  let rest = clean
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = window.lastIndexOf('\n\n')
    if (cut < limit / 2) cut = window.lastIndexOf('\n')
    if (cut < limit / 2) cut = window.lastIndexOf(' ')
    if (cut < limit / 2) cut = limit
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}
