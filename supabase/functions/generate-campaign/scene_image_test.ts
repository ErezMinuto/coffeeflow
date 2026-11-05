import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { checkPrompt, isTrustedImageUrl, parseCheck, sceneRules } from "./scene_image.ts";
import { resolveCoffee } from "./resolve_products.ts";

const SB = "https://ytydgldyeygpzmlxvpvb.supabase.co";

Deno.test("only our shop and our Storage are fetched as references", () => {
  assert(isTrustedImageUrl("https://www.minuto.co.il/content/uploads/2025/03/ARISTO.png", SB));
  assert(isTrustedImageUrl("https://minuto.co.il/a.png", SB));
  assert(isTrustedImageUrl(`${SB}/storage/v1/object/public/marketing/x.jpg`, SB));
  assert(!isTrustedImageUrl("http://www.minuto.co.il/a.png", SB));
  assert(!isTrustedImageUrl("https://minuto.co.il.evil.com/a.png", SB));
  assert(!isTrustedImageUrl("https://169.254.169.254/latest", SB));
  assert(!isTrustedImageUrl("not a url", SB));
});

Deno.test("the label check fails closed", () => {
  assertEquals(parseCheck('{"pass": true, "issues": []}'), { pass: true, issues: [] });
  assertEquals(parseCheck('{"pass": false, "issues": ["Café Soastery"]}').pass, false);
  assertEquals(parseCheck('{"pass": true, "issues": ["typo"]}').pass, false);   // pass with issues = fail
  assertEquals(parseCheck('{"pass": "true"}').pass, false);
  assertEquals(parseCheck("looks fine to me").pass, false);
  assertEquals(parseCheck("").pass, false);
});

Deno.test("prompts name the count and the brand rules", () => {
  assert(sceneRules(4).includes("all 4 bags"));
  assert(sceneRules(1).includes("all 1 bag "));
  assert(sceneRules(4).includes("SEALED"));
  assert(checkPrompt(["Aristo", "Dark Chocolate"]).includes("exactly the 2 reference bags"));
  assert(checkPrompt(["Aristo"]).includes("Café Roastery"));
});

const COFFEE = [
  { woo_id: 1, name: "פולי קפה טרי ספשלטי קפה מינוטו אריסטו - Minuto Aristo" },
  { woo_id: 2, name: "פולי קפה אתיופיה דיי בנסה חד זני - Minuto Daye Bensa" },
  { woo_id: 3, name: "פולי קפה אתיופיה דיי בנסה חד זני בקלייה בהירה - Minuto Daye Bensa light" },
];

Deno.test("product names resolve exactly or by one unique match", () => {
  const r = resolveCoffee(["aristo", "Minuto Daye Bensa light"], COFFEE);
  assert(r.ok);
  if (r.ok) assertEquals(r.products.map((p) => p.woo_id), [1, 3]);
  const exact = resolveCoffee([COFFEE[1].name], COFFEE);
  assert(exact.ok && exact.products[0].woo_id === 2);
});

Deno.test("ambiguous or unknown names are refused with the choices", () => {
  const amb = resolveCoffee(["Daye Bensa"], COFFEE);
  assert(!amb.ok && amb.error.includes("more than one"));
  const unk = resolveCoffee(["Veneto"], COFFEE);
  assert(!unk.ok && unk.error.includes("not an in-stock Minuto coffee") && unk.error.includes("Aristo"));
});

Deno.test("duplicates collapse", () => {
  const r = resolveCoffee(["Aristo", "aristo"], COFFEE);
  assert(r.ok && r.products.length === 1);
});
