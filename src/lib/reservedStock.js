// Packed bags that already belong to a customer.
//
// A pending order in status 'ready' means its bags are packed and sitting on the
// shelf waiting for the customer (usually B2B). Those bags are still inside
// products.packed_stock — MFlow only takes them out once the order is invoiced —
// but the store cannot sell them. Every "do we need to pack?" signal must look at
// store stock (packed − reserved), otherwise a shelf full of a café's order hides
// an empty retail shelf.
//
// Marking the order 'fulfilled' releases the reservation; the MFlow invoice then
// decrements packed_stock as usual, so nothing is deducted twice.

export const RESERVING_STATUS = 'ready';

export function reservedBagsByProduct(pendingOrders) {
  const reserved = {};
  for (const o of pendingOrders || []) {
    if (o.status !== RESERVING_STATUS || !o.product_id) continue;
    reserved[o.product_id] = (reserved[o.product_id] || 0) + (o.quantity_bags || 0);
  }
  return reserved;
}

// Bags the store can actually sell. Never negative: an order marked ready before
// its bags were logged as packed should not drive stock below zero on screen.
export function storeStock(product, reserved) {
  return Math.max(0, (product.packed_stock ?? 0) - (reserved[product.id] || 0));
}
