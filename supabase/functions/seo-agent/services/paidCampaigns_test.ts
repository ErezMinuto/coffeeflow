// deno run --allow-read supabase/functions/seo-agent/services/paidCampaigns_test.ts
import { rollUpActive } from './paidCampaigns.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const m = (r: any) => ({ spend: Number(r.spend ?? 0), clicks: Number(r.clicks ?? 0), purchases: Number(r.purchases ?? 0), value: Number(r.value ?? 0) })
const rows = [
  { campaign_id: 'a', date: '2026-11-01', name: 'A new', status: 'ACTIVE', spend: 10, clicks: 5, purchases: 1, value: 80 },
  { campaign_id: 'a', date: '2026-10-20', name: 'A old', status: 'PAUSED', spend: 30, clicks: 7, purchases: 0, value: 0 },
  { campaign_id: 'b', date: '2026-11-01', name: 'B', status: 'PAUSED', spend: 99 },                 // latest paused
  { campaign_id: 'c', date: '2026-10-01', name: 'C', status: 'ACTIVE', spend: 5 },                  // stale
  { campaign_id: '',  date: '2026-11-01', name: 'no id', status: 'ACTIVE', spend: 1 },              // dropped
  { campaign_id: 'd', date: '2026-11-02', name: 'D', status: 'ACTIVE', spend: '12.5', clicks: null }, // string / null metrics
]
const out = rollUpActive(rows as any, 'ACTIVE', '2026-10-30', m)
const ids = out.map(c => c.campaign_id).join(',')
check('keeps only campaigns whose LATEST row is active and fresh', ids === 'a,d', ids)
const a = out.find(c => c.campaign_id === 'a')!
check('totals cover the whole window, name from the latest row', a.spend_ils === 40 && a.clicks === 12 && a.name === 'A new' && a.last_data_date === '2026-11-01')
check('numeric strings summed, nulls as 0', out.find(c => c.campaign_id === 'd')!.spend_ils === 12.5)
check('row order does not matter', rollUpActive([...rows].reverse() as any, 'ACTIVE', '2026-10-30', m).map(c => c.campaign_id).join(',') === 'a,d')
check('sorted by spend desc', out[0].spend_ils >= out[out.length - 1].spend_ils)

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
