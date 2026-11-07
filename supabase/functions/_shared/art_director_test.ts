import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import {
  ACTIONS, AD_BLOCKING_QUESTIONS, AD_SYSTEM, adRevisionMessage, adUserMessage, criticQuestions, isRealRejection, parseArtDirection,
  parseCritic, referenceCandidates, type ArtDirection,
} from './art_director.ts'
import { PHOTO_INDEX } from './photo_index.ts'
import { PHOTO_EXCLUDE } from './shot_library.ts'

const keys = new Set(referenceCandidates().map(p => p.key))
const someKey = [...keys][0]
const prompt = 'A candid lifestyle photograph at Minuto, '.repeat(20)

function reply(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    concepts: ['a', 'b', 'c'], choice: 1, why: 'fits', action: 'steaming_milk', new_action: false, new_action_note: '',
    references: [{ key: someKey, role: 'the exact design of the espresso machine' }], prompt, qa: ['Is the pitcher held?'], ...over,
  })
}

Deno.test('the action list is the 14 the owner approved, each with a realism note', () => {
  assertEquals(Object.keys(ACTIONS).length, 14)
  assert(ACTIONS.steaming_milk.includes('never parked on the drip tray'))
  for (const [k, note] of Object.entries(ACTIONS)) assert(note.length > 40, k)
})

Deno.test('references exclude bags, excluded photos and hard-flagged photos', () => {
  const c = referenceCandidates()
  assert(c.length > 20)
  for (const p of c) {
    assert(!p.key.startsWith('bag_scenes/') && !p.key.startsWith('coffee_bags/'), p.key)
    assert(!PHOTO_EXCLUDE.has(p.key), p.key)
    assert(!p.flags.some(f => ['order_ticket', 'readable_customer_text', 'sharp_face'].includes(f)), p.key)
  }
  // The owner-confirmed roasted-beans photos survive.
  assert(c.some(p => p.key === 'roaster/minuto-roaster-49.jpg'))
  assert(PHOTO_INDEX.length >= c.length)
})

Deno.test('a valid reply parses', () => {
  const r = parseArtDirection('Here you go:\n' + reply() + '\n', keys)
  assert(r.ok)
  if (r.ok) { assertEquals(r.value.choice, 1); assertEquals(r.value.references[0].key, someKey) }
})

Deno.test('bad replies are rejected with reasons the art director can fix', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ concepts: ['a'] }, 'exactly 3'],
    [{ action: 'juggling' }, 'not in the action list'],
    [{ references: [{ key: 'coffee_bags/GUJI.png', role: 'the bag' }] }, 'not a key'],
    [{ references: [] }, '1 or 2'],
    [{ prompt: 'too short' }, 'words'],
    [{ references: [{ key: someKey, role: 'x' }, { key: someKey, role: 'y' }] }, 'different photos'],
  ]
  for (const [over, needle] of cases) {
    const r = parseArtDirection(reply(over), keys)
    assert(!r.ok && r.errors.some(e => e.includes(needle)), `${needle}: ${JSON.stringify(r)}`)
  }
  assert(!parseArtDirection('not json at all', keys).ok)
})

Deno.test('a new action needs its own realism note and is accepted', () => {
  assert(!parseArtDirection(reply({ action: 'loading_green_coffee', new_action: true }), keys).ok)
  assert(parseArtDirection(reply({ action: 'weighing_a_dose', new_action: true, new_action_note: 'A dose sits on a scale.' }), keys).ok)
})

Deno.test('a negation in the prompt is a warning, not a failure', () => {
  const r = parseArtDirection(reply({ prompt: prompt + ' with no clutter' }), keys)
  assert(r.ok && r.warnings.length === 1)
})

Deno.test('only gross defects block; the realism note and the art director questions are notes', () => {
  const ad = JSON.parse(reply()) as ArtDirection
  const { blocking, notes } = criticQuestions(ad)
  assertEquals(blocking, AD_BLOCKING_QUESTIONS)
  assert(blocking.some(q => q.includes('face')) && blocking.some(q => q.includes('bags')))
  assert(notes.some(q => q.includes(ACTIONS.steaming_milk)))
  assert(notes.includes('Is the pitcher held?'))
})

Deno.test('the critic fails closed', () => {
  const qs = ['q1', 'q2']
  assert(parseCritic('{"answers":[{"n":1,"answer":"yes"},{"n":2,"answer":"yes"}]}', qs).passes)
  const one = parseCritic('{"answers":[{"n":1,"answer":"yes"}]}', qs)
  assert(!one.passes && one.failed[0].why === 'not answered')
  assert(!parseCritic('{"answers":[{"n":1,"answer":"yes"},{"n":2,"answer":"no","why":"pitcher on tray"}],"correction":"held up"}', qs).passes)
  assert(!parseCritic('garbage', qs).passes)
})

Deno.test('a failed note is recorded but does not fail the image', () => {
  const qs = ['block1', 'note1']
  const v = parseCritic('{"answers":[{"n":1,"answer":"yes"},{"n":2,"answer":"no","why":"cup flat"}]}', qs, 1)
  assert(v.passes)
  assertEquals(v.notes, [{ q: 'note1', why: 'cup flat' }])
  assert(!parseCritic('{"answers":[{"n":1,"answer":"no","why":"melted finger"},{"n":2,"answer":"yes"}]}', qs, 1).passes)
})

Deno.test('the brief carries the caption, the hint and no bag photos', () => {
  const m = adUserMessage({ caption: 'קפה טרי', aspect: 'story', recent: [{ date: '2026-11-06', caption: 'x' }], learnings: ['L1'], plannerHint: 'Bar moment' })
  assert(m.includes('קפה טרי') && m.includes('9:16') && m.includes('L1') && m.includes('Bar moment'))
  assert(!m.includes('coffee_bags/') && !m.includes('bag_scenes/'))
  assert(adRevisionMessage(JSON.parse(reply()), [{ q: 'held?', why: 'on tray' }], 'held at chest height').includes('held at chest height'))
  assert(AD_SYSTEM.includes('Strada X') && AD_SYSTEM.includes('JSON only'))
})

Deno.test('owner verdicts reach the art director; bulk queue clean-ups do not count', () => {
  assert(isRealRejection('not a logical image, no one throws a single coffee bean'))
  assert(!isRealRejection('cleared by Erez 2026-11-03 (fresh start)'))
  assert(!isRealRejection('') && !isRealRejection(null))
  const m = adUserMessage({
    caption: 'x', aspect: 'story', recent: [], learnings: [],
    verdicts: [
      { date: '2026-11-07', verdict: 'rejected', reason: 'filter with milk, image looks really bad', caption: 'פילטר', image: 'finished_drink (eye level)' },
      { date: '2026-11-05', verdict: 'published', caption: 'קלייה', image: 'roastery (the roaster at work)' },
    ],
  })
  assert(m.includes('REJECTED ("filter with milk, image looks really bad")') && m.includes('PUBLISHED: image: roastery'))
  assert(adUserMessage({ caption: 'x', aspect: 'story', recent: [], learnings: [] }).includes('OWNER VERDICTS ON RECENT IMAGES'))
})
