import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { InvalidTaskError, validateNewTask } from './taskValidation.ts'
import type { NewSeoTask } from './types.ts'

const off = { shotLibraryEnabled: false }
const t = (task_type: string, brief_data: unknown, extra: Record<string, unknown> = {}) =>
  ({ task_type, brief_data, ...extra }) as unknown as NewSeoTask

// ── visual_generation ──────────────────────────────────────────────────────

Deno.test('visual: the real 2026-10 failure (shot_type, no destination, no render_mode) is rejected with the hint', () => {
  const p = validateNewTask(t('visual_generation', { shot_type: 'finished_drink', scene_brief: 'a cup on a bar', aspect: 'story' }), off)
  assertEquals(p.length, 2)
  assertStringIncludes(p[0], 'destination:"ig_post"')
  assertStringIncludes(p[1], 'render_mode:"no_bag"')
})

Deno.test('visual: banner with a stray shot_type but otherwise valid is accepted (worker accepts it)', () => {
  assertEquals(validateNewTask(t('visual_generation', { shot_type: 'finished_drink', scene_brief: 'x', render_mode: 'no_bag' }), off), [])
})

Deno.test('visual: ig_post with a real shot_type goes to the shot library path, nothing else required', () => {
  assertEquals(validateNewTask(t('visual_generation', { destination: 'ig_post', shot_type: 'finished_drink' }), off), [])
})

Deno.test('visual: ig_post without shot_type is fully checked unless the shot library is on', () => {
  const brief = { destination: 'ig_post' }
  assert(validateNewTask(t('visual_generation', brief), off).length > 0)
  assertEquals(validateNewTask(t('visual_generation', brief), { shotLibraryEnabled: true }), [])
})

Deno.test('visual: carousel (slides[]) skips single-image checks', () => {
  assertEquals(validateNewTask(t('visual_generation', { slides: [{ scene_brief: 'a' }] }), off), [])
})

Deno.test('visual: bag_hero with product_name, and no_bag without, are accepted', () => {
  assertEquals(validateNewTask(t('visual_generation', { scene_brief: 'x', product_name: 'Ethiopia Guji' }), off), [])
  assertEquals(validateNewTask(t('visual_generation', { scene_brief: 'x', render_mode: 'no_bag' }), off), [])
})

Deno.test('visual: unknown render_mode and empty scene_brief are rejected', () => {
  const p = validateNewTask(t('visual_generation', { scene_brief: '  ', render_mode: 'hero' }), off)
  assertEquals(p.length, 2)
})

Deno.test('visual: a stringified brief is parsed like insertTasks does', () => {
  assertEquals(validateNewTask(t('visual_generation', JSON.stringify({ scene_brief: 'x', render_mode: 'no_bag' })), off), [])
  assertEquals(validateNewTask(t('visual_generation', 'not json'), off), ['brief_data must be an object'])
})

// ── text_generation ────────────────────────────────────────────────────────

Deno.test('text: keyword, title and key_points are required', () => {
  assertEquals(validateNewTask(t('text_generation', {}), off).length, 3)
  assertEquals(validateNewTask(t('text_generation', { keyword: 'k', title: 't', key_points: ['a'] }), off), [])
})

// ── instagram_post ─────────────────────────────────────────────────────────

Deno.test('instagram: parent, caption and supported media_type are required', () => {
  const p = validateNewTask(t('instagram_post', { media_type: 'reel' }), off)
  assertEquals(p.length, 3)
  assertEquals(validateNewTask(t('instagram_post', { caption_he: 'שלום' }, { parent_task_id: 'abc' }), off), [])
})

Deno.test('instagram: parentLinkedLater skips only the parent check', () => {
  assertEquals(validateNewTask(t('instagram_post', { caption_he: 'שלום' }), { ...off, parentLinkedLater: true }), [])
  assertEquals(validateNewTask(t('instagram_post', {}), { ...off, parentLinkedLater: true }).length, 1)
})

// ── everything else ────────────────────────────────────────────────────────

Deno.test('other task types are not checked here', () => {
  for (const tt of ['dynamic_experiment', 'deep_research', 'technical_seo', 'reel_render']) {
    assertEquals(validateNewTask(t(tt, null), off), [])
  }
})

Deno.test('InvalidTaskError names each bad task and its problems', () => {
  const e = new InvalidTaskError([{ index: 2, task_type: 'text_generation', problems: ['brief.keyword is required'] }])
  assertStringIncludes(e.message, '#2 text_generation: brief.keyword is required')
  assertEquals(e.name, 'InvalidTaskError')
})
