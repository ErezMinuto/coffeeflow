// Gate for edge functions that only pg_cron (or another function) may call.
//
// A function deployed with verify_jwt off checks nobody, and even with
// verify_jwt on the gateway accepts the public anon key — it ships in the
// frontend bundle. Anything acting with the service role on cron's behalf has
// to check the caller itself.
//
// A plain comparison covers the usual case. The same project's service role
// can also arrive in the other key format — legacy eyJ JWT vs sb_secret_ (the
// cron jobs send the vault copy, the function's env may hold either) — and
// the two never compare equal, so a key that doesn't match is asked about
// instead: only a service-role key may list Auth users.
//
// Same check as google-ads-draft/guards.ts (isServiceCaller).

export async function isServiceCaller(
  req: Request,
  opts: { supabaseUrl?: string; serviceKey?: string; fetchFn?: typeof fetch } = {},
): Promise<boolean> {
  const supabaseUrl = opts.supabaseUrl ?? Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = opts.serviceKey ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const token = bearer(req) ?? req.headers.get('apikey')?.trim() ?? ''
  if (!token) return false
  if (serviceKey && constantTimeEqual(token, serviceKey)) return true
  if (!supabaseUrl) return false
  try {
    const res = await (opts.fetchFn ?? fetch)(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: token, Authorization: `Bearer ${token}` },
    })
    await res.body?.cancel()
    return res.ok
  } catch {
    return false
  }
}

// The response a refused caller gets. No detail beyond what is required.
export function unauthorized(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error: 'unauthorized — this function only accepts the service-role key' }), {
    status: 401,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })
}

function bearer(req: Request): string | null {
  const m = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
