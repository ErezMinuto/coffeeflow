// Gate for edge functions that a signed-in staff member may call from the
// browser, as well as the service role (cron, other functions).
//
// The frontends send the user's Clerk JWT (the `supabase` JWT template) as
// Authorization. To learn the caller's role we ask the database WITH that
// token: PostgREST rejects a token whose signature or expiry is bad, so a 200
// means the token is genuine and the `sub` read from it can be trusted. The
// role itself comes from public.get_role_for_user — the same source the
// frontends use for isAdmin / canSchedule.
//
// The anon key is a valid JWT too, but it has no `sub`, so it never maps to a
// role. A token is never decoded and trusted on its own.

import { isServiceCaller } from './service_caller.ts'

export type CallerRole = 'service' | 'admin' | 'schedule_manager' | 'employee' | string

export async function callerRole(
  req: Request,
  opts: { supabaseUrl?: string; serviceKey?: string; anonKey?: string; fetchFn?: typeof fetch } = {},
): Promise<CallerRole | null> {
  const supabaseUrl = opts.supabaseUrl ?? Deno.env.get('SUPABASE_URL') ?? ''
  const doFetch = opts.fetchFn ?? fetch
  if (await isServiceCaller(req, { supabaseUrl, serviceKey: opts.serviceKey, fetchFn: doFetch })) return 'service'

  const token = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  const sub = token ? jwtSub(token) : null
  if (!token || !sub || !supabaseUrl) return null

  // apikey identifies the project; the caller's own (the anon key the
  // frontend sends) is preferred, the function's env copy is the fallback.
  const apikey = req.headers.get('apikey')?.trim() || opts.anonKey || Deno.env.get('SUPABASE_ANON_KEY') || ''
  try {
    const res = await doFetch(`${supabaseUrl}/rest/v1/rpc/get_role_for_user`, {
      method: 'POST',
      headers: { apikey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user_id: sub }),
    })
    if (!res.ok) { await res.body?.cancel(); return null }
    const role = await res.json()
    return typeof role === 'string' && role ? role : null
  } catch {
    return null
  }
}

// True when the caller is the service role or holds one of `roles`.
export async function hasRole(
  req: Request,
  roles: string[],
  opts: Parameters<typeof callerRole>[1] = {},
): Promise<boolean> {
  const role = await callerRole(req, opts)
  return role === 'service' || (role != null && roles.includes(role))
}

export function forbidden(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error: 'forbidden — sign in with an account allowed to do this' }), {
    status: 403,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })
}

// Reads the claim only; whether the token is genuine is decided by PostgREST.
function jwtSub(token: string): string | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')))
    return typeof json.sub === 'string' && json.sub ? json.sub : null
  } catch {
    return null
  }
}
