// Signed unsubscribe links, shared by every function that sends marketing email
// (generate-campaign, email-automation-scheduler) and by the public
// GET ?action=unsubscribe handler in generate-campaign.
//
// The link has to work without a login (it is in every email), so the token is
// what proves the address came from us: `v1.<base64url HMAC-SHA256(key,
// "unsubscribe:v1:" + email)>`. No timestamp: an unsubscribe link must keep
// working for as long as the email exists.
//
// Key: UNSUBSCRIBE_SECRET (a dedicated Supabase secret). Until that is set, a
// key derived from SUPABASE_SERVICE_ROLE_KEY signs instead, and verification
// tries every key available, so setting the secret later doesn't break links
// already sent. Rotating the service-role key while it is still the signer does.
//
// Old links (sent before this change) carry `btoa(email:millis)`, which anyone
// can forge. They are still honoured until LEGACY_ACCEPT_UNTIL, so people who
// click an old email are unsubscribed, and every use is logged.

export const LEGACY_ACCEPT_UNTIL = Date.parse('2026-12-20T00:00:00Z')

export const normalizeEmail = (email: string) => email.toLowerCase().trim()

type Env = { get(name: string): string | undefined }

function keyMaterials(env: Env): string[] {
  const dedicated = env.get('UNSUBSCRIBE_SECRET')?.trim()
  const service = env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim()
  const out: string[] = []
  if (dedicated) out.push(dedicated)
  // Domain-separated so the HMAC is never computed under the raw service key.
  if (service) out.push(`unsubscribe-link-key:${service}`)
  return out
}

const enc = new TextEncoder()
const message = (email: string) => enc.encode(`unsubscribe:v1:${normalizeEmail(email)}`)

function importKey(material: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey('raw', enc.encode(material), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

const toB64url = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
    const out = new Uint8Array(new ArrayBuffer(bin.length))
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export async function signUnsubscribeToken(email: string, env: Env = Deno.env): Promise<string> {
  const [material] = keyMaterials(env)
  if (!material) throw new Error('unsubscribe links: neither UNSUBSCRIBE_SECRET nor SUPABASE_SERVICE_ROLE_KEY is set')
  const sig = await crypto.subtle.sign('HMAC', await importKey(material, 'sign'), message(email))
  return `v1.${toB64url(sig)}`
}

export async function unsubscribeUrl(base: string, email: string, env: Env = Deno.env): Promise<string> {
  const token = await signUnsubscribeToken(email, env)
  return `${base}?action=unsubscribe&email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`
}

export type TokenCheck = 'valid' | 'legacy' | 'invalid'

// 'valid'   : signed by us for this address.
// 'legacy'  : old btoa(email:millis) format for this address, inside the transition window.
// 'invalid' : anything else (wrong address, bad signature, legacy after the window).
export async function checkUnsubscribeToken(
  email: string, token: string, env: Env = Deno.env, now = Date.now(),
): Promise<TokenCheck> {
  if (token.startsWith('v1.')) {
    const sig = fromB64url(token.slice(3))
    if (!sig || sig.length !== 32) return 'invalid'
    for (const material of keyMaterials(env)) {
      // crypto.subtle.verify compares in constant time.
      if (await crypto.subtle.verify('HMAC', await importKey(material, 'verify'), sig, message(email))) return 'valid'
    }
    return 'invalid'
  }
  if (now >= LEGACY_ACCEPT_UNTIL) return 'invalid'
  let decoded: string
  try {
    decoded = atob(token)
  } catch {
    return 'invalid'
  }
  const sep = decoded.lastIndexOf(':')
  if (sep < 1 || !/^\d{12,14}$/.test(decoded.slice(sep + 1))) return 'invalid'
  return normalizeEmail(decoded.slice(0, sep)) === normalizeEmail(email) ? 'legacy' : 'invalid'
}
