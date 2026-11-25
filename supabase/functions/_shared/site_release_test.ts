// deno run -A supabase/functions/_shared/site_release_test.ts
import { localNow, pageKey, pickRelease, releaseDue, releaseSettings } from './site_release.ts'

let failed = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `  — ${detail}`}`)
  if (!ok) failed++
}
const S = releaseSettings({ enabled: true, weekday: 0, hour: 10, tz: 'Asia/Jerusalem' })

check('missing setting → off, Sunday 10:00 Israel', JSON.stringify(releaseSettings(undefined)) === JSON.stringify({ enabled: false, weekday: 0, hour: 10, tz: 'Asia/Jerusalem' }))
check('odd values fall back to defaults', releaseSettings({ enabled: 'yes', weekday: 9, hour: -1 }).enabled === false && releaseSettings({ weekday: 9 }).weekday === 0 && releaseSettings({ hour: 30 }).hour === 10)
// 2026-11-29 is a Sunday. Israel is UTC+2 in winter.
check('local time in Israel (winter, UTC+2)', JSON.stringify(localNow(new Date('2026-11-29T08:00:00Z'), 'Asia/Jerusalem')) === JSON.stringify({ date: '2026-11-29', weekday: 0, hour: 10 }))
check('Sunday 09:59 Israel → not due', releaseDue(new Date('2026-11-29T07:59:00Z'), S) === null)
check('Sunday 10:00 Israel → due, dated that Sunday', releaseDue(new Date('2026-11-29T08:00:00Z'), S) === '2026-11-29')
check('Sunday 23:30 Israel → still due (a late tick still releases)', releaseDue(new Date('2026-11-29T21:30:00Z'), S) === '2026-11-29')
check('Saturday 23:30 UTC = Sunday 01:30 Israel → not due yet', releaseDue(new Date('2026-11-28T23:30:00Z'), S) === null)
check('Monday → not due', releaseDue(new Date('2026-11-30T08:00:00Z'), S) === null)
check('summer time (UTC+3): Sunday 07:00 UTC = 10:00 Israel → due', releaseDue(new Date('2026-06-07T07:00:00Z'), S) === '2026-06-07')
check('switched off → never due', releaseDue(new Date('2026-11-29T08:00:00Z'), { ...S, enabled: false }) === null)

check('product description, FAQ, short description and SEO of one product are one page', new Set(['product_description', 'product_faq', 'product_short_description', 'seo_meta', 'product_status'].map((t) => pageKey(t, 65189))).size === 1)
check('a category and a product with the same id are different pages', pageKey('term_description', 387) !== pageKey('product_description', 387))
const q = [
  { id: 'b', target_type: 'product_faq', target_id: 1, approved_at: '2026-11-25T10:00:00Z' },
  { id: 'a', target_type: 'product_description', target_id: 1, approved_at: '2026-11-25T09:00:00Z' },
  { id: 'c', target_type: 'term_description', target_id: 1, approved_at: '2026-11-25T11:00:00Z' },
  { id: 'd', target_type: 'seo_meta', target_id: 2, approved_at: '2026-11-25T12:00:00Z' },
]
const r = pickRelease(q)
check('one change per page, the oldest approval goes first', r.publish.map((c) => c.id).join(',') === 'a,c,d' && r.defer.map((c) => c.id).join(',') === 'b', JSON.stringify(r))
check('empty queue → nothing to do', pickRelease([]).publish.length === 0)

if (failed) { console.error(`\n${failed} FAILED`); Deno.exit(1) }
console.log('\nall passed')
