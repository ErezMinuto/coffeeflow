// deno run --allow-read --allow-env supabase/functions/_shared/blog_keyword_gate_test.ts
import { blogResearchProblems, cannibalVerdict, indexResearch, type ResearchKeyword } from './blog_keyword_gate.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
// Research rows: fixtures for the test only (not seeded into any prompt).
const rows: ResearchKeyword[] = [
  { source: 'search_console', keyword: 'מכונת קפה לבית', impressions: 900, clicks: 12, position: 14, ranking_page: 'https://www.minuto.co.il/product-category/machines/' },
  { source: 'google_ads', keyword: 'פולי קפה', impressions: 4200 },
]
const idx = indexResearch(rows)
const rec = (keyword: string, research?: unknown) => ({ keyword, research })

// Real failing example: strategist run 301079dd (2026-11-03) proposed this
// content_blog keyword, derived from sales data. It is in neither research table.
const failing = 'ניקוי אבנית ותחזוקת מכונת אספרסו'
check('2026-11-03 failing keyword refused (no evidence)', blogResearchProblems(rec(failing), idx).length > 0)
check('2026-11-03 failing keyword refused even with claimed evidence', blogResearchProblems(rec(failing, { source: 'search_console', keyword: failing }), idx).some(p => p.includes('not in the search_console')))

check('GSC keyword with evidence accepted', blogResearchProblems(rec('מכונת קפה לבית', { source: 'search_console', keyword: 'מכונת קפה לבית' }), idx).length === 0)
check('normalised match (case/punctuation/niqqud)', blogResearchProblems(rec('מְכונת קפה, לבית', { source: 'search_console', keyword: 'מכונת קפה לבית' }), idx).length === 0)
check('Google Ads keyword accepted', blogResearchProblems(rec('פולי קפה', { source: 'google_ads', keyword: 'פולי קפה' }), idx).length === 0)
check('wrong source refused', blogResearchProblems(rec('פולי קפה', { source: 'search_console', keyword: 'פולי קפה' }), idx).length > 0)
check('unknown source refused', blogResearchProblems(rec('פולי קפה', { source: 'keyword_planner', keyword: 'פולי קפה' }), idx).length > 0)
check('keyword ≠ research keyword refused', blogResearchProblems(rec('פולי קפה טריים', { source: 'google_ads', keyword: 'פולי קפה' }), idx).length > 0)
check('partial overlap is not a match', blogResearchProblems(rec('קפה', { source: 'google_ads', keyword: 'קפה' }), idx).length > 0)
check('missing keyword refused', blogResearchProblems({ research: { source: 'google_ads', keyword: 'פולי קפה' } }, idx).length > 0)

// Cannibalization: strict.
check('conflict blocks with the post URL', (() => { const v = cannibalVerdict({ checked: true, conflicts: [{ id: 1, title: 'הוראות לניקוי מקינטה', status: 'publish', link: 'https://www.minuto.co.il/blog/x/' }] }); return v.block && v.reason.includes('https://www.minuto.co.il/blog/x/') })())
check('draft conflict also blocks', cannibalVerdict({ checked: true, conflicts: [{ id: 2, title: 't', status: 'draft', link: '' }] }).block)
check('unchecked (WP down) blocks: fail closed', cannibalVerdict({ checked: false, conflicts: [], reason: 'WP search HTTP 503' }).block)
check('GSC blog page already ranking blocks', cannibalVerdict({ checked: true, conflicts: [] }, 'https://www.minuto.co.il/blog/%D7%9E%D7%93%D7%A8%D7%99%D7%9A/').block)
check('GSC product page ranking does not block', !cannibalVerdict({ checked: true, conflicts: [] }, 'https://www.minuto.co.il/product/x/').block)
check('clean keyword passes', !cannibalVerdict({ checked: true, conflicts: [] }, null).block)

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
