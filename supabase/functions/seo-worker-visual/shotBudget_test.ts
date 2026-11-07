import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { HTTP_HOP_MS, SHOT_DEADLINE_MS, shotBudget } from './shotBudget.ts'

function clock(start = 1_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

Deno.test('a generated render that took 91 s gets its second attempt on Pro', () => {
  // Task e86b966e attempt 1: render 78 s + QA 13 s. Under the old 135 s
  // deadline the retry was skipped; 91 s + 91 s fits in 220 s.
  const c = clock(); const b = shotBudget(SHOT_DEADLINE_MS, c.now)
  c.advance(91_000)
  assert(b.fits(91_000))
})

Deno.test('a third slow attempt does not start', () => {
  const c = clock(); const b = shotBudget(SHOT_DEADLINE_MS, c.now)
  c.advance(182_000)
  assert(!b.fits(91_000))
})

Deno.test('a call to visual-test never waits past the 150 s idle timeout', () => {
  const c = clock(); const b = shotBudget(SHOT_DEADLINE_MS, c.now)
  assertEquals(b.hopMs(), HTTP_HOP_MS)
  assert(HTTP_HOP_MS < 150_000)
  c.advance(100_000)
  assertEquals(b.hopMs(), SHOT_DEADLINE_MS - 100_000)
})

Deno.test('a published photo that took 43 s still gets its second attempt', () => {
  // Task 676d8ea4: render 40 s + QA 3 s; attempt 2 ended at 98 s in total.
  const c = clock(); const b = shotBudget(SHOT_DEADLINE_MS, c.now)
  c.advance(43_000)
  assert(b.fits(43_000))
})

Deno.test('remainingMs stays positive past the deadline', () => {
  const c = clock(); const b = shotBudget(SHOT_DEADLINE_MS, c.now)
  c.advance(SHOT_DEADLINE_MS + 5_000)
  assertEquals(b.remainingMs(), 1)   // AbortSignal.timeout rejects negatives
  assert(!b.fits(5_000))
})
