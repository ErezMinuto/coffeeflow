// Tests for the chat agent's customer universe (query_customers).
//
//   deno run supabase/functions/handle-seo-chat/customer_universe_test.ts

import { aggregateUniverse, type UniverseOrder } from './customer_universe.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const orders: UniverseOrder[] = [
  // A 2024 machine buyer (before woo_orders starts) who came back for beans in 2026 at a new address.
  { customer_id: 'c1', email_norm: 'old@x.com', date_created: '2024-03-01T10:00:00Z', woo_order_id: 100, lines: [{ category: 'machine' }] },
  { customer_id: 'c1', email_norm: 'NEW@x.com ', date_created: '2026-02-01T10:00:00Z', woo_order_id: 900, lines: [{ category: 'coffee' }] },
  // A machine buyer with no bean order, 2023.
  { customer_id: 'c2', email_norm: 'm@x.com', date_created: '2023-06-01T10:00:00Z', woo_order_id: 50, lines: [{ category: 'machine' }, { category: null }] },
  // No email anywhere: cannot be emailed or matched to customer_rfm.
  { customer_id: 'c3', email_norm: null, date_created: '2025-01-01T10:00:00Z', woo_order_id: 60, lines: null },
]
const totals = new Map([[900, 120]])   // only the 2026 order has a ₪ total
const u = aggregateUniverse(orders, totals)
const c1 = u.find(c => c.customer_id === 'c1')!
const c2 = u.find(c => c.customer_id === 'c2')!

check('one row per merged customer, no-email customer left out', u.length === 2)
check('pre-2026 customers are in the universe', !!c2 && c2.first === '2023-06-01')
check('latest email wins, normalised', c1.email === 'new@x.com')
check('orders + dates span the full history', c1.orders === 2 && c1.first === '2024-03-01' && c1.last === '2026-02-01')
check('categories are the union of every order', c1.categories.has('machine') && c1.categories.has('coffee'))
check('₪ only where woo_orders has the total', c1.total === 120 && c2.total === 0)
check('machine-but-never-coffee finds c2 only', u.filter(c => c.categories.has('machine') && !c.categories.has('coffee')).map(c => c.customer_id).join() === 'c2')

if (failures) { console.error(`\n${failures} failure(s)`); Deno.exit(1) }
console.log('\nall customer-universe tests passed')
