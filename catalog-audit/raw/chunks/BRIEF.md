# Review brief: Minuto catalog audit (read-only)

You are auditing part of the WooCommerce catalog of Minuto (minuto.co.il), an Israeli coffee shop that sells espresso
machines, grinders, capsules, cups, brewing gear, cleaning products and accessories. The copy is mostly Hebrew.
This is READ-ONLY: never call any API, never modify anything. Read only your chunk file and write only your output file.

Each product in the chunk starts with `### ID <id> | <status> | <type> | <permalink>` and lists NAME, PRICE, SKU,
CATEGORIES, ATTRIBUTES, VARIATIONS, SHORT (short description) and DESCRIPTION (HTML stripped, text exactly as written).
Read the whole file (use offset/limit; it is ~190 KB).

## What to flag
a) Internal mismatches: specs that disagree between title, short description, description and attributes. For example:
   model number, colour, boiler size and type, pump pressure, wattage, voltage, water tank, portafilter/basket diameter
   (51/53/54/58 mm), burr size and type, dimensions, weight, capacity in ml, cup count, capsule count, pack size,
   material, compatibility (Nespresso / Dolce Gusto / A Modo Mio / Lavazza Blue…), warranty.
b) Copy-paste leftovers: a description that names a different model, brand, colour, size or product than the title.
   Compare products in the same family (colour variants, sizes, sibling models) that sit next to each other in the
   file: flag near-identical copy whose specs or prices differ unexpectedly, and siblings whose copy contradicts each other.
c) Commerce errors: price that doesn't fit the pack size or sibling variants (the same model in another colour at an
   odd different price, a bigger pack cheaper than a smaller one, sale price ≥ regular), pack count in the title vs the
   text, hard-coded "price per unit" text that doesn't match the price, a published product that is clearly a test,
   placeholder or "(העתק)" copy.
d) Facts that don't add up: specs implausible for the named brand/model (use real knowledge of espresso machines,
   grinders, brewing gear and capsules, e.g. Linea Mini is dual boiler, Gaggia Classic uses 58 mm, Comandante C40 is
   hand-cranked with Nitro Blade burrs), wrong compatibility claims, "100% Arabica" on products that list robusta,
   impossible numbers. If unsure, mark confidence "verify" instead of calling it wrong.
e) Hebrew text quality: obvious typos, broken or cut-off sentences, wrong units (גרם/ק״ג, מ״ל/ליטר), leftover English
   placeholder or lorem text, visible SEO keyword stuffing, HTML or shortcode residue, leftover video/embed text.

## Do NOT report (already covered by automatic checks)
Empty description, empty short description, missing image, missing SKU, empty weight field, zero price.

## Severity
high = wrong info a customer would rely on (wrong spec, wrong compatibility, wrong price or pack count, wrong model);
medium = inconsistent or contradictory; low = cosmetic (typos, style, duplicated sentences).

## Output
Write a JSON array to the output file named in your task, one object per finding, with these keys:
product_id (int), field (e.g. "name", "short_description", "description", "attributes", "price", "variations"),
issue_type (one of: internal_mismatch, copy_paste, spec_commerce, product_facts, hebrew_text),
severity (high/medium/low), current_text (a SHORT exact excerpt, max ~120 chars), problem (one or two English sentences),
suggested_fix (in Hebrew, matching the existing tone; give replacement text where it can be derived from the data;
otherwise say what to check, e.g. "לאמת את נפח הדוד מול דף היצרן"), confidence (certain/likely/verify).
Don't invent specs. One finding per distinct issue; group repeated identical typos within one product into one finding.
Be thorough but precise: a false "high" costs more than a missed "low". Also write `[]` if you find nothing.
When done, reply with: number of findings by severity and the 3 most serious ones in one line each.
