// Packed bags that already belong to a B2B customer.
//
// An open row in bag_allocations (status 'allocated') sets packed bags aside for
// a customer. Those bags are still inside products.packed_stock — MFlow only
// takes them out once the customer is invoiced — but the store cannot sell them.
// Every "do we need to pack?" signal must look at store stock (packed −
// allocated), otherwise a shelf full of a café's bags hides an empty retail shelf.
//
// Marking the allocation 'delivered' releases it; the MFlow invoice then
// decrements packed_stock as usual, so nothing is deducted twice.

export function reservedBagsByProduct(allocations) {
  const reserved = {};
  for (const a of allocations || []) {
    if (a.status !== 'allocated' || !a.product_id) continue;
    reserved[a.product_id] = (reserved[a.product_id] || 0) + (a.bags || 0);
  }
  return reserved;
}

// Bags the store can actually sell. Never negative: bags allocated before the
// packing was logged should not drive stock below zero on screen.
export function storeStock(product, reserved) {
  return Math.max(0, (product.packed_stock ?? 0) - (reserved[product.id] || 0));
}

// ── 7-day store packing list ────────────────────────────────────────────────
export const COVER_DAYS    = 7;
export const LOOKBACK_DAYS = 28;

// storeSold / b2bSold: {product_id: bags sold over LOOKBACK_DAYS}
// (store_bags_sold = café + website; b2b_bags_sold = MFlow back_office).
//
// target    — COVER_DAYS of store sales, never below min_packed_stock.
// b2bTarget — COVER_DAYS of average B2B sales. B2B has no weekly pattern, so
//             this is a rough forecast; bags already allocated count toward it,
//             and a big allocation above the forecast is covered in full.
// toPack    = target + max(b2bTarget, allocated) − packed_stock. packed_stock
//             includes allocated bags, so store surplus can cover expected B2B.
export function packingList(products, reserved, storeSold, b2bSold = {}) {
  const forDays = (sold, id) => Math.ceil(Math.max(0, sold[id] || 0) / LOOKBACK_DAYS * COVER_DAYS);
  return products
    .map(p => {
      const target    = Math.max(forDays(storeSold, p.id), p.min_packed_stock ?? 0);
      const b2bTarget = forDays(b2bSold, p.id);
      const allocated = reserved[p.id] || 0;
      const stock     = storeStock(p, reserved);
      const toPack    = target + Math.max(b2bTarget, allocated) - (p.packed_stock ?? 0);
      return { product: p, stock, target, b2bTarget, allocated, toPack };
    })
    .filter(r => r.toPack > 0)
    .sort((a, b) => b.toPack - a.toPack);
}

// Israeli local numbers (05X…) → international digits for wa.me.
export function whatsappDigits(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0'))  d = '972' + d.slice(1);
  return d;
}
