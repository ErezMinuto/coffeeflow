// Behaviour tests for invites.ts with a fake Clerk API and a fake user_roles.
//
//   deno run supabase/functions/clerk-user-lookup/invites_test.ts
import { claimInvite, clearInvitedRole, createInvite, listInvites, META_EXP, META_KEY, normaliseEmail, revokeInvite } from './invites.ts'

const NOW = 1_800_000_000_000
const LIVE = NOW + 86_400_000
const DEAD = NOW - 1

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' — ' + detail}`)
  if (!cond) failures++
}

// ── fakes ────────────────────────────────────────────────────────────────────
type Call = { method: string; path: string; body: any }
function fakeClerk(users: Record<string, any>, opts: { inviteStatus?: number; invites?: any } = {}) {
  const calls: Call[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname.replace(/^\/v1/, '') + url.search
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path, body })
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
    if (method === 'POST' && path === '/invitations') {
      if (opts.inviteStatus) return j({ errors: [{ long_message: 'That email address is taken.' }] }, opts.inviteStatus)
      return j({ id: 'inv_1', email_address: body.email_address, public_metadata: body.public_metadata, status: 'pending', created_at: 1 })
    }
    if (method === 'GET' && path.startsWith('/invitations')) {
      const st = url.searchParams.get('status')
      return j((opts.invites ?? []).filter((i: any) => !st || i.status === st))
    }
    if (method === 'GET' && path.startsWith('/users?')) {
      const e = url.searchParams.get('email_address')
      return j(Object.values(users).filter((u: any) => u.email_addresses.some((a: any) => a.email_address === e)))
    }
    if (method === 'POST' && /^\/invitations\/[^/]+\/revoke$/.test(path)) return j({ id: 'inv_1', status: 'revoked' })
    const m = path.match(/^\/users\/([^/?]+)(\/metadata)?$/)
    if (m) {
      const u = users[decodeURIComponent(m[1])]
      if (!u) return j({ errors: [{ message: 'not found' }] }, 404)
      if (method === 'PATCH' && m[2]) {
        for (const [k, v] of Object.entries(body.public_metadata ?? {})) {
          if (v === null) delete u.public_metadata[k]; else u.public_metadata[k] = v
        }
        return j(u)
      }
      return j(u)
    }
    return j({ errors: [{ message: 'unexpected' }] }, 599)
  }) as typeof fetch
  return { fn, calls }
}

function fakeDb(rows: Array<{ user_id: string; role: string; email?: string | null; full_name?: string | null }>) {
  const from = (_t: string) => {
    let uid: string | null = null
    const q: any = {
      select() { return q },
      eq(_k: string, v: string) { uid = v; return q },
      async maybeSingle() { return { data: rows.find((r) => r.user_id === uid) ?? null, error: null } },
      async upsert(row: any, o: any) {
        const i = rows.findIndex((r) => r.user_id === row.user_id)
        if (i >= 0 && o?.ignoreDuplicates) return { error: null }
        if (i >= 0) rows[i] = row; else rows.push(row)
        return { error: null }
      },
    }
    return q
  }
  return { rows, from }
}

const user = (id: string, role?: string, exp = LIVE) => ({
  id, first_name: 'Dana', last_name: 'Books', primary_email_address_id: 'e2',
  email_addresses: [{ id: 'e1', email_address: 'old@x.co' }, { id: 'e2', email_address: 'dana@books.co.il' }],
  public_metadata: role ? { [META_KEY]: role, [META_EXP]: exp } : {},
})

// ── input checks ─────────────────────────────────────────────────────────────
check('email normalised', normaliseEmail('  Dana@Books.co.IL ') === 'dana@books.co.il')
check('bad email refused', normaliseEmail('not an email') === null && normaliseEmail('a@b') === null)

const O = (fn: typeof fetch) => ({ clerkSecret: 'sk', fetchFn: fn, now: NOW })
{
  const c = fakeClerk({})
  const r = await createInvite('Dana@Books.co.il', 'bookkeeper', { ...O(c.fn), redirectUrl: 'https://app.test' })
  check('invite sent', r.ok && r.invite.role === 'bookkeeper' && r.invite.email === 'dana@books.co.il', JSON.stringify(r))
  const sent = c.calls[0]?.body
  check('role carried in public_metadata', sent?.public_metadata?.[META_KEY] === 'bookkeeper')
  check('expires in 30 days', sent?.public_metadata?.[META_EXP] === NOW + 30 * 86_400_000 && sent?.expires_in_days === 30)
  check('Clerk emails it, back to the app', sent?.notify === true && sent?.redirect_url === 'https://app.test')
}
{
  const c = fakeClerk({})
  const r = await createInvite('dana@books.co.il', 'owner', O(c.fn))
  check('unknown role refused, Clerk not called', !r.ok && r.status === 400 && c.calls.length === 0)
}
{
  const c = fakeClerk({}, { inviteStatus: 422 })
  const r = await createInvite('dana@books.co.il', 'employee', O(c.fn))
  check('Clerk refusal surfaced as 409 with its text', !r.ok && r.status === 409 && r.error.includes('taken'), JSON.stringify(r))
}

// ── list: pending AND accepted-but-unclaimed are both visible ───────────────
{
  const users = {
    user_waiting: user('user_waiting', 'admin'),          // accepted, never signed in to CoffeeFlow
    u_done: user('u_done'),                          // accepted and claimed (metadata cleared)
  }
  users.user_waiting.email_addresses = [{ id: 'e2', email_address: 'w@x.co' }]
  users.u_done.email_addresses = [{ id: 'e2', email_address: 'd@x.co' }]
  const meta = (role: string, exp = LIVE) => ({ [META_KEY]: role, [META_EXP]: exp })
  const c = fakeClerk(users, { invites: [
    { id: 'inv_p', email_address: 'p@x.co', public_metadata: meta('employee'), status: 'pending' },
    { id: 'inv_old', email_address: 'o@x.co', public_metadata: meta('employee', DEAD), status: 'pending' },
    { id: 'inv_other', email_address: 'z@x.co', public_metadata: {}, status: 'pending' },
    { id: 'inv_w', email_address: 'w@x.co', public_metadata: meta('admin'), status: 'accepted' },
    { id: 'inv_d', email_address: 'd@x.co', public_metadata: meta('employee'), status: 'accepted' },
  ] })
  const list = await listInvites(O(c.fn))
  const ids = list.map((v) => `${v.id}:${v.status}`).sort().join(',')
  check('pending + accepted-unclaimed listed; expired, foreign and claimed not', ids === 'inv_p:pending,inv_w:accepted', ids)
  check('accepted one carries its user id for cancelling', list.find((v) => v.id === 'inv_w')?.user_id === 'user_waiting')
}
{
  const users = { user_waiting: user('user_waiting', 'admin') }
  const c = fakeClerk(users)
  const r = await revokeInvite('inv_w', 'user_waiting', O(c.fn))
  check('cancelling an accepted one clears its role', r.ok && !(META_KEY in users.user_waiting.public_metadata))
}
{
  const c = fakeClerk({})
  check('revoke pending ok', (await revokeInvite('inv_1', undefined, O(c.fn))).ok)
  check('revoke with a path in the id refused', !(await revokeInvite('../users/x', undefined, O(c.fn))).ok && c.calls.length === 1)
  check('bad user id refused', !(await revokeInvite('inv_1', '../x', O(c.fn))).ok)
}
{
  const users = { user_a: user('user_a', 'admin') }
  const c = fakeClerk(users)
  const r = await clearInvitedRole('user_a', O(c.fn))
  check('manual role change voids an invited role', r.ok && r.cleared && !(META_KEY in users.user_a.public_metadata))
}

// ── claim ────────────────────────────────────────────────────────────────────
{
  const users = { u_new: user('u_new', 'bookkeeper') }
  const c = fakeClerk(users); const db = fakeDb([])
  const r = await claimInvite('u_new', { ...O(c.fn), supabase: db })
  check('invited user gets the role', r.claimed && r.role === 'bookkeeper', JSON.stringify(r))
  const row = db.rows[0]
  check('row has primary email and name', row?.email === 'dana@books.co.il' && row?.full_name === 'Dana Books', JSON.stringify(row))
  check('metadata cleared after use', !(META_KEY in users.u_new.public_metadata) && !(META_EXP in users.u_new.public_metadata))
  db.rows.length = 0   // admin deletes the role later…
  const again = await claimInvite('u_new', { ...O(c.fn), supabase: db })
  check('…and it does not come back', !again.claimed && db.rows.length === 0)
}
{
  // Gemini round 1, finding 2: admin set a role by hand before the user signed in.
  const users = { u_emp: user('u_emp', 'admin') }
  const c = fakeClerk(users); const db = fakeDb([{ user_id: 'u_emp', role: 'employee' }])
  const r = await claimInvite('u_emp', { ...O(c.fn), supabase: db })
  check('existing row never changed', !r.claimed && r.role === 'employee' && db.rows[0].role === 'employee')
  check('existing row: invited role cleared anyway', !(META_KEY in users.u_emp.public_metadata))
  db.rows.length = 0   // admin later removes the role
  const later = await claimInvite('u_emp', { ...O(c.fn), supabase: db })
  check('removed role does not revive the old invitation', !later.claimed && db.rows.length === 0)
}
{
  const users = { u_late: user('u_late', 'admin', DEAD) }
  const c = fakeClerk(users); const db = fakeDb([])
  const r = await claimInvite('u_late', { ...O(c.fn), supabase: db })
  check('expired invitation grants nothing, and is cleared', !r.claimed && db.rows.length === 0 && !(META_KEY in users.u_late.public_metadata))
}
{
  const c = fakeClerk({ u_stranger: user('u_stranger') }); const db = fakeDb([])
  const r = await claimInvite('u_stranger', { ...O(c.fn), supabase: db })
  check('open sign-up with no invitation gets nothing, no DB write', !r.claimed && db.rows.length === 0)
}
{
  const c = fakeClerk({ u_odd: user('u_odd', 'superuser') }); const db = fakeDb([])
  const r = await claimInvite('u_odd', { ...O(c.fn), supabase: db })
  check('unknown role in metadata ignored', !r.claimed && db.rows.length === 0)
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed')
if (failures) Deno.exit(1)
