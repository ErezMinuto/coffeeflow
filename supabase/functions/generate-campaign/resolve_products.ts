// Product names from the brain → in-stock Minuto coffee rows (render-draft).
// deno-lint-ignore-file no-explicit-any

export const normName = (s: string) => String(s ?? "").toLowerCase().replace(/[\s\-–|]+/g, " ").trim();

// The house blends are printed in English on the bag ("Aristo") but named
// only in Hebrew in the shop ("... מינוטו אריסטו - Minuto Specialty Coffee"),
// so the name on the bag would never match. Single origins carry their Latin
// name in the shop title already.
const BLEND_ALIASES: Record<string, string> = {
  "aristo": "אריסטו",
  "intenso": "אינטנסו",
  "prestige": "פרסטיז'",
  "trieste": "טריאסט",
  "triest": "טריאסט",
  "decaf": "נטול קפאין",
};

const LIGHT = /בקלייה בהירה|קלייה בהירה|\blight\b/;

// Resolve the brain's product names to in-stock Minuto coffee. Exact name
// first, else the one coffee product whose name contains it ("Aristo").
// deno-lint-ignore no-explicit-any
export function resolveCoffee(names: string[], coffee: any[]): { ok: true; products: any[] } | { ok: false; error: string } {
  const out: any[] = [];
  for (const raw of names) {
    const n = normName(raw);
    if (!n) continue;
    let hits = coffee.filter((pr) => normName(pr.name) === n);
    if (!hits.length) hits = coffee.filter((pr) => normName(pr.name).includes(n));
    if (!hits.length && BLEND_ALIASES[n]) hits = coffee.filter((pr) => normName(pr.name).includes(normName(BLEND_ALIASES[n])));
    // Several single origins come in a standard and a light roast. Unless the
    // request names the light roast, the standard one is meant.
    if (hits.length > 1 && !LIGHT.test(n)) {
      const standard = hits.filter((pr) => !LIGHT.test(normName(pr.name)));
      if (standard.length === 1) hits = standard;
    }
    if (hits.length !== 1) {
      const list = (hits.length ? hits : coffee).map((pr) => pr.name).slice(0, 40).join(" | ");
      return { ok: false, error: `product "${raw}" ${hits.length ? "matches more than one coffee" : "is not an in-stock Minuto coffee"}. Use one of: ${list}` };
    }
    if (!out.some((x) => x.woo_id === hits[0].woo_id)) out.push(hits[0]);
  }
  return { ok: true, products: out };
}
