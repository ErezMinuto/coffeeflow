// Tests for the executor's claim / finish / sweep bookkeeping.
//
//   deno run --allow-read supabase/functions/strategist-executor/ledger_test.ts
//
// The fake table evaluates PostgREST-style filters (eq / in / lt) and applies
// each UPDATE as one atomic compare-and-set, the way Postgres does per row, so
// overlapping workers race the way they do in production.

import { claimRecs, finishRec, sweepStaleDrafting } from './ledger.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const jitter = () => new Promise(r => setTimeout(r, Math.random() * 10))

type Row = Record<string, any>
function fakeTable(rows: Row[], opts: { failUpdates?: number } = {}) {
  let failUpdates = opts.failUpdates ?? 0
  const from = (_t: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let patch: Row | null = null
    let limit = Infinity
    const q: any = {
      select() { return q },
      update(p: Row) { patch = p; return q },
      eq(c: string, v: unknown) { filters.push(r => r[c] === v); return q },
      in(c: string, vs: unknown[]) { filters.push(r => vs.includes(r[c])); return q },
      lt(c: string, v: string) { filters.push(r => r[c] != null && r[c] < v); return q },
      order() { return q },
      limit(n: number) { limit = n; return q },
      async run() {
        await jitter()
        if (patch && failUpdates > 0) { failUpdates--; return { data: null, error: { message: 'transient' } } }
        const hit = rows.filter(r => filters.every(f => f(r))).slice(0, limit)
        if (patch) for (const r of hit) Object.assign(r, patch)
        return { data: hit.map(r => ({ ...r })), error: null }
      },
      async maybeSingle() { const { data, error } = await q.run(); return { data: data?.[0] ?? null, error } },
      then(res: any, rej: any) { return q.run().then(res, rej) },
    }
    return q
  }
  return { from }
}
const rec = (id: string, extra: Row = {}): Row => ({
  id, status: 'approved', action_type: 'content_blog', created_at: id, locked_until: null, worker_id: null, ...extra,
})

// Overlapping executors never claim the same recommendation.
{
  const rows = [rec('a'), rec('b'), rec('c')]
  const db = fakeTable(rows)
  const [x, y, z] = await Promise.all(['w1', 'w2', 'w3'].map(w => claimRecs(db, w, ['content_blog'], 5)))
  const ids = [...x, ...y, ...z].map(r => r.id)
  check('each rec claimed exactly once', ids.length === 3 && new Set(ids).size === 3, ids.join(','))
  check('claimed rows are drafting', rows.every(r => r.status === 'drafting'))
}

// The bug: a failed 'drafted' update left the row approved → drafted again.
{
  const rows = [rec('a')]
  const db = fakeTable(rows)
  const [mine] = await claimRecs(db, 'w1', ['content_blog'], 5)
  const failing = fakeTable(rows, { failUpdates: 2 })
  const err = await finishRec(failing, mine.id, 'w1', { status: 'drafted', draft_ref: 'task:1' })
  check('a failed finish is reported, not ignored', err === 'transient', String(err))
  // Lock expires; another executor runs.
  rows[0].locked_until = new Date(Date.now() - 60_000).toISOString()
  const again = await claimRecs(db, 'w2', ['content_blog'], 5)
  check('an unrecorded draft is never claimed again', again.length === 0)
  const swept = await sweepStaleDrafting(db)
  check('the sweep flags it as failed with a may-exist note', swept === 1 && rows[0].status === 'failed' && /may already exist/.test(rows[0].draft_error))
}

// finish retries a transient error once.
{
  const rows = [rec('a')]
  const db = fakeTable(rows)
  await claimRecs(db, 'w1', ['content_blog'], 5)
  const err = await finishRec(fakeTable(rows, { failUpdates: 1 }), 'a', 'w1', { status: 'drafted', draft_ref: 'task:9' })
  check('transient finish error retried', err === null && rows[0].status === 'drafted' && rows[0].draft_ref === 'task:9')
}

// finish is fenced: it never overwrites a row someone else moved.
{
  const rows = [rec('a')]
  const db = fakeTable(rows)
  await claimRecs(db, 'w1', ['content_blog'], 5)
  rows[0].status = 'dismissed'
  const err = await finishRec(db, 'a', 'w1', { status: 'drafted', draft_ref: 'task:2' })
  check('finish refuses a row no longer drafting', err !== null && rows[0].status === 'dismissed')
  rows[0].status = 'drafting'; rows[0].worker_id = 'w2'
  const err2 = await finishRec(db, 'a', 'w1', { status: 'drafted', draft_ref: 'task:3' })
  check('finish refuses a row held by another worker', err2 !== null && rows[0].draft_ref === undefined)
}

// The sweep leaves a live claim alone.
{
  const rows = [rec('a')]
  const db = fakeTable(rows)
  await claimRecs(db, 'w1', ['content_blog'], 5)
  check('a live claim is not swept', (await sweepStaleDrafting(db)) === 0 && rows[0].status === 'drafting')
}

// index.ts uses the fenced helpers.
{
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url))
  check('index.ts finishes through finishRec', (src.match(/finishRec\(/g) ?? []).length >= 2)
  check('index.ts has no unchecked status update', !/\.update\(\{ status: 'drafted'/.test(src))
}

if (failures) { console.error(`\n${failures} check(s) failed`); Deno.exit(1) }
console.log('\nall checks passed')
