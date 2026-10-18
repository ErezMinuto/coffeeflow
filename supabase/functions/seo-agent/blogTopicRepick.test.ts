// Run with: deno test --allow-env supabase/functions/seo-agent/blogTopicRepick.test.ts
// (--allow-env because cannibalizationCheck.ts reads WP env vars at module load.)

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  collectBlockedKeywords,
  renderBlockedKeywordsBlock,
  parseRepick,
  screenRepick,
  buildRepickPrompt,
} from './blogTopicRepick.ts'

const conflict = (created_at: string, keyword: string, titles: string[]) => ({
  created_at,
  brief_data: { details: { intended_keyword: keyword, conflicting_posts: titles.map(title => ({ title })) } },
})

Deno.test('a keyword blocked on several cycles appears once, with the newest date', () => {
  const out = collectBlockedKeywords([
    conflict('2026-10-07T05:00:00Z', 'פולי קפה איכותיים', ['a']),
    conflict('2026-10-18T05:15:00Z', 'פולי קפה ערביקה', ['b', 'c']),
    conflict('2026-10-11T05:00:00Z', 'פולי  קפה איכותיים', ['a']),
  ])
  assertEquals(out.map(b => [b.keyword, b.blocked_at]), [
    ['פולי קפה ערביקה', '2026-10-18'],
    ['פולי  קפה איכותיים', '2026-10-11'],
  ])
  assertEquals(out[0].overlaps, ['b', 'c'])
})

Deno.test('rows without a keyword are skipped, not rendered as empty quotes', () => {
  const out = collectBlockedKeywords([{ created_at: '2026-10-01T00:00:00Z', brief_data: { details: {} } }])
  assertEquals(out, [])
  assert(renderBlockedKeywordsBlock(out).includes('none'))
})

Deno.test('parseRepick rejects a reply missing keyword, title or key points', () => {
  assertEquals(parseRepick({ keyword: 'x', title: 'y' }), null)
  assertEquals(parseRepick('not json'), null)
  const ok = parseRepick({ keyword: ' מטחנה ', title: 't', key_points: ['a', ''], products_to_mention: 'nope' })
  assertEquals(ok, { keyword: 'מטחנה', title: 't', key_points: ['a'], products_to_mention: [], why_now: '' })
})

Deno.test('screenRepick catches exact repeats and near-repeats in both directions', () => {
  const base = { title: 't', key_points: ['a'], products_to_mention: [], why_now: '' }
  const forbidden = ['פולי קפה ערביקה']
  assert(screenRepick({ ...base, keyword: 'פולי קפה ערביקה' }, forbidden))
  assert(screenRepick({ ...base, keyword: 'פולי קפה ערביקה איכותיים' }, forbidden))
  assert(screenRepick({ ...base, keyword: 'קפה ערביקה' }, forbidden))
  assertEquals(screenRepick({ ...base, keyword: 'טחינה לאספרסו ביתי' }, forbidden), null)
})

Deno.test('the re-pick prompt names the rejected keyword and every blocked one', () => {
  const prompt = buildRepickPrompt({
    rejected: [{ keyword: 'פולי קפה ערביקה', title: 'T', overlaps: ['Existing post'], brief: { keyword: 'פולי קפה ערביקה' } }],
    blocked: [{ keyword: 'פולי קפה איכותיים', blocked_at: '2026-10-11', overlaps: [] }],
    queuedKeywords: [], recentTitles: [], gscKeywords: [], opportunities: [], catalogNames: [],
  })
  assert(prompt.includes('"פולי קפה ערביקה"'))
  assert(prompt.includes('Existing post'))
  assert(prompt.includes('פולי קפה איכותיים'))
})
