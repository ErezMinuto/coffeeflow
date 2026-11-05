// Product names from the brain → in-stock Minuto coffee rows (render-draft).
// deno-lint-ignore-file no-explicit-any

export const normName = (s: string) => String(s ?? "").toLowerCase().replace(/[\s\-–|]+/g, " ").trim();

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
    if (hits.length !== 1) {
      const list = (hits.length ? hits : coffee).map((pr) => pr.name).slice(0, 40).join(" | ");
      return { ok: false, error: `product "${raw}" ${hits.length ? "matches more than one coffee" : "is not an in-stock Minuto coffee"}. Use one of: ${list}` };
    }
    if (!out.some((x) => x.woo_id === hits[0].woo_id)) out.push(hits[0]);
  }
  return { ok: true, products: out };
}
