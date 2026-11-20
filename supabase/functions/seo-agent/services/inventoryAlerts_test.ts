// deno run --allow-read --allow-net supabase/functions/seo-agent/services/inventoryAlerts_test.ts
// Pinned to the 2026-11-08 incident: Fazenda Sertão had 326 packed bags, all of
// them (330) allocated to B2B customers, so the store had none to sell — yet the
// content agents saw it as "healthy".
import { computeInventoryAlerts } from './cmsApi.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const products = [
  { id: 92, name: 'Sertão',   packed_stock: 326, min_packed_stock: 10 },
  { id: 81, name: 'Prestige', packed_stock: 37,  min_packed_stock: 10 },
  { id: 50, name: 'Low',      packed_stock: 20,  min_packed_stock: 10 },
  { id: 60, name: 'Empty',    packed_stock: null, min_packed_stock: null },
]
const allocations = [
  { product_id: 92, bags: 200 }, { product_id: 92, bags: 100 }, { product_id: 92, bags: 30 },
  { product_id: 50, bags: 12 },
  { product_id: null, bags: 99 },   // ignored
]
const by = Object.fromEntries(computeInventoryAlerts(products, allocations).map(a => [a.name, a]))

check('Sertão: all bags allocated → critical', by['Sertão'].state === 'critical', JSON.stringify(by['Sertão']))
check('Sertão: store stock clamps at 0, not -4', by['Sertão'].store_stock === 0)
check('Sertão: physical count kept', by['Sertão'].packed_stock === 326 && by['Sertão'].allocated_bags === 330)
check('Prestige: no allocations → healthy', by['Prestige'].state === 'healthy' && by['Prestige'].store_stock === 37)
check('Low: 20 − 12 = 8 ≤ min 10 → low', by['Low'].state === 'low' && by['Low'].store_stock === 8)
check('Empty: null stock → critical', by['Empty'].state === 'critical' && by['Empty'].store_stock === 0)

if (failures) { console.error(`${failures} failure(s)`); Deno.exit(1) }
console.log('all passed')
