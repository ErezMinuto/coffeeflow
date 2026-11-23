import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { bannerBrief, bannerPrompt, fallbackSceneBrief, parseBannerReply } from './blog_banner.ts'
import { validateNewTask } from '../seo-agent/taskValidation.ts'

const SRC = { title: 'איך להכין מאצ\'ה טקסית בבית', body: 'x'.repeat(5000), keyword: 'מאצ\'ה טקסית' }

Deno.test('prompt carries the article and caps the body', () => {
  const p = bannerPrompt(SRC)
  assert(p.includes(SRC.title))
  assert(p.includes(SRC.keyword))
  assert(p.length < 3200)
})

Deno.test('reply parsing accepts a real brief and rejects junk', () => {
  const good = 'A bamboo whisk rests beside a ceramic bowl of bright green matcha on a light oak table, morning light.'
  assertEquals(parseBannerReply({ scene_brief: `  ${good}  ` }), good)
  assertEquals(parseBannerReply({ scene_brief: 'short' }), null)
  assertEquals(parseBannerReply({ scene_brief: 42 }), null)
  assertEquals(parseBannerReply(null), null)
  assertEquals(parseBannerReply([]), null)
})

Deno.test('the queued banner passes the same validation insertTasks applies', () => {
  for (const scene of [fallbackSceneBrief(SRC), fallbackSceneBrief({ title: 't', body: '' })]) {
    const problems = validateNewTask({
      task_type: 'visual_generation', brief_data: bannerBrief(scene), rationale: '', orchestrator_run_id: 'r',
      parent_task_id: 'p',
    })
    assertEquals(problems, [])
  }
})

Deno.test('banner is a product-free blog banner', () => {
  const b = bannerBrief('scene')
  assertEquals(b.destination, 'blog_banner')
  assertEquals(b.render_mode, 'no_bag')
  assertEquals(b.aspect, 'feed_square')
  assertEquals(b.product_name, undefined)
})
