// Behaviour tests for invites.ts with a fake Clerk API and a fake user_roles.
//
//   deno run supabase/functions/clerk-user-lookup/invites_test.ts
import { claimInvite, clearInvitedRole, createInvite, listInvites, META_ALLOW, META_EXP, META_KEY, normaliseEmail, revokeInvite } from './invites.ts'

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
function fakeClerk(users: Record<string, any>, opts: { inviteStatus?: number; invites?: any; allowStatus?: number; allow?: Map<string, string> } = {}) {
  const calls: Call[] = []
  const allow = opts.allow ?? new Map<string, string>()   // identifier → id
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
    if (method === 'POST' && path === '/allowlist_identifiers') {
      if (opts.allowStatus) return j({ errors: [{ message: 'allowlist down' }] }, opts.allowStatus)
      if (allow.has(body.identifier)) return j({ errors: [{ code: 'duplicate_record' }] }, 422)
      const id = `alw_${allow.size + 1}`; allow.set(body.identifier, id)
      return j({ id, identifier: body.identifier })
    }
    const del = path.match(/^\/allowlist_identifiers\/([^/]+)$/)
    if (method === 'DELETE' && del) {
      const hit = [...allow].find(([, v]) => v === del[1])
      if (!hit) return j({ errors: [{ message: 'not found' }] }, 404)
      allow.delete(hit[0]); return j({ deleted: true })
    }
    const rv = path.match(/^\/invitations\/([^/]+)\/revoke$/)
    if (method === 'POST' && rv) {
      const inv = (opts.invites ?? []).find((i: any) => i.id === rv[1])
      return j({ id: rv[1], status: 'revoked', public_metadata: inv?.public_metadata ?? {} })
    }
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
  return { fn, calls, allow }
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
  public_metadata: role ? { [META_KEY]: role, [META_EXP]: exp, [META_ALLOW]: 'alw_x' } : {},
})

// ── input checks ─────────────────────────────────────────────────────────────
check('email normalised', normaliseEmail('  Dana@Books.co.IL ') === 'dana@books.co.il')
check('bad email refused', normaliseEmail('not an email') === null && normaliseEmail('a@b') === null)

const O = (fn: typeof fetch) => ({ clerkSecret: 'sk', fetchFn: fn, now: NOW })
{
  const c = fakeClerk({})
  const r = await createInvite('Dana@Books.co.il', 'bookkeeper', { ...O(c.fn), redirectUrl: 'https://app.test' })
  check('invite sent', r.ok && r.invite.role === 'bookkeeper' && r.invite.email === 'dana@books.co.il', JSON.stringify(r))
  const sent = c.calls.find((x) => x.method === 'POST' && x.path === '/invitations')?.body
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

// ── allowlist (sign-up is allowlist-only) ───────────────────────────────────
{
  const c = fakeClerk({})
  const r = await createInvite('alona@bokman-fin.com', 'bookkeeper', O(c.fn))
  const inv = c.calls.find((x) => x.path === '/invitations')
  check('invite adds the email to the allowlist first', r.ok && c.allow.get('alona@bokman-fin.com') === 'alw_1'
    && c.calls[0].path === '/allowlist_identifiers', JSON.stringify(c.calls.map((x) => x.path)))
  check('the entry we created is remembered on the invitation', inv?.body?.public_metadata?.[META_ALLOW] === 'alw_1')
}
{
  const c = fakeClerk({}, { allow: new Map([['jule@bokman-fin.com', 'alw_old']]) })
  const r = await createInvite('jule@bokman-fin.com', 'bookkeeper', O(c.fn))
  const inv = c.calls.find((x) => x.path === '/invitations')
  check('already allowlisted: invite still sent', r.ok)
  check('already allowlisted: not marked as ours', !(META_ALLOW in (inv?.body?.public_metadata ?? {})))
}
{
  const c = fakeClerk({}, { allowStatus: 500 })
  const r = await createInvite('x@bokman-fin.com', 'bookkeeper', O(c.fn))
  check('allowlist failure stops the invite (it could not be accepted)', !r.ok && !c.calls.some((x) => x.path === '/invitations'))
}
{
  const c = fakeClerk({}, { inviteStatus: 422 })
  const r = await createInvite('dup@x.co', 'employee', O(c.fn))
  check('invitation refused: our allowlist entry rolled back', !r.ok && c.allow.size === 0)
}
{
  const allow = new Map([['p@x.co', 'alw_9']])
  const c = fakeClerk({}, { allow, invites: [
    { id: 'inv_p', email_address: 'p@x.co', status: 'pending', public_metadata: { [META_KEY]: 'employee', [META_EXP]: LIVE, [META_ALLOW]: 'alw_9' } },
  ] })
  const r = await revokeInvite('inv_p', undefined, O(c.fn))
  check('cancelling a pending invite removes the allowlist entry we added', r.ok && allow.size === 0)
}
{
  const allow = new Map([['keep@x.co', 'alw_keep']])
  const c = fakeClerk({}, { allow, invites: [
    { id: 'inv_k', email_address: 'keep@x.co', status: 'pending', public_metadata: { [META_KEY]: 'employee', [META_EXP]: LIVE } },
  ] })
  await revokeInvite('inv_k', undefined, O(c.fn))
  check('cancelling never removes an entry that was there before', allow.get('keep@x.co') === 'alw_keep')
}
{
  // Gemini round 1 (allowlist), finding 2: an old expired invitation must
  // never take away the allowlist entry a newer invitation relies on.
  const allow = new Map([['again@x.co', 'alw_5']])
  const c = fakeClerk({}, { allow, invites: [
    { id: 'inv_e', email_address: 'again@x.co', status: 'expired', public_metadata: { [META_KEY]: 'employee', [META_EXP]: DEAD, [META_ALLOW]: 'alw_5' } },
    { id: 'inv_b', email_address: 'again@x.co', status: 'pending', public_metadata: { [META_KEY]: 'employee', [META_EXP]: LIVE } },
  ] })
  await listInvites(O(c.fn)); await listInvites(O(c.fn))
  check('listing never deletes allowlist entries (re-invited email keeps its entry)', allow.get('again@x.co') === 'alw_5')
  check('listing makes no DELETE calls at all', !c.calls.some((x) => x.method === 'DELETE'))
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
  check('metadata cleared after use', !(META_KEY in users.u_new.public_metadata) && !(META_EXP in users.u_new.public_metadata) && !(META_ALLOW in users.u_new.public_metadata))
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
