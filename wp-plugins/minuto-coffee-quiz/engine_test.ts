// deno test --no-config wp-plugins/minuto-coffee-quiz/engine_test.ts
import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import "./assets/engine.js";
// deno-lint-ignore no-explicit-any
const { recommend, ROBUSTA, FRUITY } = (globalThis as any).MinutoQuizEngine;

const ALL = ["aristo", "dark", "sertao", "jungle", "velvet", "antigua", "bensa_m", "bensa_l", "kenya_m", "kenya_l", "guji", "aji", "leona", "yirgacheffe", "intenso", "trieste", "prestige", "decaf"];
const stock = { all: ALL, light: ["kenya_l", "guji", "aji", "leona", "bensa_l"] };
const base = { brew: "filter", brand: "simple", milk: "none", taste: "unknown", strength: "balanced", light: false, natural: false, noSour: false, decaf: false };
// deno-lint-ignore no-explicit-any
const r = (over: any, s: any = stock) => recommend({ ...base, ...over }, s);
const noRobusta = (l: string[]) => !l.some((k) => ROBUSTA.includes(k));

Deno.test("simple automatics get the robusta blends", () => {
  assert(r({ brew: "auto", brand: "simple" }).some((k: string) => ROBUSTA.includes(k)));
  assertEquals(r({ brew: "auto", brand: "simple", strength: "strong" }), ROBUSTA);
});

Deno.test("Jura / Melitta / Nivona ladder", () => {
  const p = { brew: "auto", brand: "premium" };
  assertEquals(r(p).slice(0, 2), ["aristo", "sertao"]);
  assertEquals(r({ ...p, strength: "strong" })[0], "dark");
  assert(noRobusta(r({ ...p, strength: "strong" })));
  assertEquals(r({ ...p, strength: "very_strong" }), ROBUSTA);
});

Deno.test("built-in grinder: Aristo + Dark Chocolate, robusta only if very strong", () => {
  assertEquals(r({ brew: "combo" }).slice(0, 2), ["aristo", "dark"]);
  assertEquals(r({ brew: "combo", strength: "very_strong" }), ROBUSTA);
});

Deno.test("manual espresso: Sertão, Jungle, Aristo; no robusta by default", () => {
  assertEquals(r({ brew: "manual", milk: "cow" }).includes("sertao"), true);
  assertEquals(r({ brew: "manual" }).slice(0, 2), ["sertao", "jungle"]);
  assert(noRobusta(r({ brew: "manual" })));
});

Deno.test("moka: strong Sertão, balanced Jungle + Antigua, no robusta by default", () => {
  assertEquals(r({ brew: "moka", strength: "strong" }), ["sertao"]);
  assertEquals(r({ brew: "moka" }), ["jungle", "antigua"]);
  assert(noRobusta(r({ brew: "moka", strength: "strong" })));
});

Deno.test("filter: strong Jungle + Velvet; dark, Aristo, robusta only if very strong", () => {
  assertEquals(r({ strength: "strong" }), ["jungle", "velvet"]);
  for (const taste of ["chocolate", "fruity", "floral", "unknown"]) {
    const l = r({ taste });
    assert(noRobusta(l) && !l.includes("dark") && !l.includes("aristo"), taste);
  }
  assert(r({ strength: "very_strong" }).includes("dark"));
});

Deno.test("cow's milk: two from the milk rule, one from the machine rule", () => {
  assertEquals(r({ brew: "auto", brand: "premium", milk: "cow" }), ["bensa_m", "jungle", "aristo"]);
  assertEquals(r({ brew: "auto", brand: "premium", milk: "cow", strength: "very_strong" }), ROBUSTA);
});

Deno.test("filter with cow's milk can still get a light roast", () => {
  assertEquals(r({ milk: "cow", taste: "fruity" }), ["bensa_m", "jungle", "kenya_l"]);
});

Deno.test("no sourness at all: Jungle + Velvet, for every method and taste", () => {
  for (const brew of ["auto", "combo", "manual", "moka", "filter", "press"]) {
    for (const taste of ["chocolate", "fruity", "floral", "unknown"]) {
      assertEquals(r({ brew, taste, noSour: true }), ["jungle", "velvet"]);
    }
  }
  assertEquals(r({ noSour: true, strength: "very_strong" }), ["aristo", "dark"]);
});

Deno.test("cow's milk list is Daye Bensa + Jungle, not Velvet", () => {
  assert(!r({ brew: "moka", milk: "cow" }).includes("velvet"));
});

Deno.test("alternative milk: never fruity, unless light is asked for", () => {
  for (const brew of ["auto", "combo", "manual", "moka", "filter", "press"]) {
    for (const taste of ["chocolate", "fruity", "floral", "unknown"]) {
      assert(!r({ brew, taste, milk: "alt" }).some((k: string) => FRUITY.includes(k)), `${brew}/${taste}`);
    }
  }
  assertEquals(r({ milk: "alt" }), ["sertao", "jungle", "velvet"]);
  assertEquals(r({ milk: "alt", strength: "very_strong" }), ["aristo", "dark"]);
  assertEquals(r({ milk: "alt", light: true })[0], "kenya_l");
});

Deno.test("natural process shows only natural coffees, Guji first", () => {
  assertEquals(r({ natural: true }), ["guji", "sertao", "dark"]);
  assertEquals(r({ natural: true, milk: "alt" }), ["sertao", "dark"]);
});

Deno.test("washed and honey coffees are never in the natural result", () => {
  for (const k of ["kenya_l", "kenya_m", "aji", "leona", "bensa_l", "bensa_m", "yirgacheffe"]) {
    assert(!r({ natural: true }).includes(k), k);
  }
});

Deno.test("light roast: Kenya first; new light coffees join", () => {
  assertEquals(r({ light: true })[0], "kenya_l");
  const s = { all: ["kenya_l", "new_light"], light: ["kenya_l", "new_light"] };
  assertEquals(r({ light: true }, s), ["kenya_l", "new_light"]);
});

Deno.test("black espresso: the machine's two leads, plus one by taste", () => {
  const j = { brew: "auto", brand: "premium" };
  assertEquals(r({ ...j, taste: "fruity" }), ["aristo", "sertao", "kenya_m"]);
  assertEquals(r({ ...j, taste: "chocolate" }), ["aristo", "sertao", "jungle"]);
  assertEquals(r({ ...j, taste: "floral" }), ["aristo", "sertao", "velvet"]);
  assertEquals(r({ ...j, taste: "unknown" }), ["aristo", "sertao", "bensa_m"]);
  assertEquals(r({ brew: "manual", taste: "chocolate" }), ["sertao", "jungle", "aristo"]);   // no duplicate
  assertEquals(r({ ...j, strength: "strong" })[0], "dark");                                  // strength ladder untouched
});

Deno.test("Kenya regular: espresso with milk, filter, French press", () => {
  assert(r({ brew: "combo", milk: "cow", taste: "fruity" }).includes("kenya_m"));
  assert(r({ brew: "filter", taste: "fruity" }).includes("kenya_m"));
  assert(r({ brew: "press", taste: "unknown" }).includes("kenya_m"));
});

Deno.test("Daye Bensa light: filter and milk, when light is asked for", () => {
  assertEquals(r({ light: true }).slice(0, 2), ["kenya_l", "bensa_l"]);
  assertEquals(r({ light: true, milk: "cow" })[0], "bensa_l");
  assert(!r({ taste: "fruity" }).includes("bensa_l"));                                       // only when asked
  assertEquals(r({ light: true, taste: "fruity" }), ["kenya_l", "aji", "bensa_l"]);
  assertEquals(r({ light: true, taste: "floral" }), ["kenya_l", "leona", "bensa_l"]);
});

Deno.test("decaf shows decaf, for every method", () => {
  for (const brew of ["auto", "combo", "manual", "moka", "filter", "press"]) assertEquals(r({ brew, decaf: true }), ["decaf"]);
});

Deno.test("out of stock is skipped and the result is never empty", () => {
  const s = { all: ALL.filter((k) => k !== "aristo" && k !== "sertao"), light: [] };
  const l = r({ brew: "auto", brand: "premium" }, s);
  assert(l.length > 0 && !l.includes("aristo"));
  assert(noRobusta(l));
});

Deno.test("every combination gives 1–3 in-stock coffees", () => {
  for (const brew of ["auto", "combo", "manual", "moka", "filter", "press"])
    for (const brand of ["simple", "premium"])
      for (const milk of ["none", "cow", "alt"])
        for (const taste of ["chocolate", "fruity", "floral", "unknown"])
          for (const strength of ["gentle", "balanced", "strong", "very_strong"]) {
            const l = r({ brew, brand, milk, taste, strength });
            assert(l.length >= 1 && l.length <= 3 && l.every((k: string) => ALL.includes(k)));
          }
});

const jar = (over = {}) => ({ key: "extra_1", flavor: "fruity", milk: false, brews: ["filter"], limited: true, light: true, ...over });
const withJar = (over = {}) => ({ ...stock, extras: [jar(over)] });

Deno.test("limited edition takes the third place when it fits", () => {
  assertEquals(r({ brew: "filter", taste: "fruity" }, withJar()), ["kenya_l", "kenya_m", "extra_1"]);
  assertEquals(r({ brew: "moka", strength: "strong", taste: "chocolate" }, withJar({ brews: ["moka"], flavor: "chocolate", light: false })), ["sertao", "extra_1"]);
});

Deno.test("limited edition stays out when it doesn't fit", () => {
  assert(!r({ brew: "auto", brand: "premium" }, withJar()).includes("extra_1"));            // wrong brew
  assert(!r({ taste: "chocolate" }, withJar()).includes("extra_1"));                        // wrong flavor
  assert(!r({ milk: "cow", taste: "fruity" }, withJar()).includes("extra_1"));              // not for milk
  assert(!r({ strength: "very_strong" }, withJar()).includes("extra_1"));
  assert(!r({ decaf: true }, withJar()).includes("extra_1"));
  assert(!r({ natural: true }, withJar()).includes("extra_1"));
  assert(!r({ noSour: true }, withJar()).includes("extra_1"));
});

Deno.test("alternative milk: a fruity or light jar only if light is asked for", () => {
  const m = { milk: true };
  assert(!r({ milk: "alt", taste: "fruity" }, withJar(m)).includes("extra_1"));
  assert(r({ milk: "alt", light: true, taste: "fruity" }, withJar(m)).includes("extra_1"));
  const washedMedium = withJar({ milk: true, flavor: "chocolate", light: false });
  assert(r({ milk: "alt", taste: "chocolate" }, washedMedium).includes("extra_1"));
});

Deno.test("a new coffee, not limited, only fills empty places", () => {
  const plain = withJar({ limited: false });
  assertEquals(r({ brew: "filter", taste: "fruity" }, plain), ["kenya_l", "kenya_m", "bensa_m"]);
  const moka = withJar({ limited: false, brews: ["moka"], flavor: "chocolate", light: false });
  assertEquals(r({ brew: "moka", strength: "strong", taste: "chocolate" }, moka), ["sertao", "extra_1"]);
});

Deno.test("a sold-out jar is simply not in the list", () => {
  assertEquals(r({ taste: "fruity" }), r({ taste: "fruity" }, { ...stock, extras: [] }));
});

Deno.test("a jar that is a named coffee is not shown twice", () => {
  const s2 = { ...stock, extras: [{ key: "kenya_l", flavor: "fruity", milk: false, brews: ["filter"], limited: true, light: true }] };
  const l = r({ taste: "fruity" }, s2);
  assertEquals(new Set(l).size, l.length);
});

Deno.test("asked for light: a light jar shows for any brew, with or without milk", () => {
  for (const brew of ["auto", "combo", "manual", "moka", "filter", "press"]) {
    for (const milk of ["none", "cow", "alt"]) {
      assert(r({ brew, milk, light: true, taste: "fruity" }, withJar()).includes("extra_1"), `${brew}/${milk}`);
    }
  }
  assert(!r({ brew: "auto", milk: "cow", taste: "fruity" }, withJar()).includes("extra_1"));   // not without the ask
});

Deno.test("asked for light: every named light coffee can reach espresso with milk", () => {
  assertEquals(r({ brew: "manual", milk: "cow", light: true }), ["bensa_l", "kenya_l", "guji"]);
  assert(r({ brew: "manual", milk: "cow", light: true, taste: "fruity" }).includes("aji"));
});

Deno.test("asked for light: flavor doesn't hide a light jar, and non-light jars stay out", () => {
  assert(r({ light: true, taste: "chocolate" }, withJar()).includes("extra_1"));
  assert(!r({ light: true }, withJar({ light: false, flavor: "chocolate" })).includes("extra_1"));
  assert(!r({ light: true, strength: "very_strong" }, withJar()).includes("extra_1"));
});
