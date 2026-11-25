// deno run -A supabase/functions/strategist-evaluator/judge_changes_test.ts
import { judgeChanges } from './judge_changes.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
type Qp = { page: string; clicks: number; impressions: number; position: number }
function fakeDb(o: { enabled?: boolean; fileUndo?: boolean; latestEnd: string; window: Qp[]; changes: Array<Record<string, any>>; pending?: boolean }) {
  const updates: Array<{ id: string; v: Record<string, unknown> }> = [], learnings: unknown[] = []
  const db = {
    updates, learnings,
    from(table: string) {
      const f: Record<string, unknown> = {}; let op = 'select'; let payload: any = null
      const q: any = {
        select: () => q, order: () => q, limit: () => q, range: (a: number) => { f.__from = a; return q }, is: () => q, not: () => q, gte: () => q, lte: () => q,
        eq: (k: string, v: unknown) => { f[k] = v; return q }, in: (k: string, v: unknown) => { f[k] = v; return q },
        maybeSingle: async () => ({ data: { value: { enabled: o.enabled ?? true, file_undo: o.fileUndo ?? false } } }),
        update: (v: any) => { op = 'update'; payload = v; return q },
        insert: async (v: any) => { if (table === 'seo_learnings') learnings.push(v); return { error: null } },
        then: (res: (v: unknown) => void) => {
          if (op === 'update') { updates.push({ id: f.id as string, v: payload }); const c = o.changes.find((x) => x.id === f.id); if (c) Object.assign(c, payload); return res({ error: null }) }
          if (table === 'gsc_query_page' && f.period_end === undefined) return res({ data: [{ period_end: o.latestEnd }] })
          if (Number(f.__from ?? 0) > 0) return res({ data: [], error: null })
          if (table === 'gsc_query_page') return res({ data: o.window, error: null })
          if (table === 'ga4_pages_daily') return res({ data: [], error: null })
          if (table === 'site_change_log' && f.status === 'applied') return res({ data: o.changes.filter((c) => !c.judged_at), error: null })
          if (table === 'site_change_log') return res({ data: o.pending ? [{ id: 'p' }] : [] })
          res({ data: [] })
        },
      }
      return q
    },
  }
  return db
}
const U = 'https://www.minuto.co.il/product/a/'
const change = (over: Record<string, unknown> = {}) => ({ id: 'c1', target_type: 'product_description', target_id: 1, target_url: U, target_title: 'A', reason: 'Why: x\nCheck on: 2026-12-22', applied_at: '2026-11-24T10:00:00Z', before: '<p>old</p>', before_source: 'woo_rest', baseline: null, undo_of: null, ...over })
const proposals: unknown[] = []
const deps = { proposeChange: async (p: unknown) => { proposals.push(p); return { id: 'u1' } as any } }

{ const db = fakeDb({ enabled: false, latestEnd: '2026-11-23', window: [], changes: [change()] }); const r = await judgeChanges(db as any, { today: '2026-11-25' }, deps)
  check('switched off → nothing happens', !r.ran && db.updates.length === 0) }
{ const db = fakeDb({ latestEnd: '2026-11-23', window: [{ page: U, clicks: 20, impressions: 1000, position: 6 }, { page: 'https://www.minuto.co.il/x/', clicks: 980, impressions: 9000, position: 9 }], changes: [change()] })
  const r = await judgeChanges(db as any, { today: '2026-11-25' }, deps)
  const b = db.updates.find((u) => (u.v as any).baseline)?.v.baseline as any
  check('a new change gets a baseline (page + site clicks)', r.baselines === 1 && b?.page.clicks === 20 && b?.site_clicks === 1000, JSON.stringify(b))
  check('not judged before a full window after the change exists', (r.judged?.length ?? 0) === 0 && r.waiting === 1) }
const base = { window_end: '2026-11-23', page: { clicks: 20, impressions: 1000, position: 6 }, site_clicks: 1000, ga4_28d_before: { sessions: 0, conversions: 0 } }
{ const c = change({ baseline: base }); const db = fakeDb({ fileUndo: true, latestEnd: '2026-12-28', window: [{ page: U, clicks: 5, impressions: 900, position: 7 }, { page: 'https://www.minuto.co.il/x/', clicks: 995, impressions: 9000, position: 9 }], changes: [c] })
  proposals.length = 0
  const r = await judgeChanges(db as any, { today: '2026-12-29' }, deps)
  check('due + a later full window → judged a loss', r.judged?.[0]?.verdict === 'loss' && c.verdict === 'loss' && !!c.judged_at, JSON.stringify(r))
  check('a loss saves a lesson', db.learnings.length === 1 && /Did not work/.test((db.learnings[0] as any).insight))
  check('a loss with file_undo files an undo proposal restoring the old value', proposals.length === 1 && (proposals[0] as any).after === '<p>old</p>' && (proposals[0] as any).target_id === 1) }
{ const c = change({ baseline: base }); const db = fakeDb({ fileUndo: false, latestEnd: '2026-12-28', window: [{ page: U, clicks: 5, impressions: 900, position: 7 }], changes: [c] })
  proposals.length = 0; await judgeChanges(db as any, { today: '2026-12-29' }, deps)
  check('file_undo off → no undo proposal, verdict still recorded', proposals.length === 0 && c.verdict === 'loss') }
{ const c = change({ baseline: base }); const db = fakeDb({ fileUndo: true, pending: true, latestEnd: '2026-12-28', window: [{ page: U, clicks: 5, impressions: 900, position: 7 }], changes: [c] })
  proposals.length = 0; await judgeChanges(db as any, { today: '2026-12-29' }, deps)
  check('no undo proposal when a change for that target is already waiting', proposals.length === 0) }
{ const c = change({ baseline: base }); const db = fakeDb({ enabled: false, fileUndo: true, latestEnd: '2026-12-28', window: [{ page: U, clicks: 5, impressions: 900, position: 7 }], changes: [c] })
  proposals.length = 0; const r = await judgeChanges(db as any, { today: '2026-12-29', dryRun: true }, deps)
  check('dry run (even when off): reports the verdict, writes nothing', r.judged?.[0]?.verdict === 'loss' && db.updates.length === 0 && db.learnings.length === 0 && proposals.length === 0 && !c.verdict) }

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
