// Tests for mission-worker's fenced writes and per-task checkpoint.
//
//   deno run --allow-read supabase/functions/mission-worker/ownership_test.ts
//
// The fake agent_missions table evaluates eq filters and applies each UPDATE as
// one compare-and-set, the way Postgres does per row.

import { updateIfOwned } from './ownership.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

type Row = Record<string, any>
function fakeDb(rows: Row[]) {
  return {
    from(_t: string) {
      const filters: Array<(r: Row) => boolean> = []
      let patch: Row = {}
      const q: any = {
        update(p: Row) { patch = p; return q },
        eq(c: string, v: unknown) { filters.push(r => r[c] === v); return q },
        select() { return q },
        async maybeSingle() {
          const hit = rows.filter(r => filters.every(f => f(r)))
          for (const r of hit) Object.assign(r, patch)
          return { data: hit[0] ? { id: hit[0].id } : null, error: null }
        },
      }
      return q
    },
  }
}
const mission = (extra: Row = {}): Row => ({ id: 'm1', status: 'active', worker_id: 'mission-a', state: {}, ...extra })

// The bug: cancel mid-step, then the step's final write set status 'done'.
{
  const row = mission()
  const db = fakeDb([row])
  Object.assign(row, { status: 'cancelled', worker_id: null })          // cancel_mission
  const ok = await updateIfOwned(db, 'm1', 'mission-a', { status: 'done', steps_taken: 3 })
  check('a cancelled mission is not overwritten', !ok && row.status === 'cancelled' && row.steps_taken === undefined)
}

// Reclaimed by another worker after the lock expired.
{
  const row = mission({ worker_id: 'mission-b' })
  const db = fakeDb([row])
  check('a reclaimed mission is not overwritten', !(await updateIfOwned(db, 'm1', 'mission-a', { state: { x: 1 } })) && row.state.x === undefined)
}

// The owner's checkpoint lands.
{
  const row = mission()
  const db = fakeDb([row])
  const ok = await updateIfOwned(db, 'm1', 'mission-a', { state: { queued_task_ids: ['t1'] } })
  check('owner checkpoint lands', ok && row.state.queued_task_ids[0] === 't1')
}

// index.ts: checkpoint after each queued task, fenced final write, no unfenced writes.
{
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url))
  check('no unfenced agent_missions update after the claim',
    (src.match(/from\('agent_missions'\)\s*\.update\(/g) ?? []).length === 1)   // the claim itself
  const pushes = src.match(/newTaskIds\.push\([^)]*\)[^\n]*/g) ?? []
  check('every queued task is checkpointed', pushes.length >= 3 && pushes.every(p => p.includes('await checkpoint()')), pushes.join(' | '))
  check('final write goes through updateIfOwned', /updateIfOwned\(supabase, mission\.id, workerId, patch\)/.test(src))
  check('queuing stops once the mission is lost', /if \(lostMission\) break/.test(src))
}

if (failures) { console.error(`\n${failures} check(s) failed`); Deno.exit(1) }
console.log('\nall checks passed')
