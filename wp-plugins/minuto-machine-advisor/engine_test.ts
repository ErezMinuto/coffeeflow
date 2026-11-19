// deno test --no-config --allow-read wp-plugins/minuto-machine-advisor/engine_test.ts
//
// catalog_fixture.json is a snapshot of the machines on sale on 2026-11-19,
// filtered the way the PHP catalog filters (published, in stock, visible).
import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import "./assets/engine.js";
import "../minuto-coffee-quiz/assets/engine.js";
// deno-lint-ignore no-explicit-any
const E = (globalThis as any).MinutoAdvisorEngine;
// deno-lint-ignore no-explicit-any
const Q = (globalThis as any).MinutoQuizEngine;

type M = { key: string; brand: string; kind: string; price: number; milk?: string; boiler?: string; grinder?: boolean; plumb?: boolean; takes?: string[] };
const live: M[] = JSON.parse(await Deno.readTextFile(new URL("./catalog_fixture.json", import.meta.url)));
const byKey = (k: string) => live.find((m) => m.key === k)!;
// deno-lint-ignore no-explicit-any
const rec = (a: any, c: M[] = live) => E.recommend(a, c);
const picked = (a: unknown, c: M[] = live) => (rec(a, c).keys as string[]).map((k) => c.find((m) => m.key === k)!);

const auto = (milk: string, budget: number) => ({ use: "auto", milk, budget });
const manual = (milk: string, budget: number, extra = {}) => ({ use: "manual", milk, budget, grinder: "yes", water: "no", ...extra });

Deno.test("coffee shops and offices go to WhatsApp", () => {
  assertEquals(rec({ use: "business" }), { route: "whatsapp" });
});

Deno.test("never more than three, one per brand while other brands fit", () => {
  for (const milk of ["none", "hand", "button"]) {
    for (let b = 0; b < 4; b++) {
      const ms = picked(auto(milk, b));
      assert(ms.length <= 3);
      // As many brands as the range offers. Nivona doesn't count: a second
      // machine of another brand goes ahead of it.
      const brands = ms.map((m) => m.brand);
      const r = rec(auto(milk, b));
      const range = r.near ? E.rangeIndex(ms[0].price, E.RANGES.auto) : b;
      const fits = live.filter((m) => m.kind === "auto" && m.milk === milk && m.brand !== "Nivona" && E.rangeIndex(m.price, E.RANGES.auto) === range);
      const available = new Set(fits.map((m) => m.brand)).size;
      assertEquals(new Set(brands.filter((x) => x !== "Nivona")).size, Math.min(available, ms.length), `${milk} ${b}: ${brands}`);
    }
  }
});

Deno.test("every machine shown fits the milk answer", () => {
  for (const milk of ["none", "hand", "button"]) {
    for (let b = 0; b < 4; b++) picked(auto(milk, b)).forEach((m) => assertEquals(m.milk, milk));
  }
  const boiler = { rarely: "single", daily: "hx", many: "dual" } as Record<string, string>;
  for (const milk of Object.keys(boiler)) {
    for (let b = 0; b < 4; b++) {
      picked(manual(milk, b)).forEach((m) => {
        assertEquals(m.boiler, boiler[milk]);
        assert(!m.grinder, "a customer with a grinder doesn't get a built-in one");
      });
    }
  }
});

Deno.test("inside the price range when the range has machines", () => {
  for (const milk of ["none", "hand", "button"]) {
    for (let b = 0; b < 4; b++) {
      const r = rec(auto(milk, b));
      if (r.near) continue;
      r.keys.forEach((k: string) => assertEquals(E.rangeIndex(byKey(k).price, E.RANGES.auto), b));
    }
  }
});

Deno.test("Nivona goes last: only when fewer than three other machines fit", () => {
  const c: M[] = [
    { key: "n1", brand: "Nivona", kind: "auto", milk: "button", price: 3250 },
    { key: "j1", brand: "Jura", kind: "auto", milk: "button", price: 3900 },
    { key: "m1", brand: "Melitta", kind: "auto", milk: "button", price: 3000 },
    { key: "m2", brand: "Melitta", kind: "auto", milk: "button", price: 3100 },
  ];
  // Three non-Nivona machines fit: Nivona stays out, even though it is
  // closest to the middle of the range.
  assertEquals(rec(auto("button", 1), c).keys.sort(), ["j1", "m1", "m2"]);
  // Two fit: Nivona fills the third place.
  assertEquals(rec(auto("button", 1), c.filter((m) => m.key !== "m2")).keys, ["m1", "j1", "n1"]);
  // On today's stock, the ₪2,500–4,000 one-touch-milk range has enough others.
  assert(!picked(auto("button", 1)).some((m) => m.brand === "Nivona"));
});

Deno.test("closest to the middle of the range comes first", () => {
  const c: M[] = [
    { key: "far", brand: "A", kind: "auto", milk: "none", price: 4100 },
    { key: "mid", brand: "B", kind: "auto", milk: "none", price: 5000 },
    { key: "near", brand: "C", kind: "auto", milk: "none", price: 5600 },
  ];
  assertEquals(rec(auto("none", 2), c).keys, ["mid", "near", "far"]);
});

Deno.test("nothing in the range: the nearest range, marked as near", () => {
  const c: M[] = [
    { key: "cheap", brand: "A", kind: "auto", milk: "none", price: 2000 },
    { key: "dear", brand: "B", kind: "auto", milk: "none", price: 7000 },
  ];
  const r = rec(auto("none", 1), c);
  assert(r.near);
  assertEquals(r.keys, ["cheap"]);   // a tie between ranges goes to the cheaper one
  const top = rec(auto("none", 3), c.slice(0, 1));
  assert(top.near);
  assertEquals(top.keys, ["cheap"]);
});

Deno.test("no grinder, lowest range: the machines with a grinder built in", () => {
  const ms = picked(manual("rarely", 0, { grinder: "no" }));
  assert(ms.length > 0);
  ms.forEach((m) => assert(m.grinder));
  assert(!rec(manual("rarely", 0, { grinder: "no" })).needGrinder);
});

Deno.test("no grinder, higher ranges: regular machines, with a note", () => {
  const r = rec(manual("daily", 1, { grinder: "no" }));
  assert(r.needGrinder);
  r.keys.forEach((k: string) => assert(!byKey(k).grinder));
});

Deno.test("water line: asked only for manual from ₪7,000, and then only plumbed machines", () => {
  assert(!E.asksWater({ use: "manual", budget: 1 }));
  assert(E.asksWater({ use: "manual", budget: 2 }));
  assert(!E.asksWater({ use: "auto", budget: 3 }));
  for (const milk of ["rarely", "daily", "many"]) {
    for (const b of [2, 3]) {
      const ms = picked(manual(milk, b, { water: "yes" }));
      assert(ms.length > 0, `${milk} ${b}`);
      ms.forEach((m) => assert(m.plumb, `${m.key} must connect to the water line`));
    }
  }
});

Deno.test("on the go follows capsules or ground coffee", () => {
  picked({ use: "go", takes: "capsule" }).forEach((m) => assert(m.takes!.includes("capsule")));
  picked({ use: "go", takes: "ground" }).forEach((m) => assert(m.takes!.includes("ground")));
  // The car machine takes both.
  if (byKey("emilio_car")) {
    assert(rec({ use: "go", takes: "capsule" }).keys.includes("emilio_car"));
  }
});

Deno.test("filter and lever show their own machines", () => {
  picked({ use: "filter" }).forEach((m) => assertEquals(m.kind, "filter"));
  for (let b = 0; b < 4; b++) picked({ use: "lever", budget: b }).forEach((m) => assertEquals(m.kind, "lever"));
});

Deno.test("every answer path returns something on today's stock", () => {
  const paths: unknown[] = [{ use: "filter" }, { use: "go", takes: "ground" }, { use: "go", takes: "capsule" }];
  for (let b = 0; b < 4; b++) {
    for (const milk of ["none", "hand", "button"]) paths.push(auto(milk, b));
    for (const milk of ["rarely", "daily", "many"]) {
      for (const grinder of ["yes", "no"]) {
        for (const water of b >= 2 ? ["yes", "no"] : ["no"]) paths.push(manual(milk, b, { grinder, water }));
      }
    }
    paths.push({ use: "lever", budget: b });
  }
  for (const p of paths) assert(rec(p).keys.length > 0, JSON.stringify(p));
});

Deno.test("coffee step uses the quiz rules: Gaggia automatics get the robusta blends", () => {
  const all = ["aristo", "dark", "sertao", "jungle", "velvet", "antigua", "bensa_m", "kenya_m", "intenso", "trieste", "prestige", "decaf"];
  const first = (m: M, a: unknown) => Q.recommend(E.coffeeAnswers(m, a), { all, light: [] })[0];
  const gaggia = { key: "g", brand: "Gaggia", kind: "auto", price: 2400 };
  const jura = { key: "j", brand: "Jura", kind: "auto", price: 5000 };
  assert(Q.ROBUSTA.includes(first(gaggia, { milk: "none" })));
  assertEquals(first(jura, { milk: "none" }), "aristo");
  assertEquals(first({ key: "x", brand: "Lelit", kind: "manual", price: 5000 }, { milk: "rarely" }), "sertao");
  // Capsules only: no beans to sell, so no coffee line.
  assertEquals(E.coffeeAnswers({ key: "c", brand: "Wacaco", kind: "go", price: 199 }, { takes: "capsule" }), null);
});
