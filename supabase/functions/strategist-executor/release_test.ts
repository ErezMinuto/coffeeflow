// deno run -A supabase/functions/strategist-executor/release_test.ts
// The weekly release against a fake database and a fake writer.
import { runRelease } from './release.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

type Row = { id: string; target_type: string; target_id: number; approved_at: string; status: string; after: unknown; approved_by: string; release_id?: string }
function fakeDb(opts: { enabled?: boolean; rows: Row[]; releasedToday?: boolean; insertConflict?: boolean }) {
  const releases: Array<Record<string, unknown>> = opts.releasedToday ? [{ id: 'old', release_date: '2026-11-29', dry_run: false }] : []
  const db = {
    releases,
    from(table: string) {
      const f: Record<string, unknown> = {}
      let op: 'select' | 'insert' | 'update' = 'select', payload: Record<string, unknown> = {}
      const q: any = {
        select: () => q, order: () => q, limit: () => q,
        eq: (k: string, v: unknown) => { f[k] = v; return q },
        in: (k: string, v: unknown) => { f[k] = v; return q },
        maybeSingle: async () => ({ data: table === 'ops_profile' ? { value: { enabled: opts.enabled ?? true, weekday: 0, hour: 10, tz: 'Asia/Jerusalem' } } : null }),
        insert: (v: Record<string, unknown>) => { op = 'insert'; payload = v; return q },
        update: (v: Record<string, unknown>) => { op = 'update'; payload = v; return q },
        single: async () => {
          if (opts.insertConflict) return { data: null, error: { message: 'duplicate key value violates unique constraint' } }
          const r = { id: `rel-${releases.length + 1}`, ...payload }; releases.push(r); return { data: { id: r.id }, error: null }
        },
        then: (resolve: (v: unknown) => void) => {
          if (op === 'update' && table === 'site_change_log') { for (const r of opts.rows) if ((f.id as string[]).includes(r.id)) Object.assign(r, payload); return resolve({ error: null }) }
          if (op === 'update' && table === 'site_releases') { const r = releases.find((x) => x.id === f.id); if (r) Object.assign(r, payload); return resolve({ error: null }) }
          if (table === 'site_releases') return resolve({ data: releases.filter((r) => r.release_date === f.release_date && r.dry_run === false) })
          if (table === 'site_change_log') return resolve({ data: opts.rows.filter((r) => r.status === f.status), error: null })
          resolve({ data: [] })
        },
      }
      return q
    },
  }
  return db
}
const SUNDAY_10 = new Date('2026-11-29T08:00:00Z'), MONDAY = new Date('2026-11-30T08:00:00Z')
const rows = (): Row[] => [
  { id: 'a', target_type: 'product_description', target_id: 1, approved_at: '2026-11-25T09:00:00Z', status: 'queued', after: 'x', approved_by: 'user_1' },
  { id: 'b', target_type: 'product_faq', target_id: 1, approved_at: '2026-11-25T10:00:00Z', status: 'queued', after: 'y', approved_by: 'user_1' },
  { id: 'c', target_type: 'seo_meta', target_id: 2, approved_at: '2026-11-26T10:00:00Z', status: 'queued', after: 'z', approved_by: 'user_1' },
]
function deps(rs: Row[], failId?: string) {
  const written: Array<{ id: string; approved_by: unknown }> = []
  return {
    written,
    d: {
      getChange: async (id: string) => rs.find((r) => r.id === id) as any,
      writeValue: async (row: any, _v: unknown, ctx: any) => { if (row.id === failId) return { ok: false as const, error: 'site refused' }; written.push({ id: row.id, approved_by: ctx.approved_by }); row.status = 'applied'; return { ok: true as const, change_id: row.id } },
    },
  }
}

{ const rs = rows(), x = deps(rs); const r = await runRelease(fakeDb({ rows: rs }) as any, { now: MONDAY }, x.d as any)
  check('not release time → nothing written', !r.ran && r.reason === 'not release time' && x.written.length === 0) }
{ const rs = rows(), x = deps(rs); const r = await runRelease(fakeDb({ rows: rs, enabled: false }) as any, { now: SUNDAY_10 }, x.d as any)
  check('switched off → nothing written', !r.ran && /switched off/.test(r.reason ?? '') && x.written.length === 0) }
{ const rs = rows(), x = deps(rs), db = fakeDb({ rows: rs }); const r = await runRelease(db as any, { now: SUNDAY_10 }, x.d as any)
  check('Sunday 10:00: one change per page, oldest first', r.ran && r.published?.join(',') === 'a,c' && r.deferred?.join(',') === 'b', JSON.stringify(r))
  check('written with the approver kept (not "service")', x.written.every((w) => w.approved_by === 'user_1'))
  check('published changes point to the release; the deferred one stays queued', rs[0].release_id === r.release_id && rs[2].release_id === r.release_id && rs[1].status === 'queued')
  check('release recorded with published and deferred', (db.releases[0] as any).published?.join(',') === 'a,c' && (db.releases[0] as any).deferred?.join(',') === 'b') }
{ const rs = rows(), x = deps(rs); const r = await runRelease(fakeDb({ rows: rs, releasedToday: true }) as any, { now: SUNDAY_10 }, x.d as any)
  check('already released today → nothing written', !r.ran && /already released/.test(r.reason ?? '') && x.written.length === 0) }
{ const rs = rows(), x = deps(rs); const r = await runRelease(fakeDb({ rows: rs, insertConflict: true }) as any, { now: SUNDAY_10 }, x.d as any)
  check('another tick claimed the release first → nothing written', !r.ran && x.written.length === 0) }
{ const rs = rows(), x = deps(rs); const r = await runRelease(fakeDb({ rows: rs }) as any, { now: MONDAY, dryRun: true, force: true }, x.d as any)
  check('dry run: reports the plan, writes nothing', r.ran && r.dry_run === true && r.published?.join(',') === 'a,c' && x.written.length === 0 && rs.every((q) => q.status === 'queued')) }
{ const rs = rows(), x = deps(rs, 'a'); const r = await runRelease(fakeDb({ rows: rs }) as any, { now: SUNDAY_10 }, x.d as any)
  check('a failed write is recorded and the rest still go out', r.failed?.length === 1 && r.failed[0].change_id === 'a' && r.published?.join(',') === 'c', JSON.stringify(r)) }
{ const rs = rows(); rs[0].status = 'rejected'; const x = deps(rs)
  const db = fakeDb({ rows: rs }); const r = await runRelease(db as any, { now: SUNDAY_10 }, x.d as any)
  check('a change cancelled before the release is not written', !x.written.some((w) => w.id === 'a'), JSON.stringify(r)) }

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
