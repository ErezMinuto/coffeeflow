// deno run --allow-read supabase/functions/_shared/innovation_pitch_test.ts
import { normaliseUrl, pitchDedupeKey, pitchProblems, researchIsFresh } from './innovation_pitch.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const allowed = new Set(['https://blog.example.com/advantage-plus', 'https://www.facebook.com/business/news/x'].map(u => normaliseUrl(u)!))
const good = {
  title: 'Meta Advantage+ catalog ads', why_it_matters: 'Lets a small store run catalog ads with less setup.',
  hypothesis: 'ROAS on bean products from 2.1 (last 30d) improves; test with a ₪30/day PAUSED draft for 14 days.',
  check_metric: 'roas', effort: 'small', implementation_steps: ['Create a PAUSED draft', 'Compare ROAS after 14 days'],
  sources: [{ url: 'https://blog.example.com/advantage-plus/', title: 'x' }],
}
const probs = (o: Record<string, unknown>) => pitchProblems({ ...good, ...o }, allowed)

check('valid pitch passes (trailing slash tolerated)', pitchProblems(good, allowed).length === 0, pitchProblems(good, allowed).join('; '))
check('source not in research refused', probs({ sources: [{ url: 'https://invented.example/' }] }).some(p => p.includes('not in this week')))
check('javascript: source refused', probs({ sources: [{ url: 'javascript:alert(1)' }] }).some(p => p.includes('not an http')))
check('no sources refused', probs({ sources: [] }).length > 0)
check('unknown metric refused', probs({ check_metric: 'likes' }).length > 0)
check('prototype-ish metric refused', probs({ check_metric: 'constructor' }).length > 0)
check('bad effort refused', probs({ effort: 'tiny' }).length > 0)
check('no steps refused', probs({ implementation_steps: [] }).length > 0)
check('blank step refused', probs({ implementation_steps: [' '] }).length > 0)
check('missing hypothesis refused', probs({ hypothesis: '' }).length > 0)
check('non-object refused', pitchProblems(null, allowed).length > 0)
check('hash ignored in URL match', probs({ sources: [{ url: 'https://www.facebook.com/business/news/x#frag' }] }).length === 0)

check('dedupe key ignores case/punctuation', pitchDedupeKey('Meta Advantage+ Catalog Ads!') === pitchDedupeKey('meta  advantage catalog-ads'))
check('dedupe key keeps Hebrew, drops niqqud', pitchDedupeKey('קָפֶה חדש') === pitchDedupeKey('קפה חדש') && pitchDedupeKey('קפה חדש') === 'pitch:קפה-חדש')
check('empty title → empty key', pitchDedupeKey('!!!') === '')

const now = new Date('2026-11-09T08:00:00Z')
check('6-day-old research is fresh', researchIsFresh('2026-11-03T08:00:00Z', now))
check('8-day-old research is stale', !researchIsFresh('2026-11-01T08:00:00Z', now))
check('missing research is stale', !researchIsFresh(null, now))
check('future timestamp is not fresh', !researchIsFresh('2026-11-10T08:00:00Z', now))
check('garbage timestamp is not fresh', !researchIsFresh('not a date', now))

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
