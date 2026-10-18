// Boot test for generate-campaign's public GET ?action=unsubscribe.
//
//   bash scripts/ci/unsubscribe-boot-test.sh
//
// Boots the real function (empty env, localhost-only network, every outbound
// request recorded) and sends unsubscribe links. A forged or wrong-address
// token must redirect with status=invalid and make no outbound request (no
// Resend PATCH, no database write). A signed token, or an old-format one
// inside the transition window, must unsubscribe (Resend + marketing_contacts).

import { signUnsubscribeToken } from './unsubscribe_token.ts'

const URL_ = 'http://backend.test'
const SERVICE = 'test-service-role'
const ENV = {
  SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: 'test-anon-key', LOG_TO_DB: 'false',
  RESEND_API_KEY: 'test-resend', RESEND_AUDIENCE_ID: 'test-audience', COFFEEFLOW_USER_ID: 'u',
  UNSUBSCRIBE_SECRET: 'test-unsubscribe-secret', UNSUBSCRIBE_REDIRECT_BASE: 'https://site.test/unsubscribed.html',
}

if (import.meta.main) {
  for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v)

  const outbound: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('http://localhost:8000')) return realFetch(input, init)
    outbound.push(`${init?.method ?? 'GET'} ${url.replace(/\?.*/, '')}`)
    if (url.startsWith('https://api.resend.com/')) return Response.json({ id: 'c1' })
    if (url.startsWith(`${URL_}/rest/v1/marketing_contacts`)) return new Response(null, { status: 204 })
    return new Response('{"error":"blocked by test"}', { status: 503 })
  }) as typeof fetch

  await import('../generate-campaign/index.ts')
  console.log('── generate-campaign GET ?action=unsubscribe')

  let failures = 0
  const check = (name: string, ok: boolean, detail = '') => {
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? `\n      ${detail}` : ''}`)
    if (!ok) failures++
  }
  const hit = async (email: string, token: string) => {
    outbound.length = 0
    const res = await realFetch(
      `http://localhost:8000/?action=unsubscribe&email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`,
      { redirect: 'manual' },
    )
    await res.body?.cancel()
    await new Promise((r) => setTimeout(r, 20))
    return { status: res.status, location: res.headers.get('location') ?? '', calls: [...outbound] }
  }
  const refused = (name: string, r: Awaited<ReturnType<typeof hit>>) =>
    check(`${name} → status=invalid, nothing called`,
      r.status === 302 && r.location.includes('status=invalid') && r.calls.length === 0, `${r.status} ${r.location} | ${r.calls.join(', ')}`)
  const accepted = (name: string, r: Awaited<ReturnType<typeof hit>>) =>
    check(`${name} → unsubscribed in Resend + marketing_contacts`,
      r.status === 302 && r.location.includes('status=ok') &&
        r.calls.some((c) => c.startsWith('PATCH https://api.resend.com/')) &&
        r.calls.some((c) => c.startsWith(`PATCH ${URL_}/rest/v1/marketing_contacts`)),
      `${r.status} ${r.location} | ${r.calls.join(', ')}`)

  const victim = 'victim@example.test'
  const signed = await signUnsubscribeToken(victim, Deno.env)
  refused('presence-only token "x" (what used to pass)', await hit(victim, 'x'))
  refused('forged v1 token', await hit(victim, 'v1.' + 'A'.repeat(43)))
  refused("another address's signed token", await hit(victim, await signUnsubscribeToken('me@example.test', Deno.env)))
  refused('legacy token naming a different address', await hit(victim, btoa('me@example.test:1760000000000')))
  accepted('signed token for the address', await hit(victim, signed))
  accepted('signed token, address in other case', await hit('Victim@Example.TEST', signed))
  accepted('legacy btoa(email:millis) inside the window', await hit(victim, btoa(`${victim}:1760000000000`)))

  console.log(failures === 0 ? '\nall good' : `\n${failures} failing`)
  Deno.exit(failures === 0 ? 0 : 1)
}
