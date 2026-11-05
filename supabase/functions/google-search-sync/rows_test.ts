// deno run supabase/functions/google-search-sync/rows_test.ts
import { chunk, dedupeByKey, forEachGscPage, syncWindow, toDbRows, upsertInBatches, MAX_WINDOW_DAYS, type GscApiRow, type GscDbRow } from './rows.ts'
import { selectAll } from '../_shared/select_all.ts'
import { fetchGscKeywordTotals } from '../_shared/gsc_totals.ts'
import { fetchKeywordResearch } from '../_shared/keyword_research.ts'
import { getSearchConsoleData } from '../_shared/marketing_intel.ts'
import { fetchTopKeywords } from '../seo-agent/services/googleApi.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const T = '2026-11-05T09:00:00.000Z'

// ── toDbRows: same columns as the old per-row loops
const rows = toDbRows(
  [{ keys: ['פולי קפה', '2026-11-01'], clicks: 2.6, impressions: 40.4, ctr: 0.05, position: 7.2 }, { keys: ['v60', '2026-11-01'] }],
  [{ keys: ['https://www.minuto.co.il/', '2026-11-01'], clicks: 9, impressions: 300, ctr: 0.03, position: 4 }],
  T,
)
check('keyword row shape', JSON.stringify(rows[0]) === JSON.stringify({ date: '2026-11-01', keyword: 'פולי קפה', page: null, clicks: 3, impressions: 40, ctr: 0.05, position: 7.2, synced_at: T }), JSON.stringify(rows[0]))
check('missing metrics default to 0', rows[1].clicks === 0 && rows[1].impressions === 0 && rows[1].ctr === 0 && rows[1].position === 0)
check('page row stored under __page__', rows[2].keyword === '__page__' && rows[2].page === 'https://www.minuto.co.il/')

// ── dedupeByKey: NULL page counts as equal; last copy wins; distinct pages kept
const r = (date: string, keyword: string, page: string | null, clicks: number): GscDbRow =>
  ({ date, keyword, page, clicks, impressions: 0, ctr: 0, position: 0, synced_at: T })
const d = dedupeByKey([r('d1', 'k', null, 1), r('d1', 'k', null, 2), r('d1', 'k', '/a', 3), r('d2', 'k', null, 4), r('d1', '__page__', '/a', 5), r('d1', '__page__', '/a', 6)])
check('dedupe count', d.length === 4, String(d.length))
check('dedupe keeps last (null page)', d.find(x => x.date === 'd1' && x.keyword === 'k' && x.page === null)!.clicks === 2)
check('dedupe keeps last (page row)', d.find(x => x.keyword === '__page__')!.clicks === 6)
check('null page ≠ empty-string page', dedupeByKey([r('d', 'k', null, 1), r('d', 'k', '', 2)]).length === 2)

// ── chunk
check('chunk 1201 by 500', JSON.stringify(chunk(Array.from({ length: 1201 }, (_, i) => i), 500).map(c => c.length)) === '[500,500,201]')
check('chunk empty', chunk([], 500).length === 0)
let threw = false; try { chunk([1], 0) } catch { threw = true }
check('chunk size 0 throws', threw)

// ── upsertInBatches: 1,200 rows = 3 calls, no batch repeats a key
const many = Array.from({ length: 1200 }, (_, i) => r(`d${i % 90}`, `k${Math.floor(i / 90)}`, null, i))
many.push(r('d0', 'k0', null, 99999)) // duplicate key across what would be batch 1 and 3
const calls: GscDbRow[][] = []
const n = await upsertInBatches(many, async (b) => { calls.push(b); return { error: null } })
check('batched: 3 calls for 1,200 distinct keys', calls.length === 3, String(calls.length))
check('batched: returns rows written', n === 1200, String(n))
check('batched: no key twice in any batch', calls.every(b => new Set(b.map(x => JSON.stringify([x.date, x.keyword, x.page]))).size === b.length))
check('batched: duplicate collapsed to last copy', calls.flat().find(x => x.date === 'd0' && x.keyword === 'k0')!.clicks === 99999)

// error on the 2nd batch → throws, 3rd batch never sent
let sent = 0, err = ''
try {
  await upsertInBatches(many, async () => (++sent === 2 ? { error: { message: 'duplicate key value' } } : { error: null }))
} catch (e) { err = (e as Error).message }
check('batched: error throws', err.includes('duplicate key value') && err.includes('after 500 rows'), err)
check('batched: stops after failing batch', sent === 2, String(sent))
check('batched: empty input = no calls', (await upsertInBatches([], async () => { throw new Error('called') })) === 0)

// ── forEachGscPage: startRow paging past the 25,000-row API cap, one page at a time
const api = Array.from({ length: 52_345 }, (_, i) => ({ keys: [`q${i}`, '2026-11-01'], clicks: 1 }))
const starts: Array<[number, number]> = []
const sizes: number[] = []
let held = 0, maxHeld = 0
const seen = await forEachGscPage(
  async (startRow, rowLimit) => { starts.push([startRow, rowLimit]); const p = api.slice(startRow, startRow + rowLimit); held += p.length; maxHeld = Math.max(maxHeld, held); return p },
  async (page) => { sizes.push(page.length); held -= page.length },
)
check('gsc paging: every row seen', seen === 52_345, String(seen))
check('gsc paging: startRow sequence', JSON.stringify(starts) === '[[0,25000],[25000,25000],[50000,25000]]', JSON.stringify(starts))
check('gsc paging: pages handed over in order', JSON.stringify(sizes) === '[25000,25000,2345]', JSON.stringify(sizes))
check('gsc paging: never holds more than one page', maxHeld === 25_000, String(maxHeld))
const exact: number[] = []; let calls2 = 0
await forEachGscPage(async (startRow, rowLimit) => { exact.push(startRow); return api.slice(0, 50).slice(startRow, startRow + rowLimit) }, async () => { calls2++ }, 25)
check('gsc paging: exact multiple ends on an empty page, no empty onPage', JSON.stringify(exact) === '[0,25,50]' && calls2 === 2, JSON.stringify(exact))
check('gsc paging: no rows', (await forEachGscPage(async () => [], async () => { throw new Error('called') })) === 0)
let gErr = ''
try { await forEachGscPage(async () => { throw new Error('Search Console API error (403)') }, async () => {}) } catch (e) { gErr = (e as Error).message }
check('gsc paging: API error propagates', gErr.includes('403'), gErr)
let wErr = ''
try { await forEachGscPage(async (s, n) => api.slice(s, s + n), async () => { throw new Error('upsert failed') }) } catch (e) { wErr = (e as Error).message }
check('gsc paging: onPage (write) error propagates', wErr === 'upsert failed', wErr)
let gCap = ''
try { await forEachGscPage(async (s, n) => api.slice(s, s + n), async () => {}, 10_000, 30_000) } catch (e) { gCap = (e as Error).message }
check('gsc paging: refuses past maxRows', gCap.includes('more than 30000'), gCap)

// ── syncWindow
const NOW = Date.parse('2026-11-05T15:00:00Z')
const w0 = syncWindow({}, NOW) as { startDate: string; endDate: string }
check('window default: last 5 days ending yesterday', w0.startDate === '2026-10-31' && w0.endDate === '2026-11-04', JSON.stringify(w0))
check('window: null/non-object body = default', JSON.stringify(syncWindow(null, NOW)) === JSON.stringify(w0) && JSON.stringify(syncWindow('x', NOW)) === JSON.stringify(w0))
check('window: backfill range accepted', JSON.stringify(syncWindow({ start_date: '2026-08-07', end_date: '2026-08-20' }, NOW)) === '{"startDate":"2026-08-07","endDate":"2026-08-20"}')
const bad = (b: unknown) => 'error' in (syncWindow(b, NOW) as object)
check('window: only one date rejected', bad({ start_date: '2026-10-01' }))
check('window: bad format rejected', bad({ start_date: '2026-10-1', end_date: '2026-10-05' }) && bad({ start_date: '2026-02-30', end_date: '2026-03-01' }))
check('window: start after end rejected', bad({ start_date: '2026-10-05', end_date: '2026-10-01' }))
check('window: end after yesterday rejected', bad({ start_date: '2026-11-01', end_date: '2026-11-05' }))
check(`window: more than ${MAX_WINDOW_DAYS} days rejected`, bad({ start_date: '2026-10-01', end_date: '2026-10-15' }) && !bad({ start_date: '2026-10-01', end_date: '2026-10-14' }))
check('window: older than 16 months rejected', bad({ start_date: '2025-06-01', end_date: '2025-06-05' }))
check('window: injection-shaped input rejected', bad({ start_date: "2026-10-01'; drop", end_date: '2026-10-02' }))

// ── selectAll: walks pages past a 1,000-row server cap
const table = Array.from({ length: 2345 }, (_, i) => ({ id: i }))
const ranges: Array<[number, number]> = []
const cap = 1000 // what PostgREST returns at most, whatever is asked
const all = await selectAll(async (from, to) => { ranges.push([from, to]); return { data: table.slice(from, Math.min(to + 1, from + cap)), error: null } }, { pageSize: 1000 })
check('selectAll reads every row', all.length === 2345 && all[2344].id === 2344, String(all.length))
check('selectAll ranges', JSON.stringify(ranges) === '[[0,999],[1000,1999],[2000,2999],[2345,3344]]', JSON.stringify(ranges))
// server cap SMALLER than the page size must not stop early
const all2 = await selectAll(async (from) => ({ data: table.slice(from, from + 300), error: null }), { pageSize: 1000 })
check('selectAll: server cap below page size still reads all', all2.length === 2345, String(all2.length))
let selErr = ''
try { await selectAll(async () => ({ data: null, error: { message: 'boom' } }), { label: 'gsc' }) } catch (e) { selErr = (e as Error).message }
check('selectAll: error throws with label', selErr === 'gsc failed at row 0: boom', selErr)
let capErr = ''
try { await selectAll(async (from) => ({ data: table.slice(from, from + 1000), error: null }), { maxRows: 1500 }) } catch (e) { capErr = (e as Error).message }
check('selectAll: refuses partial read over maxRows', capErr.includes('more than 1500'), capErr)

// ── readers on gsc_keyword_totals (fake RPC capped at 1,000 rows like PostgREST)
const totalsTable = Array.from({ length: 2500 }, (_, i) => ({
  keyword: `k${String(i).padStart(4, '0')}`, clicks: i % 7, impressions: String(i), ctr: 0, position: 5, days: 3, last_date: i === 7 ? '2026-11-04' : '2026-11-01',
}))
const rpcCalls: Array<{ fn: string; args: unknown; order: string[]; limit?: number }> = []
const fakeDb: any = {
  rpc(fn: string, args: unknown) {
    const call = { fn, args, order: [] as string[], limit: undefined as number | undefined }
    rpcCalls.push(call)
    let rows = [...totalsTable]
    const q: any = {
      order: (c: string, o?: { ascending?: boolean }) => {
        call.order.push(`${c}${o?.ascending === false ? ' desc' : ''}`)
        if (c === 'impressions') rows.sort((a, b) => Number(b.impressions) - Number(a.impressions) || a.keyword.localeCompare(b.keyword))
        return q
      },
      range: async (from: number, to: number) => ({ data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null }),
      limit: async (n: number) => { call.limit = n; return { data: rows.slice(0, Math.min(n, 1000)), error: null } },
    }
    return q
  },
  from(_t: string) {
    const q: any = { select: () => q, order: () => q, range: async (from: number) => ({ data: from === 0 ? [{ keyword: 'ads kw', avg_monthly_searches: 10, synced_at: '2026-11-03' }] : [], error: null }) }
    return q
  },
}
const all3 = await fetchGscKeywordTotals(fakeDb, '2026-08-07')
check('totals: every keyword read past the 1,000 cap', all3.length === 2500, String(all3.length))
check('totals: paged by keyword, since passed', rpcCalls[0].fn === 'gsc_keyword_totals' && (rpcCalls[0].args as any).p_since === '2026-08-07' && rpcCalls[0].order.join() === 'keyword')
check('totals: numeric strings normalised', all3[2499].impressions === 2499 && typeof all3[2499].impressions === 'number')
rpcCalls.length = 0
const top = await fetchTopKeywords(fakeDb, 30, 20)
check('seo-agent: one request, top 20 by impressions', rpcCalls.length === 1 && rpcCalls[0].limit === 20 && rpcCalls[0].order.join() === 'impressions desc,keyword', JSON.stringify(rpcCalls))
check('seo-agent: best first, GscKeywordRow shape', top.length === 20 && top[0].keyword === 'k2499' && JSON.stringify(Object.keys(top[0])) === '["keyword","clicks","impressions","ctr","position"]', JSON.stringify(top[0]))
const sc = await getSearchConsoleData(fakeDb, { window_days: 30, min_impressions: 100 })
check('marketing_intel: every keyword, min_impressions applied', sc.total_keywords === 2400, String(sc.total_keywords))
check('marketing_intel: top_by_clicks sorted', sc.top_by_clicks[0].clicks === 6)
const res = await fetchKeywordResearch(fakeDb)
check('keyword_research: every keyword + ads rows', res.rows.filter(r => r.source === 'search_console').length === 2500 && res.rows.some(r => r.source === 'google_ads'), String(res.rows.length))
check('keyword_research: gsc_as_of = newest last_date', res.gsc_as_of === '2026-11-04', String(res.gsc_as_of))

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
