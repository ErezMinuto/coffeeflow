// deno run supabase/functions/google-search-sync/rows_test.ts
import { chunk, dedupeByKey, fetchAllGscRows, toDbRows, upsertInBatches, type GscDbRow } from './rows.ts'
import { selectAll } from '../_shared/select_all.ts'
import { aggregateGscKeywords } from '../seo-agent/services/googleApi.ts'
import { aggregateGsc, fetchKeywordResearch } from '../_shared/keyword_research.ts'
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

// ── fetchAllGscRows: startRow paging past the 25,000-row API cap
const api = Array.from({ length: 52_345 }, (_, i) => ({ keys: [`q${i}`, '2026-11-01'], clicks: 1 }))
const starts: Array<[number, number]> = []
const got = await fetchAllGscRows(async (startRow, rowLimit) => { starts.push([startRow, rowLimit]); return api.slice(startRow, startRow + rowLimit) })
check('gsc paging: every row fetched', got.length === 52_345 && got[52_344].keys![0] === 'q52344', String(got.length))
check('gsc paging: startRow sequence', JSON.stringify(starts) === '[[0,25000],[25000,25000],[50000,25000]]', JSON.stringify(starts))
const exact: Array<number> = []
const got2 = await fetchAllGscRows(async (startRow, rowLimit) => { exact.push(startRow); return api.slice(0, 50).slice(startRow, startRow + rowLimit) }, 25)
check('gsc paging: exact multiple ends on an empty page', got2.length === 50 && JSON.stringify(exact) === '[0,25,50]', JSON.stringify(exact))
check('gsc paging: no rows', (await fetchAllGscRows(async () => [])).length === 0)
let gErr = ''
try { await fetchAllGscRows(async () => { throw new Error('Search Console API error (403)') }) } catch (e) { gErr = (e as Error).message }
check('gsc paging: API error propagates', gErr.includes('403'), gErr)
let gCap = ''
try { await fetchAllGscRows(async (s, n) => api.slice(s, s + n), 10_000, 30_000) } catch (e) { gCap = (e as Error).message }
check('gsc paging: refuses past maxRows', gCap.includes('more than 30000'), gCap)

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

// ── readers' aggregation (rows as they look after the dedupe migration)
const daily = [
  { keyword: 'פולי קפה', clicks: 2, impressions: 100, position: 10 },
  { keyword: 'פולי קפה', clicks: 1, impressions: 300, position: 6 },
  { keyword: 'v60', clicks: 0, impressions: 0, position: 30 },
  { keyword: 'v60', clicks: 0, impressions: 0, position: 20 },
  { keyword: 'אספרסו', clicks: 5, impressions: 50, position: 3 },
]
const top = aggregateGscKeywords(daily, 2)
check('seo-agent: sums per keyword', top[0].keyword === 'פולי קפה' && top[0].clicks === 3 && top[0].impressions === 400)
check('seo-agent: impression-weighted position', top[0].position === 7, String(top[0].position))
check('seo-agent: ctr = clicks / impressions', top[0].ctr === 3 / 400)
check('seo-agent: limit + sort by impressions', top.length === 2 && top[1].keyword === 'אספרסו')
const zero = aggregateGscKeywords(daily, 10).find(x => x.keyword === 'v60')!
check('seo-agent: zero-impression keyword gets mean position, not NaN', zero.position === 25 && zero.ctr === 0, JSON.stringify(zero))
// The bug this fixes: the same day stored 7 times summed to 7x. After dedupe one row per day.
const dup = Array.from({ length: 7 }, () => ({ keyword: 'k', clicks: 1, impressions: 10, position: 5 }))
check('seo-agent: 7 copies of one day = 7x (why the migration dedupes)', aggregateGscKeywords(dup, 1)[0].impressions === 70)
check('seo-agent: one row per day = true total', aggregateGscKeywords(dedupeByKey(dup.map(x => r('d1', x.keyword, null, x.clicks))).map(x => ({ ...x, impressions: 10, position: 5 })), 1)[0].impressions === 10)
const kr = aggregateGsc(daily)
check('keyword_research: same totals as seo-agent', kr[0].keyword === 'פולי קפה' && kr[0].impressions === 400 && kr[0].clicks === 3 && kr[0].position === 7)

// ── readers end to end against a fake PostgREST that caps responses at 1,000
// 2,500 rows for one keyword (10 impressions each) + a __page__ row that must be ignored.
const gscTable = [
  ...Array.from({ length: 2500 }, (_, i) => ({ id: i, keyword: 'k', page: null, clicks: 1, impressions: 10, position: 4, date: '2026-11-01' })),
  { id: 9999, keyword: '__page__', page: '/x/', clicks: 50, impressions: 5000, position: 1, date: '2026-11-01' },
]
const fakeDb: any = {
  from(t: string) {
    let rows: any[] = t === 'google_search_console' ? gscTable : [{ keyword: 'ads kw', avg_monthly_searches: 10, synced_at: '2026-11-03' }]
    const q: any = {
      select: () => q, gte: () => q, order: () => q,
      neq: (c: string, v: unknown) => { rows = rows.filter(x => x[c] !== v); return q },
      range: async (from: number, to: number) => ({ data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null }),
      limit: async () => ({ data: rows.slice(0, 1000), error: null }),
    }
    return q
  },
}
const sc = await getSearchConsoleData(fakeDb, { window_days: 30 })
check('marketing_intel: reads past 1,000 rows', sc.top_by_clicks[0].impressions === 25000 && sc.top_by_clicks[0].clicks === 2500, JSON.stringify(sc.top_by_clicks[0]))
check('marketing_intel: __page__ excluded', sc.total_keywords === 1)
const tk = await fetchTopKeywords(fakeDb, 30, 10)
check('seo-agent fetchTopKeywords: reads past 1,000 rows', tk.length === 1 && tk[0].impressions === 25000, JSON.stringify(tk))
const res = await fetchKeywordResearch(fakeDb)
const gscKw = res.rows.filter(x => x.source === 'search_console')
check('keyword_research: reads past 1,000 rows', gscKw.length === 1 && gscKw[0].impressions === 25000, JSON.stringify(gscKw))
check('keyword_research: __page__ is not a research keyword', !res.rows.some(x => x.keyword === '__page__'))

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
