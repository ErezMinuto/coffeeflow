// Google Merchant Center (Google Shopping) product status via the Merchant API
// (products v1; the Content API for Shopping it replaces was retired in 2026).
// Read-only, except registerGcp, which runs only on an explicit
// ?mode=merchant_register call.
//
// Contract (developers.google.com/merchant/api, checked 2026-11-24):
//   GET  /accounts/v1/accounts                       → { accounts[{name:"accounts/{id}"}], nextPageToken }
//   GET  /products/v1/accounts/{id}/products         → { products[Product], nextPageToken }, pageSize ≤ 1000
//   POST /accounts/v1/accounts/{id}/developerRegistration:registerGcp  (one-time, Merchant Center ADMIN)
//   scope https://www.googleapis.com/auth/content
// A Google Cloud project that is not registered gets 401 UNAUTHENTICATED,
// "GCP project ... is not registered with the merchant account".

const BASE = 'https://merchantapi.googleapis.com'
const SEVERITY_RANK = { NONE: 0, NOT_IMPACTED: 1, DEMOTED: 2, DISAPPROVED: 3 } as const
export type Severity = keyof typeof SEVERITY_RANK

/** Why the Merchant API refused, so the caller can tell "not set up yet" from a real failure. */
export type MerchantProblem = 'no_permission' | 'not_registered' | 'no_account' | 'error'

export class MerchantError extends Error {
  constructor(public problem: MerchantProblem, message: string) { super(message) }
}

/** Classifies a Merchant API error response. */
export function classifyMerchantError(status: number, body: string): MerchantProblem {
  if (/not registered with the merchant account/i.test(body)) return 'not_registered'
  if (status === 403 && /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|PERMISSION_DENIED/i.test(body)) return 'no_permission'
  return 'error'
}

async function call(url: string, token: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
  const raw = await res.text()
  if (!res.ok) throw new MerchantError(classifyMerchantError(res.status, raw), `Merchant API ${res.status}: ${raw.slice(0, 300)}`)
  try { return raw ? JSON.parse(raw) : {} } catch { throw new MerchantError('error', `Merchant API non-JSON (${res.status}): ${raw.slice(0, 200)}`) }
}

async function listAll(url: string, token: string, field: string, pageSize: number, maxPages = 50): Promise<any[]> {
  const out: any[] = []
  let pageToken: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const u = new URL(url)
    u.searchParams.set('pageSize', String(pageSize))
    if (pageToken) u.searchParams.set('pageToken', pageToken)
    const data = await call(u.toString(), token)
    if (Array.isArray(data[field])) out.push(...data[field])
    pageToken = data.nextPageToken
    if (!pageToken) return out
  }
  throw new MerchantError('error', `Merchant API: more than ${maxPages} pages of ${field}; stopped`)
}

/** "accounts/123" → "123". */
export function accountIdFromName(name: unknown): string | null {
  const m = /^accounts\/(\d+)$/.exec(String(name ?? ''))
  return m ? m[1] : null
}

/** The Merchant Center account: GOOGLE_MERCHANT_ID if set, else the one account the login can see. */
export async function resolveAccountId(token: string, configured: string | null | undefined): Promise<string> {
  const fixed = (configured ?? '').trim()
  if (fixed) {
    if (!/^\d+$/.test(fixed)) throw new MerchantError('no_account', 'GOOGLE_MERCHANT_ID must be digits only')
    return fixed
  }
  const accounts = await listAll(`${BASE}/accounts/v1/accounts`, token, 'accounts', 250, 5)
  const ids = accounts.map((a) => accountIdFromName(a?.name)).filter((x): x is string => !!x)
  if (ids.length === 1) return ids[0]
  if (ids.length === 0) throw new MerchantError('no_account', 'the Google login has access to no Merchant Center account')
  throw new MerchantError('no_account', `the Google login sees ${ids.length} Merchant Center accounts; set GOOGLE_MERCHANT_ID to choose one`)
}

export async function listProducts(token: string, accountId: string): Promise<any[]> {
  return await listAll(`${BASE}/products/v1/accounts/${accountId}/products`, token, 'products', 1000)
}

/** One-time link of this Google Cloud project to the Merchant Center account. */
export async function registerGcp(token: string, accountId: string): Promise<{ gcpIds: string[] }> {
  const data = await call(`${BASE}/accounts/v1/accounts/${accountId}/developerRegistration:registerGcp`, token, { method: 'POST', body: '{}' })
  return { gcpIds: Array.isArray(data.gcpIds) ? data.gcpIds.map(String) : [] }
}

const list = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : []
const str = (v: unknown): string | null => typeof v === 'string' && v ? v : null

export interface MerchantRow {
  product_name: string; account_id: string; offer_id: string; content_language: string | null; feed_label: string | null
  title: string | null; link: string | null; availability: string | null
  destination_statuses: Array<{ reportingContext: string | null; approvedCountries: string[]; pendingCountries: string[]; disapprovedCountries: string[] }>
  item_issues: Array<{ code: string | null; severity: string | null; attribute: string | null; reportingContext: string | null; description: string | null; detail: string | null; documentation: string | null; applicableCountries: string[] }>
  worst_severity: Severity; approved_anywhere: boolean; disapproved_anywhere: boolean; google_expires_at: string | null
}

/** A Merchant API Product → one merchant_product_status row. Null when the product has no name. */
export function productRow(p: any, accountId: string): MerchantRow | null {
  const name = str(p?.name)
  if (!name) return null
  const st = p.productStatus ?? {}
  const dest = (Array.isArray(st.destinationStatuses) ? st.destinationStatuses : []).map((d: any) => ({
    reportingContext: str(d?.reportingContext),
    approvedCountries: list(d?.approvedCountries), pendingCountries: list(d?.pendingCountries), disapprovedCountries: list(d?.disapprovedCountries),
  }))
  const issues = (Array.isArray(st.itemLevelIssues) ? st.itemLevelIssues : []).map((i: any) => ({
    code: str(i?.code), severity: str(i?.severity), attribute: str(i?.attribute), reportingContext: str(i?.reportingContext),
    description: str(i?.description), detail: str(i?.detail), documentation: str(i?.documentation), applicableCountries: list(i?.applicableCountries),
  }))
  let worst: Severity = 'NONE'
  for (const i of issues) {
    const s = (i.severity ?? '') as Severity
    if (s in SEVERITY_RANK && SEVERITY_RANK[s] > SEVERITY_RANK[worst]) worst = s
  }
  const attrs = p.productAttributes ?? {}
  return {
    product_name: name, account_id: accountId,
    offer_id: str(p.offerId) ?? name.split('~').pop() ?? name,
    content_language: str(p.contentLanguage), feed_label: str(p.feedLabel),
    title: str(attrs.title), link: str(attrs.link), availability: str(attrs.availability),
    destination_statuses: dest, item_issues: issues, worst_severity: worst,
    approved_anywhere: dest.some((d: any) => d.approvedCountries.length > 0),
    disapproved_anywhere: dest.some((d: any) => d.disapprovedCountries.length > 0),
    google_expires_at: str(st.googleExpirationDate),
  }
}
