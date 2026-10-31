// Tests for signed unsubscribe links (unsubscribe_token.ts).
//
//   deno run supabase/functions/_shared/unsubscribe_token_test.ts
//
// No env or network: every call gets an explicit fake env.

import { checkUnsubscribeToken, LEGACY_ACCEPT_UNTIL, signUnsubscribeToken, unsubscribeUrl } from './unsubscribe_token.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${!ok && detail ? `\n      ${detail}` : ''}`)
  if (!ok) failures++
}
const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] })

const SERVICE_ONLY = env({ SUPABASE_SERVICE_ROLE_KEY: 'svc-key' })
const DEDICATED = env({ SUPABASE_SERVICE_ROLE_KEY: 'svc-key', UNSUBSCRIBE_SECRET: 'unsub-secret' })
const OTHER_PROJECT = env({ SUPABASE_SERVICE_ROLE_KEY: 'another-key' })
const BEFORE = LEGACY_ACCEPT_UNTIL - 86_400_000
const AFTER = LEGACY_ACCEPT_UNTIL + 1

const a = 'dana@example.test'
const tok = await signUnsubscribeToken(a, DEDICATED)

check('signed token has the v1 shape', /^v1\.[A-Za-z0-9_-]{43}$/.test(tok), tok)
check('same address signs the same token', tok === await signUnsubscribeToken(a, DEDICATED))
check('signed token verifies for its address', await checkUnsubscribeToken(a, tok, DEDICATED) === 'valid')
check('address case / spaces do not matter', await checkUnsubscribeToken('  Dana@Example.TEST ', tok, DEDICATED) === 'valid')
check('token for one address is refused for another', await checkUnsubscribeToken('eve@example.test', tok, DEDICATED) === 'invalid')
check('token signed with a different key is refused', await checkUnsubscribeToken(a, await signUnsubscribeToken(a, OTHER_PROJECT), DEDICATED) === 'invalid')
// Flip a middle character: the last one also holds 2 padding bits, so changing it may not change the bytes.
const flipped = tok.slice(0, 10) + (tok[10] === 'A' ? 'B' : 'A') + tok.slice(11)
check('one flipped character is refused', await checkUnsubscribeToken(a, flipped, DEDICATED) === 'invalid')
check('truncated signature is refused', await checkUnsubscribeToken(a, tok.slice(0, 20), DEDICATED) === 'invalid')
check('garbage after v1. is refused', await checkUnsubscribeToken(a, 'v1.!!!', DEDICATED) === 'invalid')
check('empty token is refused', await checkUnsubscribeToken(a, '', DEDICATED) === 'invalid')

// Key transition: links signed before UNSUBSCRIBE_SECRET was set keep working after.
const oldSigned = await signUnsubscribeToken(a, SERVICE_ONLY)
check('without UNSUBSCRIBE_SECRET the service-derived key signs', oldSigned !== tok)
check('...and those links still verify once UNSUBSCRIBE_SECRET is set', await checkUnsubscribeToken(a, oldSigned, DEDICATED) === 'valid')
check('signing with no key at all throws', await signUnsubscribeToken(a, env({})).then(() => false, () => true))

const url = await unsubscribeUrl('https://x.test/functions/v1/generate-campaign', 'a+b@example.test', DEDICATED)
const u = new URL(url)
check('url carries action, email and a token that verifies',
  u.searchParams.get('action') === 'unsubscribe' && u.searchParams.get('email') === 'a+b@example.test' &&
    await checkUnsubscribeToken(u.searchParams.get('email')!, u.searchParams.get('token')!, DEDICATED) === 'valid', url)

// Legacy btoa(email:millis) links, from emails sent before the change.
const legacy = btoa(`${a}:1760000000000`)
check('legacy token for the same address is accepted in the window', await checkUnsubscribeToken(a, legacy, DEDICATED, BEFORE) === 'legacy')
check('legacy token is refused after the window', await checkUnsubscribeToken(a, legacy, DEDICATED, AFTER) === 'invalid')
check('legacy token for another address is refused', await checkUnsubscribeToken('eve@example.test', legacy, DEDICATED, BEFORE) === 'invalid')
check('legacy-looking token without a millis timestamp is refused', await checkUnsubscribeToken(a, btoa(`${a}:x`), DEDICATED, BEFORE) === 'invalid')
check('the old test value "x" is refused', await checkUnsubscribeToken(a, 'x', DEDICATED, BEFORE) === 'invalid')

console.log(failures === 0 ? '\nall good' : `\n${failures} failing`)
Deno.exit(failures === 0 ? 0 : 1)
