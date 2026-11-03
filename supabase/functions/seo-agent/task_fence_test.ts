// Tests for the status fence on markTaskCompleted / markTaskFailed.
//
//   deno run --allow-read --allow-env --allow-net supabase/functions/seo-agent/task_fence_test.ts
//
// The fake seo_tasks table evaluates PostgREST-style filters and applies each
// UPDATE as one compare-and-set, like Postgres does per row.

import { markTaskCompleted, markTaskFailed } from './db.ts'
import type { SeoTaskRow } from './types.ts'

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
        is(c: string, v: unknown) { filters.push(r => r[c] === v); return q },
        select() { return q },
        then(res: any, rej: any) {
          const hit = rows.filter(r => filters.every(f => f(r)))
          for (const r of hit) Object.assign(r, patch)
          return Promise.resolve({ data: hit.map(r => ({ id: r.id })), error: null }).then(res, rej)
        },
      }
      return q
    },
  } as any
}
const claimed = (extra: Row = {}): Row => ({ id: 't1', status: 'processing', worker_id: 'writer-1', ...extra })
const asTask = (r: Row) => r as unknown as SeoTaskRow

// The bug: a task cancelled from chat while the worker ran was overwritten as completed.
{
  const row = claimed()
  const db = fakeDb([row])
  const task = asTask({ ...row })                         // the worker's copy from claimNextTask
  await markTaskFailed(db, 't1', '[chat-cancel] wrong topic', true)   // admin cancels (unfenced, by id)
  check('cancel by id still works', row.status === 'failed')
  const wrote = await markTaskCompleted(db, task, { wp_post_id: 1 })
  check('worker cannot complete a cancelled task', !wrote && row.status === 'failed' && row.result_data === undefined)
  const wrote2 = await markTaskFailed(db, task, 'transient', false)
  check('worker cannot resurrect a cancelled task to pending', !wrote2 && row.status === 'failed')
}

// A task reclaimed by another worker after a lock expiry belongs to that worker.
{
  const row = claimed()
  const db = fakeDb([row])
  const stale = asTask({ ...row })
  Object.assign(row, { worker_id: 'writer-2' })             // stale-lock reclaim
  check('old worker cannot complete a reclaimed task', !(await markTaskCompleted(db, stale, { x: 1 })) && row.status === 'processing')
  check('new worker can', await markTaskCompleted(db, asTask({ ...row }), { x: 2 }) && row.status === 'completed' && row.result_data.x === 2)
}

// The normal path still works.
{
  const row = claimed()
  const db = fakeDb([row])
  check('owner completes', await markTaskCompleted(db, asTask({ ...row }), { ok: true }) && row.status === 'completed')
  const row2 = claimed({ id: 't2' })
  const db2 = fakeDb([row2])
  check('owner retries (pending)', await markTaskFailed(db2, asTask({ ...row2 }), 'boom', false) && row2.status === 'pending')
}

// Every worker passes the claimed row, not a bare id.
{
  for (const fn of ['seo-worker-writer', 'seo-worker-techseo', 'seo-worker-visual', 'organic-worker-instagram', 'seo-worker-research']) {
    const src = await Deno.readTextFile(new URL(`../${fn}/index.ts`, import.meta.url))
    check(`${fn} passes the task row`, !/markTask(Completed|Failed)\(supabase, task\.id/.test(src))
  }
}

if (failures) { console.error(`\n${failures} check(s) failed`); Deno.exit(1) }
console.log('\nall checks passed')
