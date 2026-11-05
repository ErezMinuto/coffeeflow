import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { addUtms, buildCampaignHtml, decodeDesign, shortProductName, stripSubjectMarkers } from "./email_template.ts";

const bag = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  woo_id: id, name, price: "69.0000", image_url: `https://www.minuto.co.il/content/uploads/${id}.png`,
  permalink: `https://www.minuto.co.il/product/${id}/`, ...extra,
});

const legacy = {
  subject: "דיי בנסה ☕ | פרסומת",
  preheader: "קפה בהיר",
  greeting: "היי,",
  body: "שורה <b>ראשונה</b> & \"שנייה\"\n\nפסקה **חשובה**",
  ctaText: "לחנות",
  ctaUrl: "https://minuto.co.il/shop",
  products: [],
  unsubscribeUrl: "{{UNSUBSCRIBE_URL}}",
};

Deno.test("old fields alone render a complete email (render-draft contract)", () => {
  const html = buildCampaignHtml(legacy);
  assertStringIncludes(html, "פסקה <strong>חשובה</strong>");
  assertStringIncludes(html, "שורה &lt;b&gt;ראשונה&lt;/b&gt; &amp; &quot;שנייה&quot;");
  assertStringIncludes(html, 'href="{{UNSUBSCRIBE_URL}}"');
  assertStringIncludes(html, "utm_campaign={{UTM_CAMPAIGN}}");
  assertStringIncludes(html, "מינוטו קפה בית קלייה ספיישלטי");
  assertStringIncludes(html, "להסרה מרשימת הדיוור");
});

Deno.test("headline drops the legal suffix and emoji; subject is not altered", () => {
  assertEquals(stripSubjectMarkers("דיי בנסה ☕ | פרסומת"), "דיי בנסה");
  const html = buildCampaignHtml(legacy);
  assert(!/<h1[^>]*>[^<]*פרסומת/.test(html));
});

Deno.test("hero product leaves the grid", () => {
  const html = buildCampaignHtml({
    ...legacy,
    heroProductId: 1,
    products: [bag(1, "פולי קפה אתיופיה דיי בנסה - Minuto"), bag(2, "פולי קפה ברזיל - Minuto")],
  });
  assertEquals(html.split("product_1__").length - 1, 0);
  assert(html.includes("utm_content=hero__"));
  assert(html.includes("utm_content=product_2__"));
});

Deno.test("special editions are labelled as a jar", () => {
  const html = buildCampaignHtml({ ...legacy, products: [bag(3, "פולי קפה Aji Bourbon - Roastery Brisas")] });
  assertStringIncludes(html, "בצנצנת");
});

Deno.test("only http(s) links reach an href", () => {
  const html = buildCampaignHtml({ ...legacy, ctaUrl: "javascript:alert(1)", products: [bag(4, "x", { permalink: "javascript:alert(2)" })] });
  assert(!html.includes("javascript:"));
});

Deno.test("UTMs only on minuto.co.il, never on look-alike hosts, fragment kept last", () => {
  assertEquals(addUtms("https://evilminuto.co.il.example.com/x", "a"), "https://evilminuto.co.il.example.com/x");
  const u = addUtms("https://www.minuto.co.il/shop#top", "cta");
  assert(u.endsWith("#top"));
  assertStringIncludes(u, "?utm_source=email");
});

Deno.test("section data survives a round trip through the stored HTML", () => {
  const html = buildCampaignHtml({
    ...legacy,
    kicker: "חד זני", headline: "כותרת", heroProductId: 1, notes: ["וניל"],
    facts: [{ label: "מקור", value: "אתיופיה" }], offer: { title: "ערכה", code: "ABC" },
    products: [bag(1, "דיי בנסה", { note: "לימון", display_name: "דיי בנסה" })],
  });
  const d = decodeDesign(html);
  assertEquals(d.kicker, "חד זני");
  assertEquals(d.notes, ["וניל"]);
  assertEquals(d.offer?.code, "ABC");
  assertEquals(d.productNotes?.["1"]?.note, "לימון");
  assertEquals(decodeDesign("<html>old draft</html>"), {});
  assertEquals(decodeDesign("<!--minuto-design:@@@-->"), {});
});

Deno.test("short names drop the SEO tail", () => {
  assertEquals(shortProductName("פולי קפה אתיופיה דיי בנסה חד זני בקלייה בהירה  - Minuto Daye Bensa Ethiopia"), "אתיופיה דיי בנסה");
});
