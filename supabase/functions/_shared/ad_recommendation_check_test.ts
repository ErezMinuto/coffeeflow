// deno run --allow-read supabase/functions/_shared/ad_recommendation_check_test.ts
import { adRecommendationProblems } from './ad_recommendation_check.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const lineup = ['אתיופיה גוג׳י נטורל', 'ברזיל סנטוס']
const meta = { title: 'm', action_type: 'ad_meta', action_params: { product: 'ברזיל סנטוס', daily_budget_ils: 40, duration_days: 14 } }
const google = { title: 'g', action_type: 'ad_google', action_params: { keywords: ['פולי קפה ברזיל'], product: 'ברזיל סנטוס' } }
const p = (recs: any[]) => adRecommendationProblems(recs, lineup)

check('valid meta + google pass', p([meta, google]).length === 0, p([meta, google]).join('; '))
check('non-ad recs ignored', p([{ action_type: 'content_blog', action_params: {} }]).length === 0)
check('3 ad recs refused', p([meta, google, meta]).some(x => x.startsWith('at most')))
check('meta without product refused', p([{ ...meta, action_params: {} }]).length > 0)
check('unknown product refused', p([{ ...meta, action_params: { product: 'Veneto Delux' } }]).length > 0)
check('budget over cap refused', p([{ ...meta, action_params: { ...meta.action_params, daily_budget_ils: 150 } }]).length > 0)
check('string budget refused', p([{ ...meta, action_params: { ...meta.action_params, daily_budget_ils: '40' } }]).length > 0)
check('fractional duration refused', p([{ ...meta, action_params: { ...meta.action_params, duration_days: 2.5 } }]).length > 0)
check('google without keywords refused', p([{ ...google, action_params: { product: 'ברזיל סנטוס' } }]).length > 0)
check('google blank keyword refused', p([{ ...google, action_params: { keywords: [' '], product: 'ברזיל סנטוס' } }]).length > 0)
check('google landing_url instead of product ok', p([{ ...google, action_params: { keywords: ['x'], landing_url: 'https://www.minuto.co.il/shop' } }]).length === 0)
check('bad landing_url refused even with a valid product', p([{ ...google, action_params: { ...google.action_params, landing_url: 'https://evil.example/' } }]).some(x => x.includes('landing_url must be')))
check('meta bad landing_url refused too', p([{ ...meta, action_params: { ...meta.action_params, landing_url: 'http://www.minuto.co.il/' } }]).some(x => x.includes('landing_url must be')))
check('google off-site url refused', p([{ ...google, action_params: { keywords: ['x'], landing_url: 'https://minuto.co.il.evil.com/' } }]).length > 0)

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
