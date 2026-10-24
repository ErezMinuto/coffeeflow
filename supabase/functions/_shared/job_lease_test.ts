// Tests for the job lease helper and organic-orchestrator's use of it.
//
//   deno run --allow-read supabase/functions/_shared/job_lease_test.ts
//
// The fake rpc implements acquire_job_lease / release_job_lease the way the SQL
// does (one row per name, takeover only after expiry). The SQL itself is checked
// against real rows by scripts/ci/job_leases_check.sql.

import { acquireLease, releaseLease } from './job_lease.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const jitter = () => new Promise(r => setTimeout(r, Math.random() * 10))

function fakeDb(opts: { fail?: boolean } = {}) {
  let clock = 0
  const leases = new Map<string, { holder: string; expires: number }>()
  const client = {
    async rpc(fn: string, a: Record<string, any>) {
      await jitter()
      if (opts.fail) return { data: null, error: { message: 'function acquire_job_lease does not exist' } }
      if (fn === 'acquire_job_lease') {
        const cur = leases.get(a.p_name)
        if (cur && cur.expires >= clock && cur.holder !== a.p_holder) return { data: false, error: null }
        leases.set(a.p_name, { holder: a.p_holder, expires: clock + a.p_ttl_seconds })
        return { data: true, error: null }
      }
      if (fn === 'release_job_lease') {
        const cur = leases.get(a.p_name)
        if (cur?.holder === a.p_holder) { leases.delete(a.p_name); return { data: true, error: null } }
        return { data: false, error: null }
      }
      return { data: null, error: { message: 'unknown' } }
    },
  }
  return { client, leases, tick: (s: number) => { clock += s } }
}

{
  const db = fakeDb()
  const got = await Promise.all(['cron', 'manual', 'cron-2'].map(h => acquireLease(db.client, 'organic-orchestrator', h, 900)))
  check('overlapping runs: exactly one holds the lease', got.filter(g => g.held).length === 1)
  check('the losers get no error (a skip, not a failure)', got.filter(g => !g.held).every(g => !('error' in g) || !g.error))
  const holder = db.leases.get('organic-orchestrator')!.holder
  await releaseLease(db.client, 'organic-orchestrator', 'someone-else')
  check('a non-holder cannot release', db.leases.get('organic-orchestrator')?.holder === holder)
  await releaseLease(db.client, 'organic-orchestrator', holder)
  check('the holder releases; next run gets it', (await acquireLease(db.client, 'organic-orchestrator', 'next', 900)).held)
  db.tick(901)
  check('a killed run frees the lease on expiry', (await acquireLease(db.client, 'organic-orchestrator', 'after-crash', 900)).held)
}
{
  const r = await acquireLease(fakeDb({ fail: true }).client, 'x', 'h', 60)
  check('rpc error is reported (caller fails closed)', !r.held && 'error' in r && !!r.error)
}

// organic-orchestrator takes the lease before accepting and releases it after the cycle.
{
  const src = await Deno.readTextFile(new URL('../organic-orchestrator/index.ts', import.meta.url))
  const acq = src.indexOf('acquireLease(')
  const accepted = src.indexOf('accepted: true')
  check('orchestrator acquires the lease before accepting', acq > 0 && acq < accepted)
  check('orchestrator answers 409 when a cycle is running', /skipped: 'another orchestrator cycle is still running'[^\n]*409/.test(src))
  check('orchestrator releases after the cycle', /runCycle\(\)\.finally\(\(\) => releaseLease\(/.test(src))
}

if (failures) { console.error(`\n${failures} check(s) failed`); Deno.exit(1) }
console.log('\nall checks passed')
