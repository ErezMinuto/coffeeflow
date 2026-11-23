import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { pickProductByName } from './product_name_match.ts'

// Real woo_products names (2026-11-23), Minuto rows plus the look-alikes
// that a loose matcher could confuse them with.
const CATALOG = [
  'פולי קפה ספשלטי טרי 100% ערביקה קולומביה  - Minuto Velvet Star',
  'פולי קפה קולומביה אורגני Tolime Peakse | מהדורה מוגבלת - Minuto',
  'פולי קפה אתיופיה דיי בנסה חד זני  - Minuto Daye Bensa Ethiopia Specialty Coffee',
  'פולי קפה אתיופיה דיי בנסה חד זני בקלייה בהירה  - Minuto Daye Bensa Ethiopia Specialty Coffee',
  'פולי קפה טרי ספשלטי קפה מינוטו פרסטיז\' - Minuto Specialty Coffee',
  '250 גר קפה ירוק מינוטו - פרסטיז\'',
  'פולי קפה טרי ספשלטי קפה מינוטו אינטנסו  - Minuto Specialty Coffee',
  'פולי קפה טרי ספשלטי קפה מינוטו אריסטו  - Minuto Specialty Coffee',
  'פולי קפה טרי 100% ערביקה  - Minuto Dark Chocolate',
  'ספשלטי קפה פולי קפה Jungle Java - Minuto',
].map((name, i) => ({ woo_id: i + 1, name, image_url: `https://x/${i}.jpg` }))

const pick = (n: string) => pickProductByName(n, CATALOG)?.name ?? null

Deno.test('word order does not matter (the 2026-11-15 failure)', () => {
  assertEquals(pick('Minuto Velvet Star - קולומביה'), CATALOG[0].name)
})

Deno.test('extra invented words still resolve when the core matches (2026-10-28)', () => {
  assertEquals(pick('פולי קפה טחון – Minuto Velvet Star – קולומביה La Esmeralda'), CATALOG[0].name)
})

Deno.test('a shared origin word alone is not enough', () => {
  assertEquals(pick('Minuto קולומביה'), null)
})

Deno.test('base product beats its light-roast variant', () => {
  assertEquals(pick('Minuto Daye Bensa Ethiopia'), CATALOG[2].name)
})

Deno.test('roasted Prestige beats the green-coffee sack of the same name', () => {
  assertEquals(pick('מינוטו פרסטיז\''), CATALOG[4].name)
})

Deno.test('single distinctive word resolves when unique', () => {
  assertEquals(pick('Minuto אינטנסו'), CATALOG[6].name)
  assertEquals(pick('Dark Chocolate'), CATALOG[8].name)
})

Deno.test('generic-only names and unknown products return null', () => {
  assertEquals(pick('פולי קפה Minuto'), null)
  assertEquals(pick('Minuto Sumatra Mandheling'), null)
  assertEquals(pick(''), null)
})

Deno.test('an exact tie returns null rather than guessing', () => {
  const rows = [
    { woo_id: 1, name: 'Minuto Guji 250g', image_url: 'a' },
    { woo_id: 2, name: 'Minuto Guji 1kg', image_url: 'b' },
  ]
  assertEquals(pickProductByName('Minuto Guji', rows), null)
})
