// Replays the actual story scene_briefs that shipped AFTER the admin asked
// for espresso and latte art only (recorded 2026-09-17). Five of the eight
// broke the instruction. Every scene string below is verbatim from the
// seo_tasks rows.
//
// Run:  deno test supabase/functions/seo-agent/services/storyThemeLock.test.ts

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  DEFAULT_STORY_THEME_LOCK,
  screenStoryScene,
  renderStoryLockPolicy,
  type StoryThemeLock,
} from './storyThemeLock.ts'

const LOCK = DEFAULT_STORY_THEME_LOCK

// ── The stories that should never have shipped ──────────────────────────

const VIOLATIONS: Array<[string, string]> = [
  ['2026-09-17 French press',
   'A close-up, moody shot of a French press on a rustic wooden table, steam rising gently from the dark coffee inside'],
  ['2026-09-18 siphon',
   'A dramatic siphon (vacuum pot) coffee brewer on a wooden café counter, flame glowing beneath the lower globe'],
  ['2026-09-20 cezve',
   'A small copper cezve (ibrik) sitting on a low gas flame, fine foam just beginning to rise at the rim, steam curling'],
  ['2026-09-22 cupping bowls',
   'Top-down flat-lay of a professional coffee cupping session: several small white ceramic cupping bowls filled with coffee'],
  ['2026-09-23 French press',
   'A close-up, moody café scene of a glass French press filled with rich dark coffee, steam gently rising, resting on oak'],
]

Deno.test('every story that broke the instruction is rejected', () => {
  for (const [label, scene] of VIOLATIONS) {
    const v = screenStoryScene(scene, LOCK)
    assertEquals(v.ok, false, `${label} should have been rejected`)
    assert(v.why && v.why.length > 0, `${label} needs a reason the planner can act on`)
  }
})

// ── The stories that were fine ──────────────────────────────────────────

const ALLOWED: Array<[string, string]> = [
  ['2026-09-23 espresso pull',
   'A close-up vertical shot of a professional espresso machine pulling a perfect, thick shot of espresso with rich golden crema'],
  ['2026-09-23 latte art',
   "A close-up vertical shot of a barista's hands expertly pouring steamed milk into a ceramic cup, forming a delicate rosetta"],
  ['2026-09-21 milk pour',
   "Extreme close-up of a barista's steady hands pouring steamed milk into a small white ceramic espresso cup"],
  ['2026-09-19 espresso shot',
   'Close-up of a rich, golden-brown espresso shot being pulled into a small white ceramic cup, crema swirling on top'],
]

Deno.test('espresso and latte art stories pass', () => {
  for (const [label, scene] of ALLOWED) {
    assertEquals(screenStoryScene(scene, LOCK).ok, true, `${label} should pass`)
  }
})

// ── False-positive guards ───────────────────────────────────────────────

Deno.test('"dripping" espresso is not mistaken for drip coffee', () => {
  assertEquals(
    screenStoryScene('Espresso dripping slowly from a naked portafilter into a warm ceramic cup', LOCK).ok,
    true,
  )
})

Deno.test('a clever composition is not mistaken for a Clever dripper', () => {
  assertEquals(
    screenStoryScene('A clever composition: an espresso cup framed by morning light, crema catching the sun', LOCK).ok,
    true,
  )
})

Deno.test('a denied method wins even when espresso is also in frame', () => {
  const v = screenStoryScene(
    'An espresso cup with rich crema sitting beside a glass French press on a wooden counter', LOCK,
  )
  assertEquals(v.ok, false)
  assert(v.why!.includes('french press'))
})

Deno.test('an unrelated scene with no allowed subject is rejected', () => {
  assertEquals(screenStoryScene('A quiet café interior at dawn, empty tables, warm light', LOCK).ok, false)
})

Deno.test('an empty scene is rejected rather than silently allowed', () => {
  assertEquals(screenStoryScene('', LOCK).ok, false)
  assertEquals(screenStoryScene(undefined, LOCK).ok, false)
})

// ── Expiry ──────────────────────────────────────────────────────────────

Deno.test('the lock is dated so it lapses on its own', () => {
  // The whole point: the 2026-09-17 learning had no expiry, was still live a
  // week later, and sat next to a 2026-07-23 rule demanding the opposite.
  assertEquals(DEFAULT_STORY_THEME_LOCK.until, '2026-10-07')
  assert(DEFAULT_STORY_THEME_LOCK.until > '2026-09-23', 'lock must outlast the day it was set')
})

Deno.test('a custom lock drives the policy text it renders', () => {
  const custom: StoryThemeLock = {
    themes: ['cold brew'], allow: ['cold brew'], deny: ['espresso'],
    until: '2026-12-31', reason: 'summer push',
  }
  const text = renderStoryLockPolicy(custom)
  assert(text.includes('cold brew'))
  assert(text.includes('2026-12-31'))
  assert(text.includes('summer push'))
  // Feed posts must always be called out as unaffected — the lock is
  // story-only and the earlier learning's over-broad wording is what caused
  // the confusion in the first place.
  assert(text.includes('DAILY STORY ONLY'))
})
