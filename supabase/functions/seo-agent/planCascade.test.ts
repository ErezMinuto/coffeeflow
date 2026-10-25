// Run:  deno test supabase/functions/seo-agent/planCascade.test.ts

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { dropDependentsOfRefused } from './planCascade.ts'

type T = { task_type: string; name: string; parent_task_index?: number; depends_on_index?: number }

Deno.test('the 2026-08-26 shape: refused article drops its Veneto banner, keeps the rest', () => {
  const plan: T[] = [
    { task_type: 'dynamic_experiment', name: 'grinder article (refused)' },
    { task_type: 'visual_generation',  name: 'grinder banner', parent_task_index: 0 },
    { task_type: 'text_generation',    name: 'other article' },
    { task_type: 'visual_generation',  name: 'other banner', parent_task_index: 2 },
  ]
  const { kept, dropped } = dropDependentsOfRefused(plan, new Set([0]))
  assertEquals(kept.map(t => t.name), ['grinder article (refused)', 'other article', 'other banner'])
  assertEquals(kept[2].parent_task_index, 1)                // remapped from 2
  assertEquals(dropped.map(d => [d.task.name, d.originalIndex, d.refusedIndex]), [['grinder banner', 1, 0]])
})

Deno.test('drops transitively: article refused → banner → IG post', () => {
  const plan: T[] = [
    { task_type: 'dynamic_experiment', name: 'article' },
    { task_type: 'visual_generation',  name: 'banner', parent_task_index: 0 },
    { task_type: 'instagram_post',     name: 'post', parent_task_index: 1 },
  ]
  const { kept, dropped } = dropDependentsOfRefused(plan, new Set([0]))
  assertEquals(kept.map(t => t.name), ['article'])
  assertEquals(dropped.map(d => d.refusedIndex), [0, 0])
})

Deno.test('depends_on_index counts the same as parent_task_index', () => {
  const plan: T[] = [
    { task_type: 'dynamic_experiment', name: 'a' },
    { task_type: 'text_generation',    name: 'b', depends_on_index: 0 },
  ]
  assertEquals(dropDependentsOfRefused(plan, new Set([0])).kept.map(t => t.name), ['a'])
})

Deno.test('nothing refused: plan unchanged, indexes intact', () => {
  const plan: T[] = [
    { task_type: 'text_generation',   name: 'a' },
    { task_type: 'visual_generation', name: 'b', parent_task_index: 0 },
  ]
  const { kept, dropped } = dropDependentsOfRefused(plan, new Set())
  assertEquals(dropped.length, 0)
  assertEquals(kept, plan)
})

Deno.test('a cycle or an out-of-range index does not throw or drop', () => {
  const plan: T[] = [
    { task_type: 'text_generation', name: 'a', parent_task_index: 1 },
    { task_type: 'text_generation', name: 'b', parent_task_index: 0 },
    { task_type: 'text_generation', name: 'c', parent_task_index: 9 },
  ]
  const { kept, dropped } = dropDependentsOfRefused(plan, new Set())
  assertEquals(dropped.length, 0)
  assertEquals(kept[2].parent_task_index, undefined)
  assertEquals(kept[0].parent_task_index, 1)
})
