import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { freshnessBudgetHours } from './freshness_budget.ts'

const mflow = { max_age_hours: 12, saturday_max_age_hours: 36, sunday_max_age_hours: 24 }

Deno.test('Saturday morning in Israel gets the Shabbat budget', () => {
  assertEquals(freshnessBudgetHours(mflow, new Date('2026-10-31T08:00:00Z')), 36)
})

Deno.test('the rest of the week keeps the normal budget', () => {
  assertEquals(freshnessBudgetHours(mflow, new Date('2026-10-30T08:00:00Z')), 12)
  assertEquals(freshnessBudgetHours(mflow, new Date('2026-11-02T08:00:00Z')), 12)
})

Deno.test('Sunday morning in Israel gets the after-Shabbat budget', () => {
  // 2026-11-08: last sale Sat 15:44 UTC, run at 08:00 UTC = 16.3h, sync healthy.
  assertEquals(freshnessBudgetHours(mflow, new Date('2026-11-08T08:00:00Z')), 24)
})

Deno.test('a source with only a Saturday budget keeps the normal one on Sunday', () => {
  assertEquals(freshnessBudgetHours({ max_age_hours: 12, saturday_max_age_hours: 36 }, new Date('2026-11-08T08:00:00Z')), 12)
})

Deno.test('Saturday follows Israel time, not UTC', () => {
  assertEquals(freshnessBudgetHours(mflow, new Date('2026-10-30T22:30:00Z')), 36)
  assertEquals(freshnessBudgetHours(mflow, new Date('2026-10-31T22:30:00Z')), 24)
  assertEquals(freshnessBudgetHours(mflow, new Date('2026-11-01T22:30:00Z')), 12)
})

Deno.test('a source with no Saturday budget is unaffected', () => {
  assertEquals(freshnessBudgetHours({ max_age_hours: 60 }, new Date('2026-10-31T08:00:00Z')), 60)
})
