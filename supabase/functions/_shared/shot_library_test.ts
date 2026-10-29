import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import {
  ENABLED_SHOTS, REFERENCE_EXCLUDE, SHOTS, applyPlannedShot, isBagSceneOf, normalizeShotChoice, packshotFor, plannerShotInstructions,
  plannerShotMenu, referenceSubject, resolveMoment, shotChecklist, shotUsesRealPhoto, shotEditBrief, shotGeneratePrompt, shotRouterPrompt, shotSceneSummary,
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

// ── Planner picks (Phase 1b) ─────────────────────────────────────────────────

const CAPTION = 'בוקר של אספרסו: קרמה עבה, שוט קצר ומדויק. מה אתם שותים הבוקר?'

Deno.test('planner pick, flag on: shot_type + slots set, scene_brief filled, render_mode follows', () => {
  const { brief, picked, note } = applyPlannedShot({
    caption_he: CAPTION, shot_type: 'bar_moment', shot_slots: { moment: 'Pulling an espresso shot' },
    aspect: 'story', destination: 'ig_post',
  }, { enabled: true })
  assert(picked)
  assertEquals(note, undefined)
  assertEquals(brief.shot_type, 'bar_moment')
  assertEquals(brief.shot_slots, { moment: 'pulling an espresso shot' })
  assertEquals(brief.render_mode, 'no_bag')
  assertEquals(brief.planned_shot, undefined)
  assert(String(brief.scene_brief).includes('espresso'))
})

Deno.test('planner pick, flag off: kept as planned_shot so the worker stays on the legacy path', () => {
  const { brief } = applyPlannedShot({
    caption_he: CAPTION, shot_type: 'bag_hero', shot_slots: { product_name: 'Kenya AA+', moment: 'the bag in daylight' },
    scene_brief: 'The Kenya bag on the counter in morning light.', destination: 'ig_post',
  }, { enabled: false })
  assertEquals(brief.shot_type, undefined)
  assertEquals(brief.shot_slots, undefined)
  assertEquals(brief.planned_shot, { shot_type: 'bag_hero', shot_slots: { product_name: 'Kenya AA+', moment: 'the bag in daylight' } })
  assertEquals(brief.render_mode, 'bag_hero')
  assertEquals(brief.product_name, 'Kenya AA+')
  assertEquals(brief.scene_brief, 'The Kenya bag on the counter in morning light.')
})

Deno.test('planner pick: bad picks are repaired with a note', () => {
  const unknown = applyPlannedShot({ shot_type: 'leaf_with_dew' }, { enabled: true })
  assertEquals(unknown.brief.shot_type, 'finished_drink')
  assert(unknown.note?.includes('not on the menu'))
  const noProduct = applyPlannedShot({ shot_type: 'bag_with_drink' }, { enabled: true })
  assertEquals(noProduct.brief.shot_type, 'finished_drink')
  assert(noProduct.note?.includes('needs shot_slots.product_name'))
  const badMoment = applyPlannedShot({ shot_type: 'roastery', shot_slots: { moment: 'a roaster on the counter' } }, { enabled: true })
  assertEquals((badMoment.brief.shot_slots as { moment: string }).moment, 'the roaster at work')
  assert(badMoment.note?.includes('not one of roastery'))
})

Deno.test('planner pick: no shot_type leaves a legacy brief alone, caption is carried over', () => {
  const { brief, picked } = applyPlannedShot({ scene_brief: 'x', render_mode: 'no_bag' }, { enabled: true, caption: CAPTION })
  assert(!picked)
  assertEquals(brief, { scene_brief: 'x', render_mode: 'no_bag', caption_he: CAPTION })
  // A caption the brief already has wins.
  assertEquals(applyPlannedShot({ caption_he: 'own' }, { enabled: true, caption: CAPTION }).brief.caption_he, 'own')
})

Deno.test('scene summary never names a bag for a non-bag shot, and varies by moment', () => {
  for (const shot of ENABLED_SHOTS.filter(s => !s.needs_product)) {
    for (const moment of shot.moments) {
      const text = shotSceneSummary(shot, { moment, drink: 'latte' }).toLowerCase()
      assert(!/\bbag\b|pouch|packag/.test(text), `${shot.id}/${moment}: ${text}`)
    }
  }
  assert(shotSceneSummary(SHOTS.bar_moment, { moment: 'steaming milk' }) !== shotSceneSummary(SHOTS.bar_moment, { moment: 'pouring latte art' }))
})

Deno.test('planner instructions: caption first, the menu, and scene_brief per flag', () => {
  const on = plannerShotInstructions()
  assert(on.indexOf('caption_he') < on.indexOf('shot_type'))
  assert(on.includes(plannerShotMenu()))
  assert(on.includes('scene_brief is optional'))
  assert(plannerShotInstructions({ legacyScene: true }).includes('3-4 English sentences'))
})

Deno.test('roastery: generated around the real roaster, every moment short and positive, plain wall', () => {
  assertEquals(SHOTS.roastery.source, 'generated')
  for (const moment of SHOTS.roastery.moments) {
    const p = shotGeneratePrompt(SHOTS.roastery, { moment }, '9:16')
    assert(p.split(/\s+/).length <= 70, `${moment}: ${p.split(/\s+/).length} words`)
    assert(!/\b(no|never|don't|do not|forbidden|override)\b/i.test(p), p)
    assert(p.includes('plain, dark charcoal roastery wall'), p)
    assert(p.includes('reference photo'), p)
  }
  assert(shotChecklist(SHOTS.roastery, {}).some(q => q.includes('doors, signs')))
})

Deno.test('reference subject follows the roaster moment; excluded photos are listed', () => {
  assert(referenceSubject(SHOTS.roastery, { moment: 'fresh beans dropping into the cooling bin' }).includes('falling'))
  assert(referenceSubject(SHOTS.roastery, { moment: 'a close-up of the roaster' }).includes('close-up'))
  assert(referenceSubject(SHOTS.roastery, {}).includes('whole main drum roaster'))
  assert(REFERENCE_EXCLUDE.has('roaster/IMG_5172.jpg'))
})

Deno.test('roastery: falling beans use a real photo, the still moments are generated', () => {
  assert(shotUsesRealPhoto(SHOTS.roastery, { moment: 'fresh beans dropping into the cooling bin' }))
  assert(!shotUsesRealPhoto(SHOTS.roastery, { moment: 'the roaster at work' }))
  assert(!shotUsesRealPhoto(SHOTS.roastery, { moment: 'a close-up of the roaster' }))
  assert(shotUsesRealPhoto(SHOTS.bar_moment, {}))
  assert(!shotUsesRealPhoto(SHOTS.finished_drink, {}))
})
