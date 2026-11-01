import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { freshnessBudgetHours } from './freshness_budget.ts'

const mflow = { max_age_hours: 12, saturday_max_age_hours: 36 }

Deno.test('Saturday morning in Israel gets the Shabbat budget', () => {
  assertEquals(freshnessBudgetHours(mflow, new Date('2026-10-31T08:00:00Z')), 36)
})

Deno.test('the rest of the week keeps the normal budget', () => {
  assertEquals(freshnessBudgetHours(mflow, new Date('2026-10-30T08:00:00Z')), 12)
  assertEquals(freshnessBudgetHours(mflow, new Date('2026-11-01T08:00:00Z')), 12)
})

Deno.test('Saturday follows Israel time, not UTC', () => {
  assertEquals(freshnessBudgetHours(mflow, new Date('2026-10-30T22:30:00Z')), 36)
  assertEquals(freshnessBudgetHours(mflow, new Date('2026-10-31T22:30:00Z')), 12)
})

Deno.test('a source with no Saturday budget is unaffected', () => {
  assertEquals(freshnessBudgetHours({ max_age_hours: 60 }, new Date('2026-10-31T08:00:00Z')), 60)
})
