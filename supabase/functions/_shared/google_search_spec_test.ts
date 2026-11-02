// deno run --allow-read supabase/functions/_shared/google_search_spec_test.ts
import { googleSearchSpecProblems } from './google_search_spec.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const good = {
  campaign_name: 'Ethiopia beans', campaign_type: 'search', daily_budget_ils: 40, duration_days: 14,
  keywords: ['פולי קפה אתיופיה'], match_type: 'PHRASE', negative_keywords: ['ירוק'],
  creative: { headlines: ['פולי קפה טריים', 'בית קלייה ספיישלטי', 'קלוי בכל שבוע'], descriptions: ['קפה ספיישלטי קלוי בכל שבוע, ישר אליכם.', 'שקית 330 גרם מבית הקלייה.'], path1: 'קפה', path2: 'אתיופיה' },
  landing_page_url: 'https://www.minuto.co.il/product/ethiopia',
}
const probs = (o: Record<string, unknown>) => googleSearchSpecProblems({ ...good, ...o })
check('valid spec has no problems', googleSearchSpecProblems(good).length === 0, googleSearchSpecProblems(good).join('; '))
check('31-char headline caught', probs({ creative: { ...good.creative, headlines: ['א'.repeat(31), 'b', 'c'] } }).some(p => p.startsWith('headline 1')))
check('Hebrew counted by code points (30 ok)', probs({ creative: { ...good.creative, headlines: ['א'.repeat(30), 'b', 'c'] } }).length === 0)
check('emoji counted as one character', probs({ creative: { ...good.creative, headlines: ['☕'.repeat(30), 'b', 'c'] } }).length === 0)
check('2 headlines too few', probs({ creative: { ...good.creative, headlines: ['a', 'b'] } }).length > 0)
check('91-char description caught', probs({ creative: { ...good.creative, descriptions: ['x'.repeat(91), 'y'] } }).some(p => p.startsWith('description 1')))
check('BROAD refused', probs({ match_type: 'BROAD' }).length > 0)
check('PMax refused', probs({ campaign_type: 'performance_max' }).length > 0)
check('over daily cap refused', probs({ daily_budget_ils: 101 }).length > 0)
check('string budget refused', probs({ daily_budget_ils: '40' }).length > 0)
check('off-site landing page refused', probs({ landing_page_url: 'https://evil.example/minuto.co.il' }).length > 0)
check('lookalike host refused', probs({ landing_page_url: 'https://minuto.co.il.evil.com/x' }).length > 0)
check('http refused', probs({ landing_page_url: 'http://www.minuto.co.il/x' }).length > 0)
check('empty keywords refused', probs({ keywords: [] }).length > 0)
check('long path refused', probs({ creative: { ...good.creative, path1: 'x'.repeat(16) } }).length > 0)
check('non-object refused', googleSearchSpecProblems(null).length > 0)

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
