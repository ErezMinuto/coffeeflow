// Tests for the role gate (role_caller.ts).
//
//   deno run --allow-net --allow-env --allow-read supabase/functions/_shared/role_caller_test.ts
//   deno run --allow-net --allow-env --allow-read supabase/functions/_shared/role_caller_test.ts meta-ads-draft
//   deno run --allow-net --allow-env --allow-read supabase/functions/_shared/role_caller_test.ts attendance-export
//
// The fake backend behaves like Supabase where it matters: PostgREST rejects a
// token whose signature it doesn't recognise (401), get_role_for_user answers
// from a user_roles table, and only a service-role key may list Auth users.
// With a function name, that function is booted and every request it would
// make to anything else is recorded, so "refused" also means "did nothing".

import { callerRole, hasRole } from './role_caller.ts'

const URL_ = 'http://backend.test'
const SERVICE = 'test-service-role'
const ANON = 'test-anon-key'
const ROLES: Record<string, string> = { user_admin: 'admin', user_sched: 'schedule_manager', user_emp: 'employee' }

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const jwt = (payload: Record<string, unknown>, sig = 'valid-signature') => `${b64({ alg: 'HS256' })}.${b64(payload)}.${sig}`
const ADMIN = jwt({ sub: 'user_admin', role: 'authenticated' })
const SCHED = jwt({ sub: 'user_sched', role: 'authenticated' })
const EMP = jwt({ sub: 'user_emp', role: 'authenticated' })
const STRANGER = jwt({ sub: 'user_nobody', role: 'authenticated' })            // signed in, no user_roles row
const FORGED_ADMIN = jwt({ sub: 'user_admin', role: 'authenticated' }, 'forged')
const ANON_JWT = jwt({ role: 'anon' })                                          // valid, but no sub

const fake: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const h = new Headers(init?.headers)
  if (url.startsWith(`${URL_}/auth/v1/admin/users`)) {
    return new Response('{}', { status: h.get('apikey') === SERVICE ? 200 : 401 })
  }
  if (url === `${URL_}/rest/v1/rpc/get_role_for_user`) {
    const token = (h.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (!token.endsWith('.valid-signature')) return new Response('{"message":"JWSError"}', { status: 401 })
    const { p_user_id } = JSON.parse(String(init?.body ?? '{}'))
    return new Response(JSON.stringify(ROLES[p_user_id] ?? 'employee'), { status: 200 })
  }
  return new Response('not faked', { status: 599 })
}

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? `\n      ${detail}` : ''}`)
  if (!ok) failures++
}
const req = (headers: Record<string, string>) => new Request('http://fn', { method: 'POST', headers })
const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, apikey: ANON })
const opts = { supabaseUrl: URL_, serviceKey: SERVICE, anonKey: ANON, fetchFn: fake }
const target = Deno.args[0]

if (!target) {
  check('service-role key → service', await callerRole(req({ Authorization: `Bearer ${SERVICE}` }), opts) === 'service')
  check('admin Clerk token → admin', await callerRole(req(bearer(ADMIN)), opts) === 'admin')
  check('schedule manager token → schedule_manager', await callerRole(req(bearer(SCHED)), opts) === 'schedule_manager')
  check('employee token → employee', await callerRole(req(bearer(EMP)), opts) === 'employee')
  check('signed-in user with no role row → employee', await callerRole(req(bearer(STRANGER)), opts) === 'employee')
  check('FORGED token claiming an admin sub → no role', await callerRole(req(bearer(FORGED_ADMIN)), opts) === null)
  check('the anon key (valid JWT, no sub) → no role', await callerRole(req(bearer(ANON_JWT)), opts) === null)
  check('no credentials → no role', await callerRole(req({}), opts) === null)
  check('garbage bearer → no role', await callerRole(req(bearer('not.a.jwt')), opts) === null)
  check('database unreachable → no role', await callerRole(req(bearer(ADMIN)), { ...opts, fetchFn: async (i, n) => String(i).includes('/rpc/') ? Promise.reject(new Error('down')) : fake(i, n) }) === null)
  check('hasRole: admin allowed for [admin]', await hasRole(req(bearer(ADMIN)), ['admin'], opts))
  check('hasRole: schedule manager refused for [admin]', !(await hasRole(req(bearer(SCHED)), ['admin'], opts)))
  check('hasRole: service allowed whatever the list', await hasRole(req({ Authorization: `Bearer ${SERVICE}` }), ['admin'], opts))
} else {
  Deno.env.set('SUPABASE_URL', URL_)
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', SERVICE)
  Deno.env.set('SUPABASE_ANON_KEY', ANON)
  Deno.env.set('LOG_TO_DB', 'false')
  Deno.env.set('RESEND_API_KEY', 'test-resend')
  const outbound: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('http://localhost:8000')) return realFetch(input, init)
    if (url.startsWith(`${URL_}/auth/v1/admin/users`) || url === `${URL_}/rest/v1/rpc/get_role_for_user`) return fake(input, init)
    outbound.push(url.replace(/\?.*/, ''))
    return new Response(JSON.stringify({ error: 'blocked by test' }), { status: 503 })
  }) as typeof fetch

  await import(`../${target}/index.ts`)
  const post = async (headers: Record<string, string>, body: unknown) => {
    outbound.length = 0
    const res = await realFetch('http://localhost:8000/', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: res.status, text: await res.text(), outbound: [...outbound] }
  }

  const isMeta = target === 'meta-ads-draft'
  const body = isMeta ? { action: 'delete', campaign_id: '120000000000000' } : { mode: 'send', year_month: '2026-09' }
  console.log(`── ${target}`)
  // [name, headers, allowed here?]
  const cases: Array<[string, Record<string, string>, boolean]> = [
    ['no credentials', {}, false],
    ['the anon key', bearer(ANON_JWT), false],
    ['a forged admin token', bearer(FORGED_ADMIN), false],
    ['an employee', bearer(EMP), false],
    ['a signed-in user with no role', bearer(STRANGER), false],
    ['a schedule manager', bearer(SCHED), !isMeta],
    ['an admin', bearer(ADMIN), true],
    ['the service role', { Authorization: `Bearer ${SERVICE}` }, true],
  ]
  for (const [name, headers, shouldPass] of cases) {
    const r = await post(headers, body)
    if (shouldPass) {
      check(`${name} → gets past the gate`, r.status !== 403, `${r.status} ${r.text.slice(0, 100)}`)
    } else {
      check(`${name} → 403`, r.status === 403, `${r.status} ${r.text.slice(0, 100)}`)
      check(`…and nothing was called`, r.outbound.length === 0, r.outbound.join(', '))
    }
  }

  if (!isMeta) {
    for (const [name, b] of [['no mode', { year_month: '2026-09' }], ['an unknown mode', { mode: 'email', year_month: '2026-09' }], ['an empty body', {}]] as const) {
      const r = await post(bearer(ADMIN), b)
      check(`admin with ${name} → 400, not an email`, r.status === 400 && /mode/.test(r.text), `${r.status} ${r.text.slice(0, 100)}`)
      check(`…and nothing was read or sent`, r.outbound.length === 0, r.outbound.join(', '))
    }
  }

  const pre = await realFetch('http://localhost:8000/', { method: 'OPTIONS' })
  await pre.body?.cancel()
  check('CORS preflight still answers without a key', pre.status === 200 || pre.status === 204)
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`)
Deno.exit(failures === 0 ? 0 : 1)
