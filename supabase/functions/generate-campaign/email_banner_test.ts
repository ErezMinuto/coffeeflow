import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { balancedLines, judgeLabels, parseConcept, renderRules, type BannerCopy, type BannerProduct } from "./email_banner.ts";

const copy: BannerCopy = {
  subject: "4 שקיות פולי קפה במחיר 3", headline: "בוחרים ארבעה, משלמים על שלושה", kicker: "בלאק פריידיי במינוטו",
  offerTitle: "4 שקיות פולי קפה במחיר 3", offerText: "", preheader: "", body: "גוף",
};
const products: BannerProduct[] = [
  { woo_id: 1, short: "Aristo", description: "", image_url: "https://www.minuto.co.il/a.png", jar: false },
  { woo_id: 2, short: "Brisas", description: "", image_url: "https://www.minuto.co.il/b.png", jar: true },
];
const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
const good = {
  concepts: ["a", "b", "c"], choice: 0, idea: "idea", why: "why", text_side: "left", title: "kicker", support: "offer",
  type: { title_font: "Frank Ruhl Libre", title_weight: 500, support_font: "IBM Plex Sans Hebrew", support_weight: 300, color: "olive", accent: "gold_rule", align: "center", tracking: "normal" },
  bags: ["Aristo"], prompt: words(100), alt: "באנר",
};

Deno.test("a valid concept parses, with tracking mapped to a number", () => {
  const r = parseConcept(JSON.stringify(good), products, copy);
  assert(r.ok);
  if (r.ok) { assertEquals(r.value.type.tracking, 0.02); assertEquals(r.value.support, "offer"); }
});

Deno.test("concept refuses a jar as a bag, an unknown font, a weight the font lacks, and title == support", () => {
  const r = parseConcept(JSON.stringify({
    ...good, bags: ["Brisas"], support: "kicker",
    type: { ...good.type, title_font: "Comic Sans", support_weight: 900 },
  }), products, copy);
  assert(!r.ok);
  if (!r.ok) {
    const e = r.errors.join(" | ");
    assert(e.includes("Brisas")); assert(e.includes("title_font")); assert(e.includes("support_weight")); assert(e.includes("different"));
  }
});

Deno.test("overlay type is always centred", () => {
  const r = parseConcept(JSON.stringify({ ...good, text_side: "overlay", type: { ...good.type, align: "right" } }), products, copy);
  assert(r.ok);
  if (r.ok) assertEquals(r.value.type.align, "center");
});

Deno.test("running lines never end on a single word; display titles may", () => {
  const w = ["4", "שקיות", "פולי", "קפה", "במחיר", "3"];
  const width = (l: string) => l.length * 10;
  const running = balancedLines(w, 2, width, 1000, true)!;
  assert(running[1].split(" ").length >= 2);
  const title = balancedLines(["בלאק", "פריידיי", "במינוטו"], 2, width, 1000, false)!;
  assertEquals(title, ["בלאק פריידיי", "במינוטו"]);
});

Deno.test("label verdict: exact lockup, right count, names match", () => {
  const ok = JSON.stringify({ bags: [{ wordmark: "MINUTO", subline: "Café Roastery", name: "Aristo", matches_reference: true, sealed_upright: true }] });
  assert(judgeLabels(ok, 1).pass);
  const bad = JSON.stringify({ bags: [{ wordmark: "MINUTO", subline: "Café Reastery", name: "Aristo", matches_reference: true, sealed_upright: true }, { wordmark: "MINUT0", subline: "Cafe Roastery", name: "x", matches_reference: false, sealed_upright: true }] });
  const v = judgeLabels(bad, 1);
  assert(!v.pass);
  assert(v.issues.some((i) => i.includes("Reastery")));
  assert(v.issues.some((i) => i.includes("expected 1")));
  assert(!judgeLabels("not json", 1).pass);
});

Deno.test("render rules keep the type side empty, or simple under an overlay", () => {
  const side = renderRules({ ...(good as any), text_side: "right" }, ["Aristo"]);
  assert(side.includes("right 42%"));
  assert(side.includes("only bag"));
  const over = renderRules({ ...(good as any), text_side: "overlay" }, ["Aristo", "Guji"]);
  assert(over.includes("dark wash"));
  assert(over.includes("only bags"));
});
