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

// soldByProduct: {product_id: bags sold in the store over LOOKBACK_DAYS}
// (store_bags_sold RPC: café + website, B2B excluded).
// Target = enough bags for COVER_DAYS of store sales, never below the product's
// own min_packed_stock. Returns only products that need packing.
export function packingList(products, reserved, soldByProduct) {
  return products
    .map(p => {
      const perDay = Math.max(0, soldByProduct[p.id] || 0) / LOOKBACK_DAYS;
      const target = Math.max(Math.ceil(perDay * COVER_DAYS), p.min_packed_stock ?? 0);
      const stock  = storeStock(p, reserved);
      return { product: p, stock, target, toPack: target - stock };
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
