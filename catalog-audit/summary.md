# Minuto catalog audit: summary

Read-only audit of minuto.co.il via the WooCommerce REST API. 1191 products and 113 variations fetched; 127 hidden products excluded, as you asked.

* **Full content audit** (checks a–f) on the 27 coffee-bean products: roasted single origins, Minuto blends, Veneto, green beans and tasting kits.
* **Mechanical checks** on all 1055 published, non-hidden products: price 0, duplicate SKUs, missing SKU, image or descriptions, and "100% Arabica" next to robusta.
* No duplicate SKUs anywhere. No lorem or English placeholder text.

**189 findings**: 11 high · 45 medium · 133 low.

## Counts by issue type and severity

| issue_type | high | medium | low | total |
|---|---|---|---|---|
| blend_vs_single_origin | 0 | 3 | 0 | 3 |
| coffee_facts | 1 | 5 | 5 | 11 |
| copy_paste | 0 | 4 | 2 | 6 |
| hebrew_text | 0 | 0 | 20 | 20 |
| internal_mismatch | 4 | 9 | 5 | 18 |
| missing_data | 0 | 12 | 63 | 75 |
| spec_commerce | 6 | 12 | 38 | 56 |
| **total** | 11 | 45 | 133 | 189 |

## Top 10 fixes

1. **Wrong "price per 100 g" in the copy** on Kenya AA+ (65135), Prestige (65196), Triest (65189) and Velvet Star (64855). All are below the real price: 23.1 → 23.94, 16.5 → 17.88, 16.5 → 17.88, 19.5 → 20.91. Best fix: remove the hard-coded lines and let a unit-price display compute it.
2. **Lavazza Blue Tales of Roma (82277)**: the title says "100% ערביקה", but its own descriptions say Arabica + Robusta. The description headline also names the Venezia product.
3. **Green Prestige 250 g (65201)**: the short description and SEO say 90/10 Arabica/robusta, but the description says 80/20.
4. **Daye Bensa medium (65180)**: the Google title and snippet say light roast, but the product is medium, and a separate light-roast listing (78450) exists. Add the roast level to the product name too.
5. **Yirgacheffe (65384)**: the SEO says light roast and "Sidama", but the attribute and copy say medium Yirgacheffe. The page also ends in a broken fragment pasted from Daye Bensa.
6. **Fazenda Sertão (65175, plus green 65108 and kit 67146)**: the spec box says Grama Valley / Grupo Sertãozinho; the story says Fazenda Sertão, Carmo de Minas. It also contains the Guatemala "volcanic soil, eternal spring" paragraph. Confirm with the green supplier.
7. **Two placeholder products are live at 0 ₪ and in stock**: "הצבה" (65427) and "כללי" (65369). Hide them. Also hide "בדיקת תשלום" (1 ₪), "משלוח", "התקנה", "קפה פילטר" and "shipping Costs"; set a price for or unpublish VARIA VS4 (82651).
8. **Kenya AA+ duplicates (65463 / 65135)**: the two listings give different altitudes, and 65135 has no roast level. 65463 also says AA is a variety (it is a size grade). Kiambu is not in the Mount Kenya region.
9. **Blend vs single origin**: Velvet Star (64855) and Decaf (64734) are described as "תערובת" but sit in חד זני. Aristo (64702) says "different origins" next to "מקור: ברזיל". Sweet Leona's SEO calls it a blend for espresso.
10. **"ספשלטי" on robusta blends and Veneto**: Intenso (30% robusta), Prestige and Triest (20% robusta), and the SEO for all three Veneto products. Decide on a policy; unless the robusta is graded Fine Robusta, drop "ספשלטי" there.

## Came out clean

Coffee products with no findings:
* פולי קפה טרי 100% ערביקה - Minuto Dark Chocolate (64860)

964 of 1055 published, non-hidden products passed all mechanical checks. They were not content-reviewed; the full list is in `clean_products.txt`.

Notes:
* Shipping weight is 0 or empty on 22 of the 24 non-kit coffee products. These are logged as low.
* Every "verify" row needs a source the catalog doesn't have (supplier lot sheet, roasting recipe, Lavazza packaging). The suggested text applies only once that source is confirmed.
* Re-run with `python3 catalog-audit/audit.py` (reads `raw/`, no fetch).
