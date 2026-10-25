// deno test supabase/functions/woo-orders-sync/customer_orders_test.ts
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildCustomerOrderRow, checkoutConsent, gramsFromProductAttributes, isBeanLine, isMflowOrder,
  normalizeEmail, normalizePhone, parseGrams, productIdsNeedingGrams,
} from "./customer_orders.ts";

Deno.test("normalizePhone: formats seen in real orders", () => {
  const mob = { e164: "+972541234567", is_mobile: true };
  assertEquals(normalizePhone("0541234567"), mob);
  assertEquals(normalizePhone("054-1234567"), mob);
  assertEquals(normalizePhone("054-123-4567"), mob);
  assertEquals(normalizePhone("+972541234567"), mob);
  assertEquals(normalizePhone("+972 0541234567"), mob);
  assertEquals(normalizePhone("972541234567"), mob);
  assertEquals(normalizePhone("00972541234567"), mob);
  assertEquals(normalizePhone("541234567"), mob);           // leading 0 dropped
  assertEquals(normalizePhone("⁦0541234567⁩"), mob); // RTL direction marks
});

Deno.test("normalizePhone: landlines are valid but not mobile", () => {
  assertEquals(normalizePhone("08-9461234"), { e164: "+97289461234", is_mobile: false });
  assertEquals(normalizePhone("03-6123456"), { e164: "+97236123456", is_mobile: false });
});

Deno.test("normalizePhone: foreign numbers keep their country code", () => {
  assertEquals(normalizePhone("+1 212 555 0100"), { e164: "+12125550100", is_mobile: false });
});

Deno.test("normalizePhone: junk and placeholders are rejected", () => {
  assertEquals(normalizePhone(""), null);
  assertEquals(normalizePhone(null), null);
  assertEquals(normalizePhone("abc"), null);
  assertEquals(normalizePhone("12345"), null);
  assertEquals(normalizePhone("0500000000"), null);
  assertEquals(normalizePhone("0541111111"), null);
  assertEquals(normalizePhone("+972 12345678"), null);     // no such Israeli prefix
});

Deno.test("normalizeEmail", () => {
  assertEquals(normalizeEmail("  Dana@Example.CO.IL "), "dana@example.co.il");
  assertEquals(normalizeEmail("not-an-email"), null);
  assertEquals(normalizeEmail(undefined), null);
});

Deno.test("parseGrams: attribute first, then name", () => {
  assertEquals(parseGrams("whatever", ["330 גר"]), 330);
  assertEquals(parseGrams("whatever", ["1320"]), 1320);           // bundle of 4×330
  assertEquals(parseGrams("פולי קפה - Minuto - 330-גר, לא לטחון", []), 330);
  assertEquals(parseGrams("1 ק״ג פולי קפה Veneto Delux", []), 1000);
  assertEquals(parseGrams("3  ק״ג פולי קפה Veneto Premium", []), 3000);
  assertEquals(parseGrams("פולי קפה 250 גרם", []), 250);
  assertEquals(parseGrams("ערכת התנסות פולי קפה טרי ספשלטי", []), null); // kit: unknown
  assertEquals(parseGrams("Sweet Leona | Colombia Luz Helena", ["לא לטחון"]), null);
});

const base = {
  id: 101, status: "completed", created_via: "checkout", customer_id: 0,
  date_created_gmt: "2026-10-01T08:00:00", date_paid_gmt: "2026-10-01T08:01:00",
  date_completed_gmt: "2026-10-02T06:00:00", date_modified_gmt: "2026-10-02T06:00:00",
  billing: { email: "A@B.com", phone: "054-1234567", first_name: " דנה " },
};

Deno.test("buildCustomerOrderRow: courier order with Cargo label", () => {
  const r = buildCustomerOrderRow({
    ...base,
    shipping_lines: [{ method_id: "free_shipping" }],
    meta_data: [
      { key: "_cfw_delivery_method", value: "ship" },
      { key: "cslfw_shipping", value: { "69800265": { status: { number: 1, text: "Open" } } } },
    ],
    line_items: [
      { name: "פולי קפה טרי ספשלטי - 330-גר", quantity: 2, meta_data: [{ key: "pa_כמות", value: "330-גר", display_value: "330 גר" }] },
      { name: "קופסת אחסון קפה AIRSCAPE כ- 1 ק״ג קפה", quantity: 1 },
    ],
  });
  assertEquals(r.delivery_method, "ship");
  assertEquals(r.cargo_shipment_id, "69800265");
  assertEquals(r.phone_e164, "+972541234567");
  assertEquals(r.phone_is_mobile, true);
  assertEquals(r.email_norm, "a@b.com");
  assertEquals(r.first_name, "דנה");
  assertEquals(r.woo_customer_id, null);            // guest checkout
  assertEquals(r.date_completed, "2026-10-02T06:00:00Z");
  assertEquals(r.has_beans, true);
  assertEquals(r.bean_grams, 660);                // the canister is not coffee
});

Deno.test("buildCustomerOrderRow: café pickup", () => {
  const r = buildCustomerOrderRow({
    ...base,
    shipping_lines: [{ method_id: "pickup_location" }],
    meta_data: [{ key: "_cfw_delivery_method", value: "pickup" }],
    line_items: [],
  });
  assertEquals(r.delivery_method, "pickup");
  assertEquals(r.cargo_shipment_id, null);
  assertEquals(r.has_beans, false);
  assertEquals(r.bean_grams, 0);
});

Deno.test("buildCustomerOrderRow: one unknown bag size makes the total unknown", () => {
  const r = buildCustomerOrderRow({
    ...base,
    line_items: [
      { name: "פולי קפה - 330-גר", quantity: 1 },
      { name: "ערכת התנסות פולי קפה טרי ספשלטי", quantity: 1 },
    ],
  });
  assertEquals(r.delivery_method, "none");
  assertEquals(r.bean_grams, null);
});

Deno.test("isBeanLine: capsules and bean accessories are not beans", () => {
  assertEquals(isBeanLine("coffee", "פולי קפה טרי ספשלטי - 330-גר"), true);
  assertEquals(isBeanLine("coffee", "קפסולות לאווצה תואמות נספרסו - Espresso Maestro Lungo"), false);
  assertEquals(isBeanLine("coffee", "ערכת קערית שקילה והרטבה (RDT) לפולי קפה"), false);
  assertEquals(isBeanLine("grinder", "מטחנת קפה"), false);
  assertEquals(isBeanLine("coffee", "ספל קפה אספרסו נוט-ניוטרל notNeutral Vero Espresso Glass"), false);
  assertEquals(isBeanLine("coffee", "HARIO דריפ נירוסטה רשת כפולה 02"), false);
});

Deno.test("isMflowOrder: needs rest-api AND order_source=mflow", () => {
  const src = { key: "order_source", value: "mflow" };
  const apt = { key: "traking_type", value: "Advanced Purchase Tracking (APT)" };
  assertEquals(isMflowOrder({ created_via: "rest-api", meta_data: [src, apt] }), true);
  assertEquals(isMflowOrder({ created_via: "rest-api", meta_data: [src] }), true);
  // PixelYourSite writes APT on real renewals and card checkouts
  assertEquals(isMflowOrder({ created_via: "subscription", meta_data: [apt] }), false);
  assertEquals(isMflowOrder({ created_via: "checkout", meta_data: [apt, { key: "_wc_order_attribution_source_type", value: "Advanced Purchase Tracking (APT)" }] }), false);
  // a real checkout that also carries order_source=mflow
  assertEquals(isMflowOrder({ created_via: "checkout", meta_data: [src] }), false);
  assertEquals(isMflowOrder({}), false);
});

Deno.test("gramsFromProductAttributes: single size only", () => {
  assertEquals(gramsFromProductAttributes([{ name: "רמת קלייה", options: ["בהירה"] }, { name: "כמות", options: ["200 גר"] }]), 200);
  assertEquals(gramsFromProductAttributes([{ name: "כמות", options: ["180"] }]), 180);
  assertEquals(gramsFromProductAttributes([{ name: "כמות", options: ["330 גר", "1 ק״ג"] }]), null);
  assertEquals(gramsFromProductAttributes(undefined), null);
});

Deno.test("buildCustomerOrderRow: product-level size fills a simple product", () => {
  const o = { ...base, line_items: [{ product_id: 80501, name: "פולי קפה בקלייה בהירה Sweet Leona", quantity: 2 }] };
  assertEquals(productIdsNeedingGrams(o), [80501]);
  assertEquals(buildCustomerOrderRow(o).bean_grams, null);
  assertEquals(buildCustomerOrderRow(o, new Map([[80501, 200]])).bean_grams, 400);
});

Deno.test("buildCustomerOrderRow: capsules don't count as beans", () => {
  const r = buildCustomerOrderRow({ ...base, line_items: [{ name: "קפסולות קימבו נאפולי לנספרסו - Nespresso espresso", quantity: 3 }] });
  assertEquals(r.has_beans, false);
  assertEquals(r.bean_grams, 0);
});

Deno.test("checkoutConsent: ticked, unticked, absent", () => {
  assertEquals(checkoutConsent([{ key: "_minuto_marketing_consent", value: "yes" }, { key: "_minuto_consent_version", value: "2026-10-a" }, { key: "_minuto_consent_at", value: "2026-10-26T08:00:00+00:00" }]),
    { marketing_consent: true, consent_text_version: "2026-10-a", consent_at: "2026-10-26T08:00:00+00:00" });
  assertEquals(checkoutConsent([{ key: "_minuto_marketing_consent", value: "no" }]).marketing_consent, false);
  assertEquals(checkoutConsent([]).marketing_consent, null);
  assertEquals(checkoutConsent([{ key: "_minuto_marketing_consent", value: "maybe" }]).marketing_consent, null);
  assertEquals(buildCustomerOrderRow({ ...base, meta_data: [{ key: "_minuto_marketing_consent", value: "yes" }] }).marketing_consent, true);
});
