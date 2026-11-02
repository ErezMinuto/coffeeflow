// deno run --allow-read supabase/functions/_shared/ad_budget_guard_test.ts
import { checkForwardBudget, daysLeftInMonth } from './ad_budget_guard.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const nov2 = new Date('2026-11-02T10:00:00Z')    // 29 days left in Nov (incl. today)
const nov30 = new Date('2026-11-30T10:00:00Z')   // last day
const base = { mtdSpend: 0, activeDaily: [], committedDrafts: [], newDaily: 50, newDurationDays: 14, monthlyCap: 3000, now: nov2 }

check('days left on Nov 2 = 29', daysLeftInMonth(nov2) === 29)
check('days left on Nov 30 = 1', daysLeftInMonth(nov30) === 1)
check('Israel time crosses midnight before UTC', daysLeftInMonth(new Date('2026-11-30T23:30:00Z')) === 31, String(daysLeftInMonth(new Date('2026-11-30T23:30:00Z'))))

check('empty account, ₪50/day draft passes', checkForwardBudget(base).ok)
check('run-rate cap: ₪101/day refused', !checkForwardBudget({ ...base, newDaily: 101 }).ok)
check('active ₪80 + new ₪30 > ₪100/day refused', !checkForwardBudget({ ...base, activeDaily: [80], newDaily: 30 }).ok)
check('queued draft counts toward run-rate', !checkForwardBudget({ ...base, committedDrafts: [{ daily: 60, durationDays: 14 }], newDaily: 50 }).ok)
{
  // Month check: ₪2,000 spent + ₪30/day × 29 = 870 → 2,870 + new 50×14 = 3,570 > 3,000
  const v = checkForwardBudget({ ...base, mtdSpend: 2000, activeDaily: [30] })
  check('month projection refuses', !v.ok && v.reasons.some(r => r.startsWith('month')), v.reasons.join(' | '))
}
{
  // Old loophole: last day of month, nothing spent. Run-rate still bites.
  const v = checkForwardBudget({ ...base, now: nov30, newDaily: 1000, newDurationDays: 30 })
  check('31st-of-month loophole closed by run-rate', !v.ok && v.reasons.some(r => r.startsWith('run-rate')))
}
check('new draft month cost capped at days left', checkForwardBudget({ ...base, now: nov30, mtdSpend: 2900, newDaily: 50, newDurationDays: 14 }).ok)
check('NaN input fails closed', !checkForwardBudget({ ...base, mtdSpend: NaN }).ok)
check('negative budget fails closed', !checkForwardBudget({ ...base, activeDaily: [-5] }).ok)
check('zero cap fails closed', !checkForwardBudget({ ...base, monthlyCap: 0 }).ok)
check('null active budget fails closed', !checkForwardBudget({ ...base, activeDaily: [null as unknown as number] }).ok)
check('empty-string spend fails closed', !checkForwardBudget({ ...base, mtdSpend: '' as unknown as number }).ok)
check('boolean / array budget fails closed', !checkForwardBudget({ ...base, newDaily: false as unknown as number }).ok && !checkForwardBudget({ ...base, newDaily: [] as unknown as number }).ok)
check('missing committed daily fails closed', !checkForwardBudget({ ...base, committedDrafts: [{ daily: undefined as unknown as number, durationDays: 14 }] }).ok)
check('numeric string accepted (Postgres numeric)', checkForwardBudget({ ...base, mtdSpend: '120.50' as unknown as number }).ok)
check('duration 0 fails closed', !checkForwardBudget({ ...base, newDurationDays: 0 }).ok)

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1) }
console.log('\nall passed')
