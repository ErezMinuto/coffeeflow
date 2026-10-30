# Minuto catalog audit: summary

Read-only audit of minuto.co.il through the WooCommerce REST API: 1191 products and 113 variations. The 127 hidden products were excluded, as you asked.

* **Every visible product was read and checked** (1064): coffee beans, machines, grinders, capsules, cups, brewing gear, cleaning products, water filters and accessories.
  * Each title, short description, description, attribute set and variation list was compared, and colour/size siblings were compared with each other.
* **Automatic checks:**
  * zero price
  * duplicate SKUs (none found)
  * missing SKU, image or descriptions
  * "100% Arabica" next to robusta
  * stale price-per-100 g text
  * colour variants of the same model priced differently
* Rows marked **verify** need a source the catalog doesn't have, such as an importer spec sheet, a supplier lot sheet or packaging. Apply the suggested text only after checking it.

**1056 findings in 715 products**: 94 high · 345 medium · 617 low.
Many low rows are the same typo or machine-translated paragraph repeated across a product family, logged once per product.

## Counts by issue type and severity

| issue_type | high | medium | low | total |
|---|---|---|---|---|
| blend_vs_single_origin | 0 | 3 | 0 | 3 |
| coffee_facts | 1 | 5 | 5 | 11 |
| copy_paste | 42 | 85 | 12 | 139 |
| hebrew_text | 0 | 16 | 401 | 417 |
| internal_mismatch | 23 | 138 | 45 | 206 |
| missing_data | 0 | 12 | 63 | 75 |
| product_facts | 16 | 42 | 23 | 81 |
| spec_commerce | 12 | 44 | 68 | 124 |
| **total** | 94 | 345 | 617 | 1056 |

## Top 10 fixes

1. **Machine pages describing a different model.**
   * Melitta CI Touch (67330) and Latte Select (67329) carry the Caffeo Passione OT short description.
   * The Jura C9 (65446) short description says C8 with 6 drinks.
   * The Jura "W8" (76352) is all WE8 copy. It duplicates 64790 at 8,400 vs 8,000 ₪.
   * The Siemens EQ.9 s700 (65230) shows s500 copy plus an expired "until 30.04.2019, 5-year warranty" offer.
   * The Jura E8 (81455, 64929) contains ENA 8 paragraphs.
2. **Wrong machine specs.**
   * Lelit Mara X (64677, 64678) is listed with two boilers; it is a heat-exchanger machine.
   * ECM Technika VI (67650) is sold as dual boiler.
   * The Flair 58X (64854) spec block says 40 mm / 60 ml, copied from the Signature.
   * Jura Z10 (×3) is listed at 2,450 W instead of 1,450 W.
   * La Pavoni Europiccola (67161) is listed with a 1.6 L boiler.
   * La Pavoni PLQ (67160) is said to need no electricity.
   * Two grinders list US 110–120 V / 60 Hz: Fiorenzato AllGround (64857) and Lelit William (65055).
3. **Capsules: compatibility, pack count, blend.**
   * Lavazza A Modo Mio Oro (64712) is said to fit Nespresso.
   * Dolce Gusto Cortado (67253) and Ardenza (67249) say 16 in one place and 30 in another.
   * Esse Infinito (67210) and Maestoso (67308) say 50 and 100.
   * A Modo Mio Intenso (67395) is 16 capsules at the price of the 36-packs.
   * Suerte (67385) carries the Delizioso text.
   * Lavazza Blue Roma (82277) is called "100% ערביקה" but is a robusta blend.
   * Bialetti Napoli (65015) carries the Milano text.
   * Italian Coffee Lungo (64847) carries the Super Creamy text.
4. **Free or test items that can be bought.** "הצבה" (65427) and "כללי" (65369) are visible at 0 ₪ and in stock. "בדיקת תשלום" (64703) is visible at 1 ₪. "משלוח", "התקנה" and "קפה פילטר" are also visible.
5. **A cut-off promo line on machine pages**, "מותנה ברכישה של 5 ק״ג פולי קפה…". It appears on Profitec Pro 500 and Pro 700, Nivona 790 and 795, Melitta Barista TS and T Smart, and Gaggia Magenta Plus. It reads as if the price depends on buying 5 kg of beans.
6. **Wrong size or volume on cups and serveware.**
   * All 10 NotNeutral Pico saucers, and the 5 Pico 355 ml mugs, have a short description saying 240 ml.
   * Loveramics glass 76799 is titled 180 ml; its description says 120 ml.
   * Dale Harris 80 ml cup 67620: the description calls it a 200 ml cappuccino cup.
   * Loveramics 67660 says both 250 and 200 ml.
   * Bialetti 8-cup French press 65057: the short description says 3 cups.
   * Knock box 79990 is titled 114 mm; its text says 14 cm.
   * Eco Klear tablets 76294 say 8 × 2 g in one place and 6 × 3.4 g in another.
7. **Baskets, tampers and filters.**
   * IMS baskets 82018, 82023, 67207 and 76629 give the wrong gram range or size.
   * ILSA tamper 64799 is 57 mm, but its short description says 51 mm.
   * CafeLat tamper 65140 is titled 58 mm; its spec says 57 mm.
   * The Chemex 6-cup (64894) recommends the 3-cup FP-2 filters.
   * The naked portafilter 65118 claims to fit every machine.
   * The Toddy 50-pack filters 67208 say 20 per pack.
8. **Coffee beans.**
   * The price-per-100 g text is wrong on four products (65135, 65196, 65189, 64855).
   * The Google titles of Daye Bensa (65180) and Yirgacheffe (65384) say light roast; both are medium.
   * Fazenda Sertão (65175) gives two different origins.
   * Green Prestige (65201) says 90/10 in one place and 80/20 in another.
9. **Draft or internal text left on live pages.**
   * An assistant note, "חשוב להתאים את הטקסט לאתר…", on Lelit Bianca V3 (64680, 64679).
   * "4o" (ChatGPT residue) at the end of Rocket TCA and ECM Knock Box M.
   * Visible SEO keyword blocks on ECM Mechanika Max, Lavazza Tierra Africa and others.
   * ",k, ptzh" (תלת פאזי typed with an English keyboard layout) on both La Marzocco KB90 listings.
   * Duplicates published with "- Copy" or "(העתק)" in the title, e.g. 68251, 68253 and 79401.
10. **Colour copied from a sibling product.** Loveramics, Club House, notNeutral and Hario products name another colour in the copy (65475, 78228, 78232, 64903, 80541, 78189, 82537 and more). Colour attributes are also wrong on Airscape 250 g (all say "black") and on the black knock boxes.

## Came out clean

349 of 1064 visible products had no findings. The full list is in `clean_products.txt`. Coffee products among them:
* פולי קפה טרי 100% ערביקה - Minuto Dark Chocolate (64860)

Files:
* `findings.csv`: every finding, sorted high → low.
* `raw/`: the API snapshot, the review chunks and the reviewers' JSON.
* To re-run without fetching: `python3 catalog-audit/family.py && python3 catalog-audit/audit.py`.
