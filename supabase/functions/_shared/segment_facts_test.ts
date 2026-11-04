// Tests for segment facts and the email_campaign check in conclude_brief.
//
//   deno run --allow-read --allow-env supabase/functions/_shared/segment_facts_test.ts
//
// Numbers are prod on 2026-11-04 (customer_rfm non-superseded, joined to
// marketing_contacts on lower(email) where opted_in):
//   segment      total  opted_in  opted_in & >90d  with beans
//   lost          1449        89               89           0
//   big_spender    793       104               97         793
//   new            673       100               98           0
//   loyal          434        68               66         110
//   champion       367        98               54         367
//   at_risk        265        52               52         106

import {
  audienceFactsBlock, computeSegmentFacts, emailRecProblems, peopleCounts, SEGMENT_DEFINITIONS,
  type RfmFactRow, type SegmentFacts,
} from './segment_facts.ts'
import { DEFAULT_MIN_EMAIL_REACHABLE } from './strategist_loop.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const PROD: Array<[string, number, number, number, number]> = [
  ['lost',        1449,  89, 89,   0],
  ['big_spender',  793, 104, 97, 793],
  ['new',          673, 100, 98,   0],
  ['loyal',        434,  68, 66, 110],
  ['champion',     367,  98, 54, 367],
  ['at_risk',      265,  52, 52, 106],
]

// Rows that reproduce the table: the first `opted` rows of a segment are opted
// in, the first `lapsed` of those are >90 days, the first `beans` have grams.
const rows: RfmFactRow[] = []
const optedIn = new Set<string>()
for (const [seg, total, opted, lapsed, beans] of PROD) {
  for (let i = 0; i < total; i++) {
    const email = `${seg}${i}@Example.com`        // mixed case: matching must normalise
    if (i < opted) optedIn.add(email.toLowerCase())
    rows.push({ email: ` ${email} `, segment: seg, days_since_last: i < opted ? (i < lapsed ? 200 : 30) : 120, bean_grams: i < beans ? 660 : 0 })
  }
}
rows.push({ email: 'old@example.com', segment: 'superseded', days_since_last: 999, bean_grams: 0 })
optedIn.add('old@example.com')

const facts = computeSegmentFacts(rows, optedIn)
const bs = facts.segments.find(f => f.segment === 'big_spender')!

// ── Facts ────────────────────────────────────────────────────────────────────
check('total customers excludes superseded', facts.total_customers === 3981, String(facts.total_customers))
check('total opted-in reachable', facts.total_opted_in_reachable === 511, String(facts.total_opted_in_reachable))
check('big_spender total 793', bs.total === 793)
check('big_spender opted-in reachable 104', bs.opted_in_reachable === 104)
check('big_spender lapsed reachable 97', bs.lapsed_90d_reachable === 97)
check('big_spender all bought beans', bs.bean_buyer_share === 1)
check('big_spender definition says bean grams, not equipment', /bean grams/.test(bs.definition) && /not shekels and not equipment/.test(bs.definition))
for (const [seg, total, opted, lapsed] of PROD) {
  const f = facts.segments.find(x => x.segment === seg)!
  check(`${seg} counts`, f.total === total && f.opted_in_reachable === opted && f.lapsed_90d_reachable === lapsed,
    `${f.total}/${f.opted_in_reachable}/${f.lapsed_90d_reachable}`)
}
check('loyal bean share 0.25', facts.segments.find(f => f.segment === 'loyal')!.bean_buyer_share === 0.25)

{
  const unknown = computeSegmentFacts(rows, null)
  check('no opt-in data: reach is null, not 0', unknown.segments.every(f => f.opted_in_reachable === null && f.lapsed_90d_reachable === null) && unknown.total_opted_in_reachable === null)
}

// Every segment rfm-sync can assign has a definition (catches the two drifting apart).
{
  const src = await Deno.readTextFile(new URL('../rfm-sync/index.ts', import.meta.url))
  const fn = src.slice(src.indexOf('function assignSegment'), src.indexOf('function quintileScore'))
  const assigned = [...fn.matchAll(/return "([a-z_]+)"/g)].map(m => m[1])
  check('rfm-sync assignSegment parsed', assigned.length === 7, assigned.join(','))
  check('every assigned segment is defined', assigned.every(s => s in SEGMENT_DEFINITIONS), assigned.filter(s => !(s in SEGMENT_DEFINITIONS)).join(','))
}

// ── The 2026-11-04 recommendation (run 301079dd) is refused ──────────────────
const realRec = {
  title: 'Execute big_spender Winback Email',
  rationale: "791 big_spender customers who bought equipment but haven't reordered beans",
  action_type: 'email_campaign',
  action_params: { target_segment: 'big_spender', angle: 'winback', products: [], subject_he: 'חוזרים לקפה שלנו' },
}
{
  const p = emailRecProblems([realRec], [facts], 50)
  const all = p.join(' | ')
  check('real rec refused', p.length > 0)
  check('…for missing reachable_opted_in (shows 104)', /reachable_opted_in must be .*104 for big_spender/.test(all))
  check('…for the invented 791', /count\(s\) 791 are not in the segment data/.test(all))
  check('…for the equipment / no-beans description', /equipment buyers or non-bean buyers, but 100% of big_spender bought Minuto beans/.test(all))
  check('…for not stating the reachable count', /must state the reachable audience, 104/.test(all))
}

// ── A correct one passes at a low bar; Erez's minimum (200, 2026-11-04) refuses it
const goodRec = {
  title: 'Big spender winback email (104 reachable)',
  rationale: 'big_spender is 793 customers scored on lifetime Minuto bean grams; 104 opted-in contacts can be emailed, 97 of them last ordered over 90 days ago.',
  action_type: 'email_campaign',
  action_params: { target_segment: 'big_spender', reachable_opted_in: 104, angle: 'new roasts', products: [], subject_he: 'קלינו משהו חדש' },
}
check('correct rec passes at minimum 50', emailRecProblems([goodRec], [facts], 50).length === 0, emailRecProblems([goodRec], [facts], 50).join(' | '))
{
  const p = emailRecProblems([goodRec], [facts], DEFAULT_MIN_EMAIL_REACHABLE)
  check('big_spender (104) refused at the default minimum of 200', p.length === 1 && /104 opted-in reachable customers, below the minimum email audience of 200/.test(p[0]), p.join(' | '))
  const largest = Math.max(...facts.segments.map(f => f.opted_in_reachable ?? 0))
  check('today no segment reaches 200 opted-in (largest is 104)', largest === 104 && largest < DEFAULT_MIN_EMAIL_REACHABLE)
}
{
  const atRisk = { ...goodRec, title: 'At-risk email', rationale: '52 opted-in at_risk customers', action_params: { ...goodRec.action_params, target_segment: 'at_risk', reachable_opted_in: 52 } }
  check('at_risk 52 passes at 50', emailRecProblems([atRisk], [facts], 50).length === 0)
  check('at_risk 52 refused at 60', emailRecProblems([atRisk], [facts], 60).some(p => /below the minimum/.test(p)))
}
check('wrong reachable number refused', emailRecProblems([{ ...goodRec, action_params: { ...goodRec.action_params, reachable_opted_in: 793 } }], [facts], 50).some(p => /must be the segment's opted_in_reachable/.test(p)))
check('unknown segment refused', emailRecProblems([{ ...goodRec, action_params: { ...goodRec.action_params, target_segment: 'equipment_no_beans' } }], [facts], 50).some(p => /target_segment must be one of/.test(p)))
check('non-email recs are not checked', emailRecProblems([{ title: 'x', rationale: '791 customers', action_type: 'content_blog' }], [facts], 50).length === 0)

// Snapshot vs fresh read: rfm-sync ran mid-run. A number from either is from the data.
{
  const fresh: SegmentFacts = { ...facts, segments: facts.segments.map(f => f.segment === 'big_spender' ? { ...f, total: 795, opted_in_reachable: 105 } : f) }
  check('number from the run snapshot accepted after a fresh rfm-sync', emailRecProblems([goodRec], [facts, fresh], 50).length === 0)
  check('…and so is the fresh one', emailRecProblems([{ ...goodRec, title: 'Winback (105 reachable)', action_params: { ...goodRec.action_params, reachable_opted_in: 105 } }], [facts, fresh], 50).length === 0)
}
// No usable facts → no email rec can be sized.
{
  const blind = computeSegmentFacts(rows, null)
  check('facts without opt-in counts are unusable', emailRecProblems([goodRec], [blind], 50).some(p => /segment data is unavailable/.test(p)))
  check('no facts at all refuses email recs', emailRecProblems([goodRec], [], 50).length === 1)
  check('no facts, no email recs: nothing to say', emailRecProblems([{ title: 'b', action_type: 'content_blog' }], [], 50).length === 0)
}

// ── Head-count extraction ignores numbers that are not head counts ───────────
check('791 big_spender customers', JSON.stringify(peopleCounts('791 big_spender customers')) === '[791]')
check('1,449 lost customers', JSON.stringify(peopleCounts('the 1,449 lost customers')) === '[1449]')
check('Hebrew לקוחות', JSON.stringify(peopleCounts('104 לקוחות')) === '[104]')
for (const t of ['2 new roasts this week', '2 weeks after the customers ordered', '40% of customers', '₪500 customers', '3 orders per customer', '330 g bag buyers']) {
  check(`not a head count: "${t}"`, peopleCounts(t).length === 0, JSON.stringify(peopleCounts(t)))
}

// ── Critic facts block ───────────────────────────────────────────────────────
{
  const b = audienceFactsBlock(facts, 'big_spender')
  check('critic block carries definition + numbers', b.includes('AUDIENCE FACTS') && b.includes(': 793') && b.includes(': 104') && b.includes(': 97') && b.includes('100%') && b.includes(bs.definition))
  check('critic block: unknown segment is critical', /audience_unknown/.test(audienceFactsBlock(facts, 'equipment_no_beans')))
  check('critic block: no opt-in data is high', /audience_unverified/.test(audienceFactsBlock(computeSegmentFacts(rows, null), 'big_spender')))
}

if (failures) { console.error(`\n${failures} failure(s)`); Deno.exit(1) }
console.log('\nall segment-facts tests passed')
