import { budgetFinding } from './budget.ts'

let failed = 0
function check(name: string, ok: boolean) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) failed++ }

check('quiet below 80%', budgetFinding(199.99, 250, 0.8) === null)
check('warns at 80%', budgetFinding(200, 250, 0.8)?.severity === 'WARN')
check('error at the cap', budgetFinding(250, 250, 0.8)?.severity === 'ERROR')
check('message names the share', (budgetFinding(210, 250, 0.8)?.message ?? '').includes('84%'))
check('bad input stays quiet', budgetFinding(NaN, 250, 0.8) === null && budgetFinding(10, 0, 0.8) === null)

if (failed) { console.log(`\n${failed} failed`); Deno.exit(1) }
console.log('\nall passed')
