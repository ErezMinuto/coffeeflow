// Run:  deno test supabase/functions/_shared/bag_label_check.test.ts

import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { checkLabelText, normalizeLabelText } from './bag_label_check.ts'
import { BAG_LOCKUP_TEXT, BAG_REFERENCES, bagReferenceFor, storagePublicUrl } from './bag_references.ts'

const DAYE = [...BAG_LOCKUP_TEXT, 'Daye Bensa']
const label = (...lines: string[]) => ({ bag_visible: true, lines })

// ── Correct labels pass ─────────────────────────────────────────────────

Deno.test('the real Daye Bensa label passes', () => {
  assert(checkLabelText(label('MINUTO', 'Café Roastery', 'Daye Bensa'), DAYE).ok)
})

Deno.test('case, accents and punctuation do not matter', () => {
  assert(checkLabelText(label('Minuto', 'CAFE ROASTERY', 'daye-bensa'), DAYE).ok)
})

Deno.test('lockup and name on one line still pass', () => {
  assert(checkLabelText(label('MINUTO Café Roastery Daye Bensa'), DAYE).ok)
})

Deno.test('Hebrew descriptor lines next to the name are ignored', () => {
  assert(checkLabelText(label('MINUTO', 'Café Roastery', 'Daye Bensa', 'קלייה בהירה, פרחוני ועדין'), DAYE).ok)
})

// ── Misspellings seen in real renders fail ──────────────────────────────

for (const [drawn, expected] of [
  ['Daye 8ensa', 'Daye Bensa'],   // 2026-10-20 render D7A
  ['Daye Benso', 'Daye Bensa'],   // D8B
  ['Dore Benna', 'Daye Bensa'],   // D3B
  ['Gafé Roestery', 'Café Roastery'],
  ['MINUT0', 'MINUTO'],
] as const) {
  Deno.test(`"${drawn}" is flagged as a misspelling of "${expected}"`, () => {
    const r = checkLabelText(label(...DAYE.map(t => (t === expected ? drawn : t))), DAYE)
    assert(!r.ok)
    assertEquals(r.misspelled.map(m => m.expected), [expected])
  })
}

// ── Nothing to read is never a failure (no endless retries) ─────────────

Deno.test('a bag the model cannot see passes', () => {
  assert(checkLabelText({ bag_visible: false, lines: ['Daye 8ensa'] }, DAYE).ok)
})

Deno.test('a label too small to read (no lines) passes', () => {
  assert(checkLabelText(label(), DAYE).ok)
})

Deno.test('expected text that is simply absent passes', () => {
  assert(checkLabelText(label('MINUTO'), DAYE).ok)
})

Deno.test('unrelated text is not mistaken for a misspelling', () => {
  assert(checkLabelText(label('MINUTO', 'Café Roastery', 'Ethiopia', 'Specialty Coffee 330g'), DAYE).ok)
})

Deno.test('digits survive normalisation', () => {
  assertEquals(normalizeLabelText('Daye 8ensa!'), 'daye 8ensa')
  assertEquals(normalizeLabelText('Café  Roastery'), 'cafe roastery')
})

// ── Reference config ────────────────────────────────────────────────────

Deno.test('Daye Bensa (woo 78450) has a front photo, one extra view and its printed name', () => {
  const ref = bagReferenceFor(78450)!
  assert(ref.front.startsWith('bag-references/'))
  assertEquals(ref.views.length, 1)
  assertEquals(ref.label_text, ['Daye Bensa'])
})

Deno.test('Dark Chocolate and Velvet Star carry the names their labels print', () => {
  assertEquals(bagReferenceFor(64860)!.label_text, ['Dark Chocolate'])
  assertEquals(bagReferenceFor(64860)!.views.length, 2)
  assertEquals(bagReferenceFor(64855)!.label_text, ['Velvet Star'])
  assertEquals(bagReferenceFor(64855)!.views.length, 2)
})

Deno.test('Guatemala Antigua expects the corrected name, and the misprint "Aantigua" is flagged', () => {
  const exp = [...BAG_LOCKUP_TEXT, ...bagReferenceFor(65179)!.label_text]
  assertEquals(bagReferenceFor(65179)!.label_text, ['Guatemala Antigua'])
  assert(checkLabelText(label('MINUTO', 'Café Roastery', 'Guatemala Antigua'), exp).ok)
  assert(!checkLabelText(label('MINUTO', 'Café Roastery', 'Guatemala Aantigua'), exp).ok)
})

Deno.test('green coffee (65111) never gets a bag reference', () => {
  assertEquals(bagReferenceFor(65111), null)
})

Deno.test('a label truncated to the store title\'s "Dark Choco" is flagged', () => {
  // The real label prints "Dark Chocolate"; a render copying the shortened
  // store title is mislabelled.
  assert(!checkLabelText(label('MINUTO', 'Café Roastery', 'Dark Choco'), [...BAG_LOCKUP_TEXT, 'Dark Chocolate']).ok)
})

Deno.test('"Velvet Stor" is flagged', () => {
  assert(!checkLabelText(label('MINUTO', 'Café Roastery', 'Velvet Stor'), [...BAG_LOCKUP_TEXT, 'Velvet Star']).ok)
})

Deno.test('a bag with no entry keeps the store image', () => {
  assertEquals(bagReferenceFor(65180), null)
  assertEquals(bagReferenceFor(undefined), null)
})

Deno.test('every entry stays outside the purged prefixes and within two extra views', () => {
  for (const ref of Object.values(BAG_REFERENCES)) {
    for (const p of [ref.front, ...ref.views]) assert(p.startsWith('bag-references/'), p)
    assert(ref.views.length <= 2)
    assert(ref.label_text.length > 0)
  }
})

Deno.test('storage paths become public marketing-bucket URLs', () => {
  assertEquals(
    storagePublicUrl('https://x.supabase.co/', 'bag-references/daye-bensa/front.png'),
    'https://x.supabase.co/storage/v1/object/public/marketing/bag-references/daye-bensa/front.png',
  )
})
