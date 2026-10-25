/**
 * Pure helpers for the customer_orders pass of woo-orders-sync.
 *
 * customer_orders is the per-order contact + delivery ledger that customer
 * messaging (order status, review ask, reorder reminder, referral) reads.
 * It is kept apart from woo_orders on purpose:
 *   - it holds personal data (phone, first name), and woo_orders is readable
 *     by the dashboard; customer_orders is service-role only;
 *   - it keeps every status (cancelled, refunded…) so eligibility can exclude
 *     them, while woo_orders stays "paid orders only".
 *
 * No I/O here, so every rule is covered by customer_orders_test.ts.
 */

// ── Product category ─────────────────────────────────────────────────────────
// Classify a product name into a category Minuto cares about. Used to enrich
// order line items so the doctor can say "this campaign drives 80% machines,
// 20% coffee" — critical for the strategic goal of shifting from 45% machine
// revenue toward more coffee. Rules are pattern-based and tuned to the
// current catalog. Order matters: check most-specific patterns first.
export function categorizeProduct(name: string, sku: string): string {
  const n = (name ?? '').toLowerCase();
  const s = (sku ?? '').toLowerCase();
  const text = `${n} ${s}`;

  // Grinders first — "ECM" appears in both grinders and machines, so we need
  // to match the specific grinder models before the generic "machine" brands
  const grinderPatterns = [
    /mahlk[oö]nig/i, /mazzer/i, /eureka/i, /fiorenzato/i, /\bbaratza\b/i,
    /comandante/i, /1zpresso/i, /timemore/i, /\bwilfa\b/i,
    /מטחנ/, /\bgrinder\b/i,
  ];
  if (grinderPatterns.some(p => p.test(text))) return 'grinder';

  // Espresso machines (boutique Italian brands + generic "מכונה" Hebrew)
  const machinePatterns = [
    /la\s*marzocco/i, /\becm\b/i, /profitec/i, /\brocket\b/i, /\blelit\b/i,
    /gaggia/i, /rancilio/i, /nuova\s*simonelli/i, /slayer/i, /linea/i,
    /מכונת אספרסו/, /מכונת קפה/, /\bespresso\s*machine\b/i,
  ];
  if (machinePatterns.some(p => p.test(text))) return 'machine';

  // Coffee beans — the broadest class. Match origin names, blend/single-
  // origin terminology, and Hebrew terms for coffee beans.
  const coffeePatterns = [
    /\bbeans?\b/i, /\bblend\b/i, /\bsingle\s*origin\b/i, /\bespresso\b/i,
    /yirgacheffe|sidamo|guji|ethiopia|kenya|colombia|brazil|costa\s*rica|panama|guatemala/i,
    /פול(?!\w)/, /בלנד/, /ספשלטי/, /אתיופיה|קולומביה|ברזיל|קניה|גואטמלה/,
    /קפה טרי|פולי קפה/,
  ];
  if (coffeePatterns.some(p => p.test(text))) return 'coffee';

  // Accessories — brewing gear, cleaning, scales, etc.
  const accessoryPatterns = [
    /\bfilter\b/i, /\bcleaner\b/i, /\bscale\b/i, /\btamper\b/i, /\bportafilter\b/i,
    /\bkettle\b/i, /\bv60\b/i, /\bchemex\b/i, /\baeropress\b/i,
    /\bmoka\s*pot\b/i, /\bfrench\s*press\b/i,
    /פילטר|מאזניים|טמפר|דוכס|קומקום|מסננת/,
  ];
  if (accessoryPatterns.some(p => p.test(text))) return 'accessory';

  return 'other';
}

// Coffee BEANS only. categorizeProduct() also calls capsules ("…espresso…")
// and bean accessories ("…לפולי קפה") coffee, which is right for revenue
// reporting but wrong for "when will this bag run out".
export function isBeanLine(category: string, name: string): boolean {
  return category === 'coffee' &&
    !/קפסול|capsul|נספרסו|nespresso|\brdt\b|קערית|ספל|כוס|glass|\bcup\b|דריפ|dripper/i.test(name ?? '');
}

// MFlow (POS / B2B invoicing) pushes its documents into Woo through the REST
// API. They are not web checkouts and their buyers never see the web store's
// checkout, so they are not messaging customers. Two marker keys exist:
// _wc_order_attribution_source_type (older) and traking_type + order_source
// (what the MFlow ERP plugin writes today).
export function isMflowOrder(meta: { key: string; value: unknown }[] | undefined): boolean {
  for (const m of meta ?? []) {
    const v = String(m.value ?? '').toLowerCase();
    if ((m.key === '_wc_order_attribution_source_type' || m.key === 'traking_type') &&
        v.includes('advanced purchase tracking')) return true;
    if (m.key === 'order_source' && v === 'mflow') return true;
  }
  return false;
}

// ── Identity normalization ──────────────────────────────────────────────────

export interface NormalizedPhone {
  e164: string;
  is_mobile: boolean;   // Israeli 05x — the only numbers WhatsApp templates go to
}

/**
 * Normalize a billing phone to E.164, assuming Israel when there is no
 * country code. Returns null for anything that is not a plausible number.
 *
 * Seen in real orders: "05XXXXXXXX", "+9725XXXXXXXX", "5XXXXXXXX" (leading 0
 * dropped), "05X-XXXXXXX", "05X-XXX-XXXX", and numbers wrapped in Unicode
 * direction marks (U+2066/U+2069) by RTL browsers.
 */
export function normalizePhone(raw: string | null | undefined): NormalizedPhone | null {
  if (!raw) return null;
  // Drop direction marks and every separator; keep a leading + only.
  const cleaned = String(raw)
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .trim();
  const plus = cleaned.startsWith('+');
  let digits = cleaned.replace(/\D/g, '');
  if (!digits) return null;

  if (plus || digits.startsWith('00')) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    // Israeli number written with country code AND trunk 0: +972 05X…
    if (digits.startsWith('9720')) digits = '972' + digits.slice(4);
  } else if (digits.startsWith('972') && digits.length >= 11) {
    // "972…" without the plus
  } else if (digits.startsWith('0') && (digits.length === 10 || digits.length === 9)) {
    digits = '972' + digits.slice(1);           // 05X-XXXXXXX / 0X-XXXXXXX
  } else if (digits.length === 9 && digits.startsWith('5')) {
    digits = '972' + digits;                    // mobile with the 0 dropped
  } else if (digits.length === 8 && /^[2-489]/.test(digits)) {
    digits = '972' + digits;                    // landline with the 0 dropped
  } else {
    return null;
  }

  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith('972')) {
    const national = digits.slice(3);
    // 5X + 7 digits = mobile; 2/3/4/8/9 + 7 digits = landline; 7X + 7 = VoIP
    if (!/^(5\d{8}|[23489]\d{7}|7\d{8})$/.test(national)) return null;
    // Reject obvious placeholders like 0500000000 / 0541111111
    if (/^5\d(\d)\1{6}$/.test(national)) return null;
    return { e164: '+' + digits, is_mobile: /^5\d{8}$/.test(national) };
  }
  return { e164: '+' + digits, is_mobile: false };
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const e = String(raw ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

// ── Bag weight ──────────────────────────────────────────────────────────────

/**
 * Grams of coffee in ONE unit of a line item, or null when unknown.
 *
 * Source order: the variation attribute "כמות" (pa_כמות, e.g. "330 גר" or a
 * bundle total like "1320"), then the product name ("- 330-גר", "1 ק״ג").
 * Only called for lines categorizeProduct() calls coffee, so a storage
 * canister "for 1 ק״ג of coffee" is never counted.
 */
export function parseGrams(name: string, attrValues: string[]): number | null {
  for (const v of attrValues) {
    const g = gramsFromText(v, true);
    if (g) return g;
  }
  return gramsFromText(name, false);
}

/** Grams from a Woo product's own attributes (the "כמות" attribute), or null. */
export function gramsFromProductAttributes(attrs: { name?: string; options?: string[] }[] | undefined): number | null {
  const qty = (attrs ?? []).find(a => (a.name ?? '').trim() === 'כמות');
  if (!qty?.options || qty.options.length !== 1) return null; // several sizes: the line must say which
  return parseGrams('', qty.options);
}

function gramsFromText(text: string, bareNumberOk: boolean): number | null {
  const t = String(text ?? '').replace(/[״"׳']/g, '');
  const kg = t.match(/(\d+(?:[.,]\d+)?)\s*-?\s*(?:קג|קילו|kg)(?![a-z])/i);
  if (kg) return sane(Math.round(parseFloat(kg[1].replace(',', '.')) * 1000));
  const g = t.match(/(\d{2,4})\s*-?\s*(?:גרם|גר|g|gr)(?![a-z])/i);
  if (g) return sane(parseInt(g[1], 10));
  if (bareNumberOk) {
    const n = t.trim().match(/^(\d{2,4})$/);
    if (n) return sane(parseInt(n[1], 10));
  }
  return null;
}

function sane(g: number): number | null {
  return g >= 50 && g <= 10000 ? g : null;
}

// ── Row builder ─────────────────────────────────────────────────────────────

export interface WooOrderFull {
  id: number;
  status: string;
  created_via?: string;
  customer_id?: number;
  date_created_gmt?: string;
  date_paid_gmt?: string | null;
  date_completed_gmt?: string | null;
  date_modified_gmt?: string;
  billing?: { email?: string; phone?: string; first_name?: string };
  shipping_lines?: { method_id?: string; method_title?: string }[];
  line_items?: {
    product_id?: number; variation_id?: number; name: string; sku?: string; quantity: number;
    meta_data?: { key: string; value: unknown; display_value?: unknown }[];
  }[];
  meta_data?: { key: string; value: unknown }[];
}

const gmt = (s: string | null | undefined) => (s ? `${s.replace(/Z$/, '')}Z` : null);

function deliveryMethod(o: WooOrderFull): 'ship' | 'pickup' | 'none' {
  const cfw = o.meta_data?.find(m => m.key === '_cfw_delivery_method')?.value;
  if (cfw === 'pickup') return 'pickup';
  const ids = (o.shipping_lines ?? []).map(s => s.method_id ?? '');
  if (ids.some(id => id === 'pickup_location' || id === 'local_pickup')) return 'pickup';
  if (cfw === 'ship' || ids.length) return 'ship';
  return 'none';
}

// Cargo Shipping Location stores { "<shipment id>": {status, …} } under
// cslfw_shipping. Its status is frozen at label time, so only the id is kept.
function cargoShipmentId(o: WooOrderFull): string | null {
  const v = o.meta_data?.find(m => m.key === 'cslfw_shipping')?.value;
  if (v && typeof v === 'object') {
    const ids = Object.keys(v as Record<string, unknown>);
    if (ids.length) return ids[ids.length - 1];
  }
  return null;
}

/** Product ids of bean lines whose size is not on the line itself. */
export function productIdsNeedingGrams(o: WooOrderFull): number[] {
  return buildCustomerOrderRow(o).lines
    .filter(l => l.is_bean && l.grams_each === null && l.product_id)
    .map(l => l.product_id as number);
}

/**
 * @param productGrams grams per unit from the PRODUCT's own "כמות" attribute,
 *   keyed by product id. Simple products (e.g. Sweet Leona, "200 גר") keep
 *   their size there rather than on the order line.
 */
export function buildCustomerOrderRow(o: WooOrderFull, productGrams?: Map<number, number | null>) {
  const phone = normalizePhone(o.billing?.phone);
  const lines = (o.line_items ?? []).map(li => {
    const category = categorizeProduct(li.name, li.sku ?? '');
    const is_bean = isBeanLine(category, li.name);
    const attrs = (li.meta_data ?? [])
      .filter(m => m.key.startsWith('pa_'))
      .map(m => String(m.display_value ?? m.value ?? ''));
    const grams = is_bean
      ? parseGrams(li.name, attrs) ?? (li.product_id ? productGrams?.get(li.product_id) ?? null : null)
      : null;
    return {
      product_id: li.product_id ?? null,
      variation_id: li.variation_id || null,
      name: li.name,
      quantity: li.quantity,
      category,
      is_bean,
      grams_each: grams,
    };
  });
  const coffeeLines = lines.filter(l => l.is_bean);
  const coffeeGrams = coffeeLines.every(l => l.grams_each)
    ? coffeeLines.reduce((s, l) => s + (l.grams_each ?? 0) * l.quantity, 0)
    : null; // one unknown size makes the total unknown; reorder timing falls back
  return {
    woo_order_id:       o.id,
    status:             o.status,
    created_via:        o.created_via ?? null,
    date_created:       gmt(o.date_created_gmt),
    date_paid:          gmt(o.date_paid_gmt),
    date_completed:     gmt(o.date_completed_gmt),
    date_modified:      gmt(o.date_modified_gmt),
    woo_customer_id:    o.customer_id || null,
    email_norm:         normalizeEmail(o.billing?.email),
    phone_raw:          o.billing?.phone?.trim() || null,
    phone_e164:         phone?.e164 ?? null,
    phone_is_mobile:    phone?.is_mobile ?? false,
    first_name:         o.billing?.first_name?.trim() || null,
    delivery_method:    deliveryMethod(o),
    shipping_method_id: o.shipping_lines?.[0]?.method_id ?? null,
    cargo_shipment_id:  cargoShipmentId(o),
    has_beans:          coffeeLines.length > 0,
    bean_grams:         coffeeLines.length ? coffeeGrams : 0,
    lines,
    synced_at:          new Date().toISOString(),
  };
}

export const CUSTOMER_ORDER_FIELDS =
  'id,status,created_via,customer_id,date_created_gmt,date_paid_gmt,date_completed_gmt,' +
  'date_modified_gmt,billing,shipping_lines,line_items,meta_data';
