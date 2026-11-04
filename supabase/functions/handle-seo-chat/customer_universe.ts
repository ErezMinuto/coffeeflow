// The customer universe for query_customers / create_email_segment.
//
// Same source and identity rules as rfm-sync: paid web orders in
// customer_orders (2023 onward), one customer per merged customer_id, emailed at
// their latest address. Until 2026-11-04 this read woo_orders, which starts in
// Jan 2026, so the chat agent said "680 customers in the entire database" while
// customer_rfm held 3,981, and it missed every pre-2026 machine or bean buyer.

export interface UniverseOrder {
  customer_id:  string
  email_norm:   string | null
  date_created: string
  woo_order_id: number
  lines:        Array<{ category?: string | null }> | null
}

export interface UniverseCustomer {
  customer_id: string
  email:       string
  orders:      number
  total:       number      // ₪, only where woo_orders knows the total (Jan 2026 onward)
  first:       string      // YYYY-MM-DD
  last:        string
  categories:  Set<string> // product categories bought, from customer_orders.lines
}

/** Pure: group paid orders by merged customer. Customers with no email at all
 *  cannot be emailed or matched to an RFM row and are left out, as rfm-sync does. */
export function aggregateUniverse(orders: UniverseOrder[], totals: Map<number, number>): UniverseCustomer[] {
  const by = new Map<string, UniverseCustomer & { latestAt: string }>()
  for (const o of orders) {
    const date = o.date_created.slice(0, 10)
    const total = totals.get(o.woo_order_id) ?? 0
    const cats = (o.lines ?? []).map(l => l?.category).filter((c): c is string => typeof c === 'string' && !!c)
    const email = (o.email_norm ?? '').trim().toLowerCase()
    const c = by.get(o.customer_id)
    if (!c) {
      by.set(o.customer_id, { customer_id: o.customer_id, email, latestAt: email ? o.date_created : '', orders: 1, total, first: date, last: date, categories: new Set(cats) })
      continue
    }
    c.orders++
    c.total += total
    if (date < c.first) c.first = date
    if (date > c.last) c.last = date
    for (const k of cats) c.categories.add(k)
    if (email && o.date_created > c.latestAt) { c.email = email; c.latestAt = o.date_created }
  }
  return [...by.values()].filter(c => c.email).map(({ latestAt: _l, ...c }) => c)
}
