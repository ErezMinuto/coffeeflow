# Fill missing specs on coffee-equipment pages (Minuto, minuto.co.il)

The shop owner asked: "if there are missing specs in coffee equipment product pages we need to add them".
You research and write a plan. You do NOT touch the shop: no WooCommerce/WordPress calls.

Input: raw/specfill_packages/<bucket>.json → products[] with id, group, missing (spec items the page lacks), name,
permalink, short_description and description (current raw HTML).
Output: raw/fix_plans/specfill_<bucket>.json → {"edits":[…], "skipped":[…], "sources":[…]}.

## 1. Research (official sources only)
For each product, identify the exact model and version from the name and text. Then find its spec on the
manufacturer's OFFICIAL site: product page, official datasheet or official manual PDF. Shopify-hosted or CDN-hosted
files are fine when they are clearly the manufacturer's own document. Use curl -sL with a browser User-Agent, or
WebFetch/WebSearch to locate the official page. Do NOT take values from retailers, reviews or forums.
Do not try to get around bot checks: if a site blocks you, skip that brand and say so.
- Sold in Israel → use the 220–240 V / 50 Hz (EU) version.
- Colour variants share specs. Research once, then apply to each colour's product.
- Record every value in "sources": {"product_id", "spec", "value", "url"}.

## 2. What to add
Add only the items listed in `missing` that the official source states. You may also add these closely related
basics when the official page lists them and the page lacks them: boiler volume and type, pump type, PID, group type.
Never repeat or contradict a value that is already on the page. If the official value contradicts the page, do not
append; list it in "skipped" with reason "contradiction: page says X, official says Y".

## 3. Edit format: one append per product
{"product_id": id, "variation_id": null, "target": "description", "op": "append",
 "new": "<h3>מפרט טכני</h3>\n<ul>\n<li><strong>הספק:</strong> 1400 וואט</li>\n…</ul>",
 "finding": "missing specs: power, weight, …", "sources": ["url", …]}
- Allowed tags ONLY: h3, h4, ul, li, strong, p, br. No links, attributes, classes, inline styles, emoji or images.
- If the page already has a spec heading (מפרט / מפרט טכני), title your block "<h3>מפרט טכני נוסף</h3>". Otherwise use
  "<h3>מפרט טכני</h3>".
- Hebrew labels and values in the shop's style, e.g. הספק: 1400 וואט · מתח: 220–240 וולט · לחץ משאבה: 15 בר ·
  דוד: 1.8 ליטר עם מחליף חום · מיכל מים: 2.5 ליטר · קוטר ידית: 58 מ"מ · מידות (ר×ע×ג): 25×42×38 ס"מ · משקל: 18 ק"ג ·
  סכינים: שטוחים 64 מ"מ · מהירות: 1400 סל"ד · מיכל פולים: 300 גרם · נפח: 600 מ"ל · חומר: זכוכית בורוסיליקט.
  Use units exactly as the official source gives them, converted only for display (mm → ס"מ is fine).
- Pump pressure: use the official figure (e.g. 15 בר משאבה). Do not invent "9 bar extraction" unless stated.
- If a product needs nothing, or no official source exists, skip it with a reason.
Check before finishing: the `new` block uses only the allowed tags, balanced; no value duplicates the page.
Reply with: products filled, items added, products skipped (by reason), and 3 example blocks with their sources.
