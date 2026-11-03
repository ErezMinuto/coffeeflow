// The ONLY way the strategist loop reaches meta-ads-draft / google-ads-draft.
//
// Both functions accept the service-role key (marketing-advisor uses it for
// chat edits Erez approves one by one), so the loop's limits live here:
//   • actions: dry_run and create only. Google validation is create with
//     validate_only:true. Never update_campaign / update_targeting / delete /
//     anything that touches a campaign that already exists.
//   • a create always makes a NEW campaign, which both functions create PAUSED.
//     Only Erez activates an ad.
//   • the body may not carry a campaign id or a status: a draft never edits,
//     re-targets or switches on anything.
// Plan: docs/plans/2026-11-02-strategist-closed-loop.md, A7.

export type AdPlatform = 'meta' | 'google'
export type LoopAdAction = 'dry_run' | 'create'

const FN: Record<AdPlatform, string> = { meta: 'meta-ads-draft', google: 'google-ads-draft' }
const ALLOWED: ReadonlySet<string> = new Set<LoopAdAction>(['dry_run', 'create'])
// Keys that would point a request at an existing campaign or change a status.
const FORBIDDEN_KEYS = /^(campaign_id|campaignid|ad_set_id|adset_id|ad_id|status|effective_status|existing_post)$/i

function forbiddenKey(value: unknown, path = 'body'): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) { const hit = forbiddenKey(value[i], `${path}[${i}]`); if (hit) return hit }
    return null
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.test(k)) return `${path}.${k}`
      const hit = forbiddenKey(v, `${path}.${k}`)
      if (hit) return hit
    }
  }
  return null
}

export interface LoopAdsDeps {
  supabaseUrl: string
  serviceKey:  string
  fetchFn?:    typeof fetch
  timeoutMs?:  number
}

/** Refuses before any network call if the request is outside the loop's limits. */
export function assertLoopAdRequest(platform: string, action: string, body: Record<string, unknown>): void {
  if (platform !== 'meta' && platform !== 'google') throw new Error(`loop ads: unknown platform '${platform}'`)
  if (!ALLOWED.has(action)) throw new Error(`loop ads: action '${action}' is not allowed (only dry_run, create)`)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('loop ads: body must be an object')
  if ('action' in body) throw new Error('loop ads: body may not set its own action')
  const hit = forbiddenKey(body)
  if (hit) throw new Error(`loop ads: ${hit} is not allowed (the loop never targets an existing campaign or sets a status)`)
  if (typeof body.idea_id !== 'string' || !body.idea_id.startsWith('srec:')) {
    throw new Error("loop ads: idea_id must be 'srec:<recommendation id>' so the draft is traceable and idempotent")
  }
}

export async function callLoopAds(
  deps: LoopAdsDeps,
  platform: AdPlatform,
  action: LoopAdAction,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assertLoopAdRequest(platform, action, body)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 90_000)
  try {
    const res = await (deps.fetchFn ?? fetch)(`${deps.supabaseUrl}/functions/v1/${FN[platform]}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.serviceKey}`, apikey: deps.serviceKey },
      // action last, so nothing in body can override it.
      body:    JSON.stringify({ ...body, action }),
      signal:  ctrl.signal,
    })
    const text = await res.text()
    let json: Record<string, unknown>
    try { json = JSON.parse(text) } catch { throw new Error(`${FN[platform]} ${action}: non-JSON response (${res.status}): ${text.slice(0, 200)}`) }
    if (!res.ok || json.ok === false || json.success === false || typeof json.error === 'string') {
      throw new Error(`${FN[platform]} ${action} failed (${res.status}): ${String(json.error ?? text).slice(0, 500)}`)
    }
    return json
  } finally {
    clearTimeout(timer)
  }
}
