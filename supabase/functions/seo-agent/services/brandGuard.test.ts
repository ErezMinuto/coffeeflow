// The brand guard is only worth anything if it separates the four real green
// coffee SKUs from the twelve green-COLOURED pieces of equipment, and the
// three Veneto bags from everything else. Every product name below is copied
// verbatim from live woo_products on 2026-09-23.
//
// Run:  deno test supabase/functions/seo-agent/services/brandGuard.test.ts

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  classifyByName,
  buildBrandIndex,
  screenProductList,
  screenHeroProduct,
  type BrandIndexEntry,
} from './brandGuard.ts'

// ── Real catalog rows ───────────────────────────────────────────────────

const GREEN_COFFEE = [
  '1 ק״ג קפה ירוק ספשלטי קפה אנטיגואה חד זני – GUATEMALA ANTIGUA Specialty Coffee',
  '250 גר קפה ירוק מינוטו - פרסטיז\'',
  '1 ק״ג קפה ירוק קניה AA+ חד זני – +Specialty Coffee Mount Kenya AA',
  '1 ק״ג קפה ירוק ברזיל Fazenda Sertão חד זני – Specialty Coffee Fazenda Sertão',
]

// Green-COLOURED gear. Featuring any of these is completely fine, and an
// earlier filter that matched a bare /ירוק/ would have stripped the lot.
const GREEN_COLOURED_GEAR = [
  'קומקום חשמלי Fellow Stagg EKG | Pour Over צבע ירוק עשן',
  'כוס טעימה אמבוסד 250 מ״ל מקולקציית ברוארס - BREWERS EMBOSSED - ירוק',
  'מקינטה מוקה צבע ירוק Bialetti Rainbow - מקינטה 3 כוסות',
  'מטחנת קפה FIORENZATO AllGround Sense מטחנה שוקלת - ירוק',
  'דייל האריס "CHAMPIONS SIGNATURE" כוס קפוצ׳ינו 200 מל צבע לבן ירוק',
  'סט 4 ספלי קפוצ\'ינו Club House מניקו ירוק + צלוחית - 205 מל',
  'ספל קפוצ\'ינו Club House Tulipano - ירוק מט (210 מ"ל)',
  'קופסת אחסון קפה AIRSCAPE כ- 500 גרם קפה צבע ירוק',
  'כוס קפוצ׳ינו וצלוחית 200 מ"ל Loveramics צבע ירוק יער',
  'צנצנת פולי קפה פולימרית בצבע ירוק למטחנת Comandante',
  'מכונת קפה גאגיה קלאסיק פרו -    Gaggia Classic Pro E24 צבע ירוק',
  'חליטת תה ירוק עם נענע אורגנית בשקיקי פירמידה מבית עדנים',
]

const VENETO = [
  '3  ק״ג פולי קפה Veneto Premium',
  '1 ק״ג פולי קפה Veneto Premium',
  '1 ק״ג פולי קפה Veneto Delux',
]

const TODDY = [
  '"Toddy® Cold Brew System "Commercial Model',
  'ערכת Toddy Essential – קולד ברו איכותי בסטנדרט מקצועי',
  '20 שקיות סינון למערכת השרייה קרה ביתית Toddy® Cold Brew System',
]

const MINUTO_ROASTS = [
  'פולי קפה טרי ספשלטי קפה מינוטו פרסטיז\' - Minuto Specialty Coffee',
  'פולי קפה טרי ספשלטי קפה מינוטו טריאסט - Minuto Specialty Coffee',
]

// ── Name-only classification ────────────────────────────────────────────

Deno.test('every real green-coffee SKU is caught by name alone', () => {
  for (const n of GREEN_COFFEE) assertEquals(classifyByName(n), 'banned_green', n)
})

Deno.test('green-COLOURED equipment is NOT mistaken for green coffee', () => {
  for (const n of GREEN_COLOURED_GEAR) {
    assertEquals(classifyByName(n), 'neutral', `should stay neutral: ${n}`)
  }
})

Deno.test('every Veneto bag is caught by name alone', () => {
  for (const n of VENETO) assertEquals(classifyByName(n), 'banned_reseller_coffee', n)
})

Deno.test('Toddy classifies as paired equipment, not as a ban', () => {
  for (const n of TODDY) assertEquals(classifyByName(n), 'paired_equipment', n)
})

// ── Category-aware index ────────────────────────────────────────────────

const CATALOG: BrandIndexEntry[] = [
  ...GREEN_COFFEE.map(name => ({ name, categories: ['פולי קפה ירוק', 'מוצרי קפה'] })),
  ...VENETO.map(name => ({ name, categories: ['המלצות מומחי הקפה שלנו', 'פולי קפה', 'פולי קפה ונטו Veneto'] })),
  ...TODDY.map(name => ({ name, categories: ['Toddy Cold brew', 'השרייה קרה - Cold Brew'] })),
  ...MINUTO_ROASTS.map(name => ({ name, categories: ['פולי קפה טרי - קפה ספשלטי specialty coffee'] })),
  ...GREEN_COLOURED_GEAR.map(name => ({ name, categories: ['אביזרים'] })),
]

Deno.test('index classifies every class correctly off categories', () => {
  const idx = buildBrandIndex(CATALOG)
  for (const n of GREEN_COFFEE)        assertEquals(idx.classify(n), 'banned_green', n)
  for (const n of VENETO)              assertEquals(idx.classify(n), 'banned_reseller_coffee', n)
  for (const n of TODDY)               assertEquals(idx.classify(n), 'paired_equipment', n)
  for (const n of MINUTO_ROASTS)       assertEquals(idx.classify(n), 'minuto_roast', n)
  for (const n of GREEN_COLOURED_GEAR) assertEquals(idx.classify(n), 'neutral', n)
})

Deno.test('a ban in the NAME overrides a Minuto-roast category', () => {
  // Defensive: if someone mis-files a Veneto bag under the Minuto roast
  // category in Woo, the ban still wins.
  const idx = buildBrandIndex([
    { name: '1 ק״ג פולי קפה Veneto Delux', categories: ['תערובות קפה מינוטו'] },
  ])
  assertEquals(idx.classify('1 ק״ג פולי קפה Veneto Delux'), 'banned_reseller_coffee')
})

Deno.test('unknown names fall back to the regex, not to "allowed"', () => {
  const idx = buildBrandIndex(CATALOG)
  assertEquals(idx.classify('2 ק״ג קפה ירוק אתיופיה חדש'), 'banned_green')
  assertEquals(idx.classify('Veneto Gran Crema 1kg'), 'banned_reseller_coffee')
})

// ── products_to_mention screening ───────────────────────────────────────

Deno.test('the 2026-09-20 green-coffee article brief would be scrubbed', () => {
  const idx = buildBrandIndex(CATALOG)
  // Verbatim products_to_mention from the task that actually shipped.
  const res = screenProductList(GREEN_COFFEE.slice(2, 4), idx)
  assertEquals(res.kept, [])
  assertEquals(res.dropped.length, 2)
  assert(res.dropped.every(d => d.verdict === 'banned_green'))
})

Deno.test('the 2026-09-22 Veneto brief keeps the Minuto roasts and drops Veneto', () => {
  const idx = buildBrandIndex(CATALOG)
  const res = screenProductList([...MINUTO_ROASTS, '1 ק״ג פולי קפה Veneto Delux'], idx)
  assertEquals(res.kept, MINUTO_ROASTS)
  assertEquals(res.dropped.length, 1)
  assertEquals(res.dropped[0].verdict, 'banned_reseller_coffee')
})

Deno.test('Toddy rides along with a Minuto roast', () => {
  const idx = buildBrandIndex(CATALOG)
  const res = screenProductList([TODDY[0], MINUTO_ROASTS[0]], idx)
  assertEquals(res.kept.length, 2)
  assertEquals(res.dropped.length, 0)
})

Deno.test('Toddy alone is dropped — no standalone reseller spotlight', () => {
  const idx = buildBrandIndex(CATALOG)
  const res = screenProductList([TODDY[0]], idx)
  assertEquals(res.kept, [])
  assertEquals(res.dropped[0].verdict, 'paired_equipment')
})

Deno.test('Veneto cannot satisfy the Toddy pairing requirement', () => {
  const idx = buildBrandIndex(CATALOG)
  const res = screenProductList([TODDY[0], '1 ק״ג פולי קפה Veneto Delux'], idx)
  assertEquals(res.kept, [])
  assertEquals(res.dropped.length, 2)
})

Deno.test('object-shaped entries are screened on their name', () => {
  const idx = buildBrandIndex(CATALOG)
  const res = screenProductList(
    [{ name: VENETO[2], url: 'https://example.com' }, { name: MINUTO_ROASTS[0], url: 'x' }],
    idx,
  )
  assertEquals(res.kept, [MINUTO_ROASTS[0]])
})

Deno.test('equipment passes through untouched — the guard is not a coffee-only filter', () => {
  const idx = buildBrandIndex(CATALOG)
  const gear = ['מכונת קפה מנוף מקצועית בזרה bezzera strega top', 'רובוט אספרסו קפהלט cafelat robot']
  assertEquals(screenProductList(gear, idx).kept, gear)
})

// ── bag_hero screening ──────────────────────────────────────────────────

Deno.test('all four Veneto renders would have been blocked at the hero slot', () => {
  const idx = buildBrandIndex(CATALOG)
  for (const n of VENETO) {
    const v = screenHeroProduct(n, idx)
    assertEquals(v.ok, false, n)
  }
})

Deno.test('the 2026-09-20 green-bag render would have been blocked', () => {
  const idx = buildBrandIndex(CATALOG)
  assertEquals(screenHeroProduct(GREEN_COFFEE[3], idx).ok, false)
})

Deno.test('Toddy is never a bag_hero — it is gear, not a bag', () => {
  const idx = buildBrandIndex(CATALOG)
  assertEquals(screenHeroProduct(TODDY[0], idx).ok, false)
})

Deno.test('a Minuto roast passes the hero slot', () => {
  const idx = buildBrandIndex(CATALOG)
  assertEquals(screenHeroProduct(MINUTO_ROASTS[0], idx).ok, true)
})

Deno.test('a missing product_name is left to the worker to validate', () => {
  const idx = buildBrandIndex(CATALOG)
  assertEquals(screenHeroProduct('', idx).ok, true)
  assertEquals(screenHeroProduct(undefined, idx).ok, true)
})
