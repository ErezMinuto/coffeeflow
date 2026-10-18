// Boot test: the OAuth exchange functions must not write the tokens they receive to the function logs.
//
//   bash scripts/ci/token-log-boot-tests.sh
//
// Boots the real function (same sandbox as gate_boot_test.ts), answers the provider's token endpoint with
// recognisable fake tokens, completes an admin exchange, and fails if any console line carries a token or the code.

import { ANON, fake, HEADERS, SERVICE, URL_ } from './gate_boot_test.ts'

const SECRETS = ['tok-ACCESS-shortlived', 'tok-ACCESS-longlived', 'tok-REFRESH', 'code-ONE-TIME']
const CASES: Record<string, { env: Record<string, string>; provider: (url: string) => unknown | undefined }> = {
  'google-exchange-token': {
    env: { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' },
    provider: (url) =>
      url.startsWith('https://oauth2.googleapis.com/token')
        ? { access_token: 'tok-ACCESS-shortlived', refresh_token: 'tok-REFRESH', expires_in: 3600 }
        : url.startsWith('https://www.googleapis.com/oauth2/v2/userinfo') ? { email: 'a@example.test' } : undefined,
  },
  'meta-exchange-token': {
    env: { META_APP_ID: 'app', META_APP_SECRET: 'asecret' },
    provider: (url) =>
      url.startsWith('https://graph.facebook.com/v23.0/oauth/access_token')
        ? (url.includes('fb_exchange_token') ? { access_token: 'tok-ACCESS-longlived', expires_in: 5184000 } : { access_token: 'tok-ACCESS-shortlived' })
        : url.startsWith('https://graph.facebook.com/v23.0/me') ? { name: 'Minuto' } : undefined,
  },
}

const target = Deno.args[0]
if (import.meta.main) {
  const spec = target ? CASES[target] : undefined
  if (!spec) {
    console.error(`usage: token_log_boot_test.ts <function>   (one of: ${Object.keys(CASES).join(' ')})`)
    Deno.exit(2)
  }
  for (const [k, v] of Object.entries({
    SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON, LOG_TO_DB: 'false', ...spec.env,
  })) Deno.env.set(k, v)

  const realFetch = globalThis.fetch
  let stored = false
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('http://localhost:8000')) return realFetch(input, init)
    if (url.startsWith(`${URL_}/auth/v1/admin/users`) || url === `${URL_}/rest/v1/rpc/get_role_for_user`) return fake(input, init)
    if (url.startsWith(`${URL_}/rest/v1/oauth_tokens`)) { stored = true; return new Response(null, { status: 201 }) }
    const body = spec.provider(url)
    return body === undefined ? new Response('{"error":"blocked by test"}', { status: 503 }) : Response.json(body)
  }) as typeof fetch

  const logged: string[] = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[level]
    console[level] = (...args: unknown[]) => { logged.push(args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); orig(...args) }
  }

  await import(`../${target}/index.ts`)
  const res = await realFetch('http://localhost:8000/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...HEADERS.admin },
    body: JSON.stringify({ code: 'code-ONE-TIME', redirect_uri: 'https://example.test/cb' }),
  })
  const text = await res.text()
  await new Promise((r) => setTimeout(r, 20))

  let failures = 0
  const check = (name: string, ok: boolean, detail = '') => {
    console.info(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? `\n      ${detail}` : ''}`)
    if (!ok) failures++
  }
  console.info(`── ${target}`)
  check('admin exchange completes and stores the token', res.status === 200 && stored, `${res.status} ${text.slice(0, 120)}`)
  check('response body carries no token', !SECRETS.some((s) => text.includes(s)), text.slice(0, 200))
  const leaks = logged.filter((l) => SECRETS.some((s) => l.includes(s)))
  check('no log line carries a token or the code', leaks.length === 0, leaks.join(' | ').slice(0, 300))
  console.info(failures === 0 ? '\nall good' : `\n${failures} failing`)
  Deno.exit(failures === 0 ? 0 : 1)
}
