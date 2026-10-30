# Fix plan: turn "certain" findings into exact edits (you do NOT apply anything)

Input: raw/fix_packages/chunk_N.json → {findings:[…certain findings…], products:[…raw WooCommerce fields…]}.
`description`, `short_description` and `name` are RAW stored values (HTML, entities such as &#8211; / &quot;, newlines).

Output: raw/fix_plans/chunk_N.json, a JSON object {"edits":[…], "skipped":[…]}.

Each edit:
  {"product_id": int, "variation_id": null | int,
   "target": "name" | "short_description" | "description" | "meta:rank_math_title" | "meta:rank_math_description" | "attribute:<attribute name>",
   "old": "<exact substring of the current raw value>",
   "new": "<replacement>",
   "finding": "<the finding's current_text, to link back>"}
- For "attribute:<name>" targets, old and new are single option values (e.g. old "שחור" new "ירוק"), and old must be one of that attribute's options.
- `old` must occur EXACTLY ONCE in the raw field. Make it long enough to be unique and copy it byte-for-byte,
  including HTML tags, entities and whitespace inside it. Keep it as short as uniqueness allows.
- Keep every HTML tag inside `old` unchanged in `new`, in the same order (the validator rejects edits that add, drop or
  reorder tags). To delete a whole paragraph, put only its text in `old` (not the surrounding <p>…</p>) and set `new` to "".
- Several edits on the same field are applied in order. They must not overlap.
- Hebrew replacements: use the finding's suggested_fix when it is literal replacement text. Otherwise write the
  minimal correction the finding clearly implies, matching the page's tone. Never add facts the data doesn't support.

Skip a finding, with {"finding": current_text, "product_id": …, "reason": "…"}, when:
- the fix needs information the catalog doesn't contain (looking up a spec, a supplier, or which of two values is right),
- the fix is a business decision: changing a price, deleting or merging products, stock, shipping, promotions,
- the finding is about missing content (empty description/image/SKU/weight) or about a product that should be hidden,
- the right edit isn't unambiguous. When in doubt, skip. A skipped finding costs nothing; a wrong edit is live on the shop.
When done, reply with: number of edits, number skipped, and the 3 riskiest edits you made.
