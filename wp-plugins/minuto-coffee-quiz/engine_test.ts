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
  assertEquals(r(p), ["aristo", "sertao"]);
  assertEquals(r({ ...p, strength: "strong" })[0], "dark");
  assert(noRobusta(r({ ...p, strength: "strong" })));
  assertEquals(r({ ...p, strength: "very_strong" }), ROBUSTA);
});

Deno.test("built-in grinder: Aristo + Dark Chocolate, robusta only if very strong", () => {
  assertEquals(r({ brew: "combo" }), ["aristo", "dark"]);
  assertEquals(r({ brew: "combo", strength: "very_strong" }), ROBUSTA);
});

Deno.test("manual espresso: Sertão, Jungle, Aristo; no robusta by default", () => {
  assertEquals(r({ brew: "manual" }), ["sertao", "jungle", "aristo"]);
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

Deno.test("light roast: Kenya first, Guji first for natural; new light coffees join", () => {
  assertEquals(r({ light: true })[0], "kenya_l");
  assertEquals(r({ natural: true })[0], "guji");
  const s = { all: ["kenya_l", "new_light"], light: ["kenya_l", "new_light"] };
  assertEquals(r({ light: true }, s), ["kenya_l", "new_light"]);
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
