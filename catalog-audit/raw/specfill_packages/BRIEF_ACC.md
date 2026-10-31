# Accessories add-on to BRIEF.md

Follow catalog-audit/raw/specfill_packages/BRIEF.md (official sources only; one append block per product; allowed
tags; no duplicates; contradictions go to "skipped"). Differences for accessories:

- `missing` keys and their Hebrew labels:
  volume → נפח · material → חומר · dishwasher → מתאים למדיח כלים (כן/לא, plus microwave if stated) ·
  diameter → קוטר · compatibility → מתאים ל… (machines/models) · filter_life → אורך חיי הפילטר (liters/months) ·
  quantity → כמות במארז · power → הספק / סוללה · capacity_g → קיבולת · dimensions → מידות · weight → משקל.
- Skip as "not applicable" when an item doesn't fit the product (e.g. volume on a saucer, diameter on a tamping stand).
- A colour family shares specs: research once (e.g. Loveramics Egg 250 ml, notNeutral Pico, Club House Manico),
  then apply to each colour's product.
- Brand sites: loveramics.com, notneutral.com, kruveinc.com, dale harris range on loveramics.com,
  global.hario.com, acaia.co, bwt.com / brita.com / aquaphor, jura.com, melitta, eureka, ecm.de, imsfiltri.com,
  lamarzocco.com, motta.it, rhinowares.com, barista swag, cafetto.com, urnex.com, puly caff (puly.it), airscape
  (planetarydesign.com), nanofoamer (subminimal.com), etc.
- "Dishwasher safe" must be stated by the manufacturer. Never assume it from the material.
Output file: catalog-audit/raw/fix_plans/specfill_<bucket>.json
