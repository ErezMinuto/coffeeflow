# Fix the contradictions you found (owner approved: "fix wrong data per the official site")

Your earlier spec-fill plan listed products in "skipped" whose page value contradicts the official spec. Some were
also mentioned in your report as "wrong values already on pages". Now turn each one into an exact replace edit.

- The CURRENT raw product data is in catalog-audit/backup/after-specs/products.json (find the product by id).
  The pages changed since your input: your spec blocks were appended, and other fixes went live. Copy `old` from
  THIS file.
- Output: catalog-audit/raw/fix_plans/specfix_<your bucket>.json → {"edits":[…],"skipped":[…]}.
- Edit format: {"product_id", "variation_id": null, "target": "name"|"short_description"|"description",
  "old": exact substring of the current raw field (exactly once), "new": the same text with the value corrected,
  "finding": "contradiction: page X vs official Y", "source": url}
  * Keep every HTML tag in `old` identical and in the same order in `new`. Change only the wrong value and its unit or
    wording.
  * Fix every place on the page that states the wrong value, in both the short description and the description.
    Use one edit per occurrence and make each `old` unique.
- Skip, with a reason, when: the official sources disagree with each other, the page clearly describes a different
  or older version than the official page, the exact model or version is uncertain, or the value isn't stated
  officially.
- No WooCommerce calls. Check: each old occurs exactly once (after earlier edits on the same field), tags identical.
Reply with: edits count, skipped count, one line per corrected product (page value → official value).
