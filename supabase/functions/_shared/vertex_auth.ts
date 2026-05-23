// Service-account auth for Vertex AI from Deno Edge Runtime.
// google-auth-library is Node-only and won't run here, so we hand-roll
// the JWT-bearer flow: build a JWT, sign it with the service account's
// RSA private key, exchange it at the token endpoint for an OAuth
// access token, cache the token by its exp.
//
// Reads three env vars:
//   GCP_SERVICE_ACCOUNT_JSON  — the full service-account JSON blob (single secret value)
//   GCP_PROJECT_ID            — Vertex project ID (the JSON's project_id too, but we read separately so callers can override per-project)
//   VERTEX_LOCATION           — e.g. us-central1

interface ServiceAccountCreds {
  client_email: string
  private_key: string
  project_id: string
}

interface CachedToken {
  value: string
  expiresAt: number // ms since epoch
}

let cachedToken: CachedToken | null = null

function readCreds(): ServiceAccountCreds {
  const raw = Deno.env.get('GCP_SERVICE_ACCOUNT_JSON')
  if (!raw) throw new Error('GCP_SERVICE_ACCOUNT_JSON env var is not set')
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    throw new Error(`GCP_SERVICE_ACCOUNT_JSON is not valid JSON: ${e?.message ?? e}`)
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GCP_SERVICE_ACCOUNT_JSON missing client_email or private_key')
  }
  return parsed as ServiceAccountCreds
}

export function getVertexConfig(): { projectId: string; location: string } {
  const projectId = Deno.env.get('GCP_PROJECT_ID')
  const location  = Deno.env.get('VERTEX_LOCATION') ?? 'us-central1'
  if (!projectId) throw new Error('GCP_PROJECT_ID env var is not set')
  return { projectId, location }
}

function base64UrlEncodeString(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')
  // Plain base64 (NOT base64url) — strip nothing extra
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem)
  return await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

async function signJwt(creds: ServiceAccountCreds): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss:   creds.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  }
  const unsigned = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(claims))}`
  const key = await importRsaPrivateKey(creds.private_key)
  const sig = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)),
  )
  return `${unsigned}.${base64UrlEncodeBytes(sig)}`
}

async function fetchAccessToken(): Promise<CachedToken> {
  const creds = readCreds()
  const jwt = await signJwt(creds)
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  })
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`OAuth token exchange ${res.status}: ${errText.slice(0, 400)}`)
  }
  const json = await res.json() as { access_token: string; expires_in: number; token_type: string }
  if (!json.access_token) {
    throw new Error(`OAuth response missing access_token: ${JSON.stringify(json).slice(0, 200)}`)
  }
  // Cache until 60s before nominal expiry so concurrent calls inside that
  // window don't race against a server-side expiry.
  const expiresAt = Date.now() + (json.expires_in - 60) * 1000
  return { value: json.access_token, expiresAt }
}

export async function getVertexAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value
  }
  cachedToken = await fetchAccessToken()
  return cachedToken.value
}
