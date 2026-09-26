// Run:  deno test supabase/functions/seo-agent/services/sceneRepeat.test.ts

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  findRepeatedScene,
  renderRecentScenesBlock,
  sceneSimilarity,
  type RecentScene,
} from './sceneRepeat.ts'

const scene = (scene_brief: string, created_at = '2026-09-24T06:00:00Z', aspect = 'story'): RecentScene =>
  ({ id: crypto.randomUUID(), created_at, aspect, scene_brief })

const YESTERDAY = scene(
  'Close-up of a double espresso shot pouring from a bottomless portafilter into a small white ceramic cup, ' +
  'thick golden crema forming, soft natural daylight from a window, pale wood counter, shallow depth of field.',
)

// ── Same shot, reworded — must be caught ────────────────────────────────

Deno.test('a reworded copy of yesterday\'s espresso pull is a repeat', () => {
  const today =
    'Espresso shot pouring from a bottomless portafilter into a white ceramic cup, golden crema forming, ' +
    'close-up, warm daylight on a wooden counter.'
  const hit = findRepeatedScene(today, [YESTERDAY])
  assert(hit, 'expected a repeat')
  assertEquals(hit!.scene.id, YESTERDAY.id)
})

Deno.test('the same scene rendered as story and as feed is a repeat', () => {
  const feed = scene(YESTERDAY.scene_brief, '2026-09-24T06:05:00Z', 'feed_square')
  assert(findRepeatedScene(YESTERDAY.scene_brief, [feed]))
})

// ── Different shots on the same locked theme — must pass ────────────────

const DIFFERENT_ON_THEME = [
  'Overhead view of a finished latte-art rosetta in a wide matte black cup on a marble café table, a teaspoon beside it.',
  'Barista hand steaming milk in a stainless milk pitcher at the steam wand, microfoam swirling, side angle.',
  'A hand tamping ground coffee into a portafilter basket, the tamper mid-press, dramatic side light.',
  'Two cortados in small glasses on a tray by a sunny café window, morning street blurred behind.',
]

for (const s of DIFFERENT_ON_THEME) {
  Deno.test(`on-theme but different shot passes: ${s.slice(0, 40)}…`, () => {
    assertEquals(findRepeatedScene(s, [YESTERDAY]), null)
  })
}

Deno.test('the on-theme alternatives do not collide with each other either', () => {
  const recent = DIFFERENT_ON_THEME.map(s => scene(s))
  DIFFERENT_ON_THEME.forEach((s, i) => {
    const others = recent.filter((_, j) => j !== i)
    assertEquals(findRepeatedScene(s, others), null, s)
  })
})

// ── House style alone is not a repeat ────────────────────────────────────

Deno.test('shared Minuto house-style words do not make two scenes the same', () => {
  const style = ' Soft natural daylight, pale wood or stone surface, shallow depth of field, minimal premium props, generous negative space.'
  const a = 'Latte art heart in a white cup.' + style
  const b = 'Roasted beans spilling from a scoop.' + style
  assertEquals(sceneSimilarity(a, b), 0)
})

Deno.test('empty inputs never match', () => {
  assertEquals(findRepeatedScene('', [YESTERDAY]), null)
  assertEquals(findRepeatedScene(YESTERDAY.scene_brief, []), null)
})

Deno.test('the prompt block lists recent scenes and handles none', () => {
  assert(renderRecentScenesBlock([]).includes('none in the last'))
  const block = renderRecentScenesBlock([YESTERDAY])
  assert(block.includes('2026-09-24'))
  assert(block.includes('bottomless portafilter'))
})
