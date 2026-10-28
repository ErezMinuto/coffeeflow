import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import {
  ENABLED_SHOTS, SHOTS, isBagSceneOf, normalizeShotChoice, packshotFor, plannerShotMenu, resolveMoment,
  shotChecklist, shotEditBrief, shotGeneratePrompt, shotRouterPrompt,
} from './shot_library.ts'

// Real woo_products names (2026-10-28). Several house blends are Hebrew-only.
const CATALOG: Array<[string, string]> = [
  ["פולי קפה טרי ספשלטי קפה מינוטו פרסטיז' - Minuto Specialty Coffee", 'coffee_bags/PRESTIGE.png'],
  ['פולי קפה אתיופיה דיי בנסה חד זני בקלייה בהירה  - Minuto Daye Bensa Ethiopia Specialty Coffee', 'coffee_bags/Daye_BENSA.png'],
  ['פולי קפה אתיופיה יירגשף חד זני - Yirgacheffee Ethiopia Specialty Coffee  - Minuto', 'coffee_bags/yirgachffe.png'],
  ['ספשלטי קפה פולי קפה קניה AA+ חד זני |  +Minuto Specialty Coffee Mount Kenya AA', 'coffee_bags/Kenya_AA+.png'],
  ['פולי קפה טרי ספשלטי קפה מינוטו טריאסט  - Minuto Specialty Coffee', 'coffee_bags/TRIESTe.png'],
  ['פולי קפה ברזיל Fazenda Sertão חד זני - Minuto Specialty Coffee Fazenda Sertão yellow bourbon', 'coffee_bags/BRAZIL.png'],
  ['ספשלטי קפה פולי קפה Jungle Java - Minuto', 'coffee_bags/JUNGLE_JAVA.png'],
  ['פולי קפה טרי 100% ערביקה  - Minuto Dark Chocolate', 'coffee_bags/Dark_CHOCO.png'],
  ['פולי קפה טרי ספשלטי קפה מינוטו אינטנסו  - Minuto Specialty Coffee', 'coffee_bags/INTENSO.png'],
  ['פולי קפה ספשלטי קפה אנטיגואה חד זני - Minuto GUATEMALA ANTIGUA Specialty Coffee', 'coffee_bags/GUATEMALA_antigua.png'],
  ["פולי קפה ספשלטי קפה  גוג'י חד זני - Minuto Specialty Coffee Guji", 'coffee_bags/GUJI.png'],
  ['פולי קפה ספשלטי טרי 100% ערביקה קולומביה  - Minuto Velvet Star', 'coffee_bags/STAR_VELVET.png'],
  ['פולי קפה ספשלטי קפה מינוטו נטול קפאין - Minuto Decaffeinato', 'coffee_bags/DECAFF.png'],
  ['פולי קפה טרי ספשלטי קפה מינוטו אריסטו  - Minuto Specialty Coffee', 'coffee_bags/ARISTO.png'],
]

Deno.test('every catalog product maps to its own packshot', () => {
  for (const [name, file] of CATALOG) assertEquals(packshotFor(name), file, name)
})

Deno.test('unknown or missing product has no packshot', () => {
  assertEquals(packshotFor('Toddy cold brew system'), null)
  assertEquals(packshotFor(undefined), null)
})

Deno.test('planner menu lists exactly the enabled shots', () => {
  for (const s of Object.values(SHOTS)) assertEquals(plannerShotMenu().includes(`- ${s.id}:`), s.enabled, s.id)
})

Deno.test('bag scene photos are matched to their product by file name', () => {
  assert(isBagSceneOf('dark_chocolate_window.jpg', 'פולי קפה טרי 100% ערביקה  - Minuto Dark Chocolate'))
  assert(isBagSceneOf('guatemala_antigua_counter.jpg', 'Minuto GUATEMALA ANTIGUA Specialty Coffee'))
  assert(!isBagSceneOf('guji_window.jpg', 'Minuto Dark Chocolate'))
  assert(!isBagSceneOf('dark_chocolate_window.jpg', undefined))
})

Deno.test('router choice: unknown shot falls back, bag without product falls back', () => {
  assertEquals(normalizeShotChoice({ shot_type: 'leaf_on_table' }).shot.id, 'finished_drink')
  assertEquals(normalizeShotChoice({ shot_type: 'leaf_on_table' }, 'Dark Chocolate').shot.id, 'bag_hero')
  assertEquals(normalizeShotChoice({ shot_type: 'bag_hero' }).shot.id, 'finished_drink')
  assertEquals(normalizeShotChoice({ shot_type: 'bag_with_drink' }, 'Guji').shot.id, 'bag_with_drink')
  assertEquals(normalizeShotChoice({ shot_type: 'bag_with_drink' }).shot.id, 'finished_drink')
})

Deno.test('router choice keeps valid moments and fills defaults', () => {
  const a = normalizeShotChoice({ shot_type: 'bar_moment', moment: 'Steaming Milk' })
  assertEquals(a.slots.moment, 'steaming milk')
  const b = normalizeShotChoice({ shot_type: 'roastery', moment: 'a bean dropped into water' })
  assertEquals(b.slots.moment, SHOTS.roastery.moments[0])
  const c = normalizeShotChoice({ shot_type: 'finished_drink' })
  assertEquals(c.slots.drink, 'cappuccino')
  assertEquals(c.slots.product_name, undefined)
})

Deno.test('generated prompts are short, positive, single-scene', () => {
  for (const s of ENABLED_SHOTS.filter(s => s.source === 'generated')) {
    const p = shotGeneratePrompt(s, { drink: 'flat white' }, '9:16')
    const words = p.split(/\s+/).length
    assert(words <= 70, `${s.id}: ${words} words`)
    assert(!/\b(no|never|don't|do not|forbidden|override)\b/i.test(p), `${s.id} has negation: ${p}`)
  }
})

Deno.test('every enabled shot has an edit brief or prompt and a checklist', () => {
  for (const s of ENABLED_SHOTS) {
    const text = s.source === 'real_photo' ? shotEditBrief(s, {}) : shotGeneratePrompt(s, {}, '9:16')
    assert(text.length > 20, s.id)
    assert(shotChecklist(s, { product_name: 'Guji' }).length >= 4, s.id)
  }
})

Deno.test('router prompt carries the menu, caption and product', () => {
  const p = shotRouterPrompt('a single bean dropped into a glass of water', 'קפה טרי מהקלייה', 'Guji')
  assert(p.includes('bar_moment') && p.includes('קפה טרי מהקלייה') && p.includes('Guji'))
  assertEquals(resolveMoment(SHOTS.brew_ritual, 'an aeropress'), 'an AeroPress')
})
