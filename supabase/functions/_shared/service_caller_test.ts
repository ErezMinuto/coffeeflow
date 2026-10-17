// Tests for the service-role gate (service_caller.ts).
//
//   deno run --allow-net --allow-env supabase/functions/_shared/service_caller_test.ts
//   deno run --allow-net --allow-env supabase/functions/_shared/service_caller_test.ts stock-update
//   deno run --allow-net --allow-env supabase/functions/_shared/service_caller_test.ts organic-orchestrator
//
// With no argument it unit-tests the gate. With a function name it boots that
// function and proves a refused caller gets 401 before the function makes a
// single outbound request — no MFlow call, no database write, no model call.

import { isServiceCaller } from './service_caller.ts'

const SERVICE = 'test-service-role'
const SERVICE_OTHER_FORMAT = 'test-service-role-legacy-jwt'
const ANON = 'test-anon-key'
const URL_ = 'http://auth.test'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? `\n      ${detail}` : ''}`)
  if (!ok) failures++
}

// Behaves like Supabase Auth: only a service-role key may list users.
const fakeAuth: typeof fetch = async (_input, init) => {
  const key = new Headers(init?.headers).get('apikey')
  const status = key === SERVICE || key === SERVICE_OTHER_FORMAT ? 200 : key === ANON ? 403 : 401
  return new Response('{}', { status })
}
const req = (headers: Record<string, string>) => new Request('http://fn', { method: 'POST', headers })
const opts = { supabaseUrl: URL_, serviceKey: SERVICE, fetchFn: fakeAuth }

const target = Deno.args[0]

if (!target) {
  check('no credentials → refused', !(await isServiceCaller(req({}), opts)))
  check('the public anon key → refused', !(await isServiceCaller(req({ Authorization: `Bearer ${ANON}`, apikey: ANON }), opts)))
  check('a made-up key → refused', !(await isServiceCaller(req({ Authorization: 'Bearer nope' }), opts)))
  check('the service-role key (bearer) → accepted', await isServiceCaller(req({ Authorization: `Bearer ${SERVICE}` }), opts))
  check('the service-role key (apikey only) → accepted', await isServiceCaller(req({ apikey: SERVICE }), opts))
  check('the service role in its other key format → accepted', await isServiceCaller(req({ Authorization: `Bearer ${SERVICE_OTHER_FORMAT}` }), opts))
  check('a prefix of the real key → refused', !(await isServiceCaller(req({ Authorization: `Bearer ${SERVICE.slice(0, -1)}` }), { ...opts, fetchFn: async () => new Response('', { status: 401 }) })))
  check('Auth unreachable → refused, not accepted', !(await isServiceCaller(req({ Authorization: 'Bearer nope' }), { ...opts, fetchFn: async () => { throw new Error('down') } })))
} else {
  // Boot the real function with every outbound request recorded. Auth admin
  // answers like the real one; anything else counts as the function acting.
  Deno.env.set('SUPABASE_URL', URL_)
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', SERVICE)
  Deno.env.set('SUPABASE_ANON_KEY', ANON)
  Deno.env.set('LOG_TO_DB', 'false')
  const outbound: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('http://localhost:8000')) return realFetch(input, init)
    if (url.startsWith(`${URL_}/auth/v1/admin/users`)) return fakeAuth(input, init)
    outbound.push(url)
    return new Response(JSON.stringify({ error: 'blocked by test' }), { status: 503 })
  }) as typeof fetch

  await import(`../${target}/index.ts`)
  const post = async (headers: Record<string, string>, body = '{"action":"mflow_sync_sells","apply":true,"trigger":"cron"}') => {
    const res = await realFetch('http://localhost:8000/', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })
    const text = await res.text()
    return { status: res.status, text }
  }

  console.log(`── ${target}`)
  for (const [name, headers] of [
    ['no credentials', {}],
    ['the public anon key', { Authorization: `Bearer ${ANON}`, apikey: ANON }],
    ['a made-up key', { Authorization: 'Bearer nope' }],
  ] as const) {
    outbound.length = 0
    const r = await post(headers)
    check(`${name} → 401`, r.status === 401, `${r.status} ${r.text.slice(0, 120)}`)
    check(`…and the function did nothing (no outbound request)`, outbound.length === 0, outbound.join(', '))
  }

  outbound.length = 0
  const ok = await post({ Authorization: `Bearer ${SERVICE}` })
  check('the service-role key gets past the gate', ok.status !== 401, `${ok.status} ${ok.text.slice(0, 120)}`)

  const preflight = await realFetch('http://localhost:8000/', { method: 'OPTIONS' })
  await preflight.body?.cancel()
  check('CORS preflight still answers without a key', preflight.status === 200)
}

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`)
Deno.exit(failures === 0 ? 0 : 1)
