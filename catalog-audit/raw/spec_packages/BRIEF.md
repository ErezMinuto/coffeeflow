# Spec research + fix plan (Minuto catalog, coffee equipment)

The shop owner asked: "fix all the wrong data for coffee equipment according to their official site".
You do NOT apply anything to the shop. You research, then write an edit plan.

Input: raw/spec_packages/<group>.json → {findings:[audit findings still open], products:[current raw WooCommerce fields]}.
Output: raw/fix_plans/spec_<group>.json → {"edits":[…], "skipped":[…], "sources":[…]}.

## 1. Research
For each finding, find the product's spec on the manufacturer's OFFICIAL website (jura.com, lelit.com, ecm.de,
profitec-espresso.com, rocket-espresso.com, bezzera.it, lamarzocco.com, lapavoni.com, gaggia.com, melitta.de,
siemens-home.bsh-group.com, nivona.com, philips.com, eureka.co.it, fiorenzato.it, ceado.com, comandantegrinder.com,
imsfiltri.com, acaia.co, hario.co.jp, chemexcoffeemaker.com, bialetti.com, wacaco.com, flairespresso.com …).
Use curl from Bash (pages are reachable; add -L and a browser User-Agent) or WebFetch/WebSearch if available.
- Official manufacturer pages only. Accept an official PDF manual or datasheet. Do not use retailer or review sites
  as the source of a value. You may use them only to find the right official page.
- Match the exact model and version (e.g. Mara X V2 vs V3, Technika V vs VI, Israeli 230 V version).
- Record every value you use in "sources": {"product_id", "spec", "value", "url"}.

## 2. Plan edits (same format and validator as before)
Each edit: {"product_id", "variation_id": null, "target": "name"|"short_description"|"description"|"meta:rank_math_title"|
"meta:rank_math_description", "old": exact substring of the CURRENT raw field (exactly once), "new": replacement,
"finding": the finding's current_text, "source": url}.
- Keep every HTML tag in old identical (same order) in new. Delete text by setting new to "" on the text only.
- Fix the wrong value to the official one, in Hebrew, keeping the page's wording around it. If the official spec
  shows a whole spec block is from another model, replace the wrong values line by line.
- If the finding turns out to be wrong (the shop's value matches the official spec), skip with reason "matches official".
- Skip (with reason) when: no official source found, the official page is ambiguous about this model/version,
  the fix needs a price/stock/business decision, or it is a store-wide attribute.
- Never invent a value. Every new number or spec must come from a URL in "sources".
Check before finishing: every old occurs exactly once (after earlier edits on the same field), tags identical.
Reply with: edits count, skipped count, and the 3 most important corrections with their source URLs.
