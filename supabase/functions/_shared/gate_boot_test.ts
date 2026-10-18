// Boot test for the caller gates on functions that run with verify_jwt=false.
//
//   bash scripts/ci/gate-boot-tests.sh            # every function in GATES, one process each
//   bash scripts/ci/gate-boot-tests.sh <function>
//
// Run it through the script, not `deno run` by hand: the script gives the
// test an empty environment and a localhost-only network, so the functions it
// boots can never see or send the real secrets a local shell may carry.
//
// Boots the real function with every outbound request recorded, then sends it
// requests from each kind of caller. A refused caller must get 401/403 AND the
// function must not have made a single outbound request (no Woo, Meta, Google,
// Telegram, Resend, model or database call). An allowed caller must get past
// the gate; what happens after that is blocked by the test (503s).
//
// The fake backend behaves like Supabase where it matters: only a service-role
// key may list Auth users, PostgREST rejects a token whose signature it doesn't
// recognise, and get_role_for_user answers from a user_roles table.

const URL_ = 'http://backend.test'
const SERVICE = 'test-service-role'
const ANON = 'test-anon-key'
const ROLES: Record<string, string> = { user_admin: 'admin', user_sched: 'schedule_manager', user_emp: 'employee' }

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const jwt = (payload: Record<string, unknown>, sig = 'valid-signature') => `${b64({ alg: 'HS256' })}.${b64(payload)}.${sig}`
const ADMIN = jwt({ sub: 'user_admin', role: 'authenticated' })
const SCHED = jwt({ sub: 'user_sched', role: 'authenticated' })
const EMP = jwt({ sub: 'user_emp', role: 'authenticated' })
const STRANGER = jwt({ sub: 'user_nobody', role: 'authenticated' })
const FORGED_ADMIN = jwt({ sub: 'user_admin', role: 'authenticated' }, 'forged')
const ANON_JWT = jwt({ role: 'anon' })

type Caller = 'none' | 'anon' | 'madeup' | 'forged_admin' | 'employee' | 'stranger' | 'schedule_manager' | 'admin' | 'service'
const HEADERS: Record<Caller, Record<string, string>> = {
  none: {},
  anon: { Authorization: `Bearer ${ANON_JWT}`, apikey: ANON },
  madeup: { Authorization: 'Bearer nope' },
  forged_admin: { Authorization: `Bearer ${FORGED_ADMIN}`, apikey: ANON },
  employee: { Authorization: `Bearer ${EMP}`, apikey: ANON },
  stranger: { Authorization: `Bearer ${STRANGER}`, apikey: ANON },
  schedule_manager: { Authorization: `Bearer ${SCHED}`, apikey: ANON },
  admin: { Authorization: `Bearer ${ADMIN}`, apikey: ANON },
  service: { Authorization: `Bearer ${SERVICE}`, apikey: SERVICE },
}
const ALL: Caller[] = ['none', 'anon', 'madeup', 'forged_admin', 'employee', 'stranger', 'schedule_manager', 'admin', 'service']

// One request shape per gate. `allow` lists who gets through; everyone else
// must be refused with nothing called.
type Case = { name: string; path?: string; method?: string; headers?: Record<string, string>; body?: unknown; allow: Caller[] }
const SERVICE_ONLY: Caller[] = ['service']
const ADMIN_ONLY: Caller[] = ['admin', 'service']
const SCHEDULERS: Caller[] = ['admin', 'schedule_manager', 'service']
const svc = (body: unknown): Case[] => [{ name: 'POST', body, allow: SERVICE_ONLY }]
const adm = (body: unknown): Case[] => [{ name: 'POST', body, allow: ADMIN_ONLY }]

export const GATES: Record<string, { cases: Case[]; preflight?: boolean; env?: Record<string, string> }> = {
  'blog-publish': { cases: svc({ title: 't', content_markdown: 'x', status: 'publish' }) },
  'set-post-faq': { cases: svc({ post_id: 1, faq: [] }) },
  'set-product-faq': { cases: svc({ product_id: 1, faq: [] }) },
  'update-product-description': { cases: svc({ product_id: 1, replacements: [{ find: 'a', replace: 'b' }], dry_run: false }) },
  'generate-product-faq': { cases: svc({ product_id: 1 }) },
  'green-stock-alert': { cases: svc({}) },
  'visual-overlay': { cases: svc({ image_url: 'https://example.test/a.png', overlay_text: 'x' }) },
  'rfm-sync': { cases: svc({}) },
  'purge-old-media': { cases: svc({ commit: true }) },
  'attendance-reminder': { cases: svc({}) },
  'woo-stock-check': { cases: svc({}), preflight: false },
  'woo-products-enrich': { cases: svc({}) },
  'ga4-sync': { cases: svc({ diagnostic: true }) },
  'meta-publish': { cases: adm({ action: 'publish_now', type: 'feed', image_url: 'https://example.test/a.png', caption: 'x' }) },
  'email-automation-scheduler': { cases: adm({ test_send: 'someone@example.test' }) },
  'google-exchange-token': { cases: adm({ code: 'x', redirect_uri: 'https://example.test' }) },
  'meta-exchange-token': { cases: adm({ code: 'x', redirect_uri: 'https://example.test' }) },
  'clerk-user-lookup': { cases: adm({ email: 'someone@example.test' }) },
  'meta-sync': { cases: adm({}), env: { META_AD_ACCOUNT_ID: 'act_test' } },
  'woo-orders-sync': { cases: adm({ count_only: true, days_back: 1 }) },
  'google-search-sync': { cases: adm({}) },
  'export-to-sheets': { cases: [{ name: 'POST', body: { schedule_id: 1, week_start: '2026-10-18' }, allow: SCHEDULERS }] },
  'generate-campaign': {
    env: { RESEND_AUDIENCE_ID: 'test-audience' },
    cases: [
      { name: 'send-campaign', body: { action: 'send-campaign', campaignId: 1, userId: 'u' }, allow: ADMIN_ONLY },
      { name: 'sync-resend-contacts', body: { action: 'sync-resend-contacts', userId: 'u' }, allow: ADMIN_ONLY },
      { name: 'subscribe (public on purpose)', body: { action: 'subscribe', email: 'someone@example.test' }, allow: ALL },
      { name: 'GET unsubscribe (public on purpose)', method: 'GET', path: '?action=unsubscribe&email=someone@example.test&token=x', allow: ALL },
    ],
  },
  'employee-bot': {
    // No webhook secret configured: the Telegram path must refuse everything.
    env: { EMPLOYEE_BOT_WEBHOOK_SECRET: '' },
    cases: [
      { name: '?action=publish', path: '?action=publish', body: { text: 'x' }, allow: SCHEDULERS },
      { name: 'x-action: remind', headers: { 'x-action': 'remind' }, body: {}, allow: SCHEDULERS },
      { name: '?action=confirm-opening', path: '?action=confirm-opening', body: {}, allow: SERVICE_ONLY },
      { name: '?action=confirm-opening-followup', path: '?action=confirm-opening-followup', body: {}, allow: SERVICE_ONLY },
      { name: '?action=onboard', path: '?action=onboard', body: {}, allow: SERVICE_ONLY },
      { name: '?action=diagnose', path: '?action=diagnose', body: {}, allow: SERVICE_ONLY },
      { name: 'Telegram webhook, no secret configured', body: { message: { chat: { id: 1 }, text: 'hi' } }, allow: [] },
    ],
  },
  // The other two bots are Telegram webhooks only: with no secret configured
  // every update must be refused, whatever the caller sends.
  'coffee-bot': {
    env: { COFFEE_BOT_WEBHOOK_SECRET: '' },
    preflight: false,
    cases: [
      { name: 'Telegram update, no secret configured', body: { message: { chat: { id: 1 }, from: { id: 1 }, text: '/stock' } }, allow: [] },
      { name: 'Telegram update with a made-up secret', headers: { 'x-telegram-bot-api-secret-token': 'guess' }, body: { message: { chat: { id: 1 }, from: { id: 1 }, text: '/stock' } }, allow: [] },
    ],
  },
  'telegram-bot': {
    env: { TASKS_BOT_WEBHOOK_SECRET: '' },
    preflight: false,
    cases: [
      { name: 'Telegram update, no secret configured', body: { message: { chat: { id: 1 }, from: { id: 1 }, text: '/tasks' } }, allow: [] },
      { name: 'Telegram update with a made-up secret', headers: { 'x-telegram-bot-api-secret-token': 'guess' }, body: { message: { chat: { id: 1 }, from: { id: 1 }, text: '/tasks' } }, allow: [] },
    ],
  },
}

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

const target = Deno.args[0]
if (import.meta.main) {
  const spec = target ? GATES[target] : undefined
  if (!spec) {
    console.error(`usage: gate_boot_test.ts <function>   (one of: ${Object.keys(GATES).join(' ')})`)
    Deno.exit(2)
  }
  let failures = 0
  const check = (name: string, ok: boolean, detail = '') => {
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? `\n      ${detail}` : ''}`)
    if (!ok) failures++
  }

  for (const [k, v] of Object.entries({
    SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON, LOG_TO_DB: 'false',
    RESEND_API_KEY: 'test-resend', COFFEEFLOW_USER_ID: 'u', ...spec.env,
  })) Deno.env.set(k, v)

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
  console.log(`── ${target}`)

  for (const c of spec.cases) {
    for (const who of ALL) {
      outbound.length = 0
      const method = c.method ?? 'POST'
      const res = await realFetch(`http://localhost:8000/${c.path ?? ''}`, {
        method,
        redirect: 'manual', // the unsubscribe link redirects to the site; don't follow it out
        headers: { 'Content-Type': 'application/json', ...HEADERS[who], ...c.headers },
        body: method === 'GET' ? undefined : JSON.stringify(c.body ?? {}),
      })
      const text = await res.text()
      // Let anything the handler started settle before reading `outbound`.
      await new Promise((r) => setTimeout(r, 20))
      if (c.allow.includes(who)) {
        check(`${c.name} · ${who} → gets past the gate`, res.status !== 401 && res.status !== 403, `${res.status} ${text.slice(0, 120)}`)
      } else {
        check(`${c.name} · ${who} → ${res.status} refused, nothing called`,
          (res.status === 401 || res.status === 403) && outbound.length === 0,
          `${res.status} ${text.slice(0, 100)} | outbound: ${outbound.join(', ')}`)
      }
    }
  }

  if (spec.preflight !== false) {
    const pre = await realFetch('http://localhost:8000/', { method: 'OPTIONS' })
    await pre.body?.cancel()
    check('CORS preflight still answers without a key', pre.status === 200 || pre.status === 204)
  }

  console.log(failures === 0 ? '\nall good' : `\n${failures} failing`)
  Deno.exit(failures === 0 ? 0 : 1)
}
