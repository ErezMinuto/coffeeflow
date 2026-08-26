// Em-dashes are one of Minuto's named AI tells and are forbidden in Hebrew copy.
//
// This rule lived in the strategist prompt FOUR times, including in the JSON
// example, and was ignored on all 8 of the last 8 shipped captions. A prompt
// rule is a request; this is the enforcement. These tests exist because the
// failure is invisible — a caption with an em-dash publishes perfectly happily.
//
// Run:  deno test supabase/functions/organic-worker-instagram/stripAiDashes.test.ts

import { assertEquals, assert } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { stripAiDashes } from './index.ts'

Deno.test('em dash as a clause break becomes a comma', () => {
  assertEquals(stripAiDashes('קפה אנאירובי — הטרנד שמשגע'), 'קפה אנאירובי, הטרנד שמשגע')
  assertEquals(stripAiDashes('זה לא כימיה מלאכותית — זה מה שקורה'), 'זה לא כימיה מלאכותית, זה מה שקורה')
})

Deno.test('en dash and horizontal bar are caught too', () => {
  assert(!/[–―]/.test(stripAiDashes('טעם – עשיר')))
  assert(!/[–―]/.test(stripAiDashes('טעם ― עשיר')))
})

// The whole risk of a mechanical replace: eating hyphens that carry meaning.
// Hebrew coffee vocabulary is full of them (חד-זני), as are origin names and
// every URL in a caption.
Deno.test('word-internal hyphens are untouched', () => {
  assertEquals(stripAiDashes('פולי קפה חד-זני מאתיופיה'), 'פולי קפה חד-זני מאתיופיה')
  assertEquals(stripAiDashes('Ethiopia-Guji natural process'), 'Ethiopia-Guji natural process')
  assertEquals(stripAiDashes('מחיר 30-40 שקל'), 'מחיר 30-40 שקל')
})

Deno.test('URLs survive intact — their hyphens are load-bearing', () => {
  const u = 'ראו: https://minuto.co.il/product/x-y-z?a=1&b=2'
  assertEquals(stripAiDashes(u), u)
})

Deno.test('a dash opening a line is a bullet, not a clause break', () => {
  assertEquals(stripAiDashes('— טעם ראשון\n— טעם שני'), 'טעם ראשון\nטעם שני')
})

Deno.test('spaced ASCII hyphen is the same tell', () => {
  assertEquals(stripAiDashes('טעם עשיר - וסיומת ארוכה'), 'טעם עשיר, וסיומת ארוכה')
})

Deno.test('no doubled or dangling punctuation is produced', () => {
  assertEquals(stripAiDashes('טעם — ! סימן'), 'טעם! סימן')
  assertEquals(stripAiDashes('טעם, — עשיר'), 'טעם, עשיר')
  assertEquals(stripAiDashes('שורה —\nשורה שנייה'), 'שורה\nשורה שנייה')
})

Deno.test('clean copy is returned unchanged', () => {
  const clean = 'בוקר טוב. כוס קפה טובה, אור ראשון, ואין צורך במילים.'
  assertEquals(stripAiDashes(clean), clean)
})
