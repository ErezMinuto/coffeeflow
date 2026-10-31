# Correct + complete 4 grinder pages now that the owner confirmed the exact model

Owner confirmed:
- 64759 "מטחנת קפה LIFE Ceado" → **Ceado Life X** (ceado.com)
- 65203 "מטחנת קפה רנצ׳יליו רוקי" → **Rancilio Rocky**, the standard doser-less Rocky, NOT the Rocky SD (ranciliogroup.com)
- 65097 "מכונת קפה ידנית ללית + מטחנה Lelit Anita - PL042EMI" → **Lelit Anita PL042EMI** (lelit.com; check for an EMI page or datasheet.
  Use PL042EM values only where Lelit says they are identical, otherwise skip)
- 65459 "מטחנת קפה ידנית מקצועית Varia EVO" → **Varia EVO, manual (hand-crank) version** (variabrewing.com). Text describing
  the USB-C/Hybrid motor, power or charging does not apply to the manual version and should be corrected or removed. Burr
  naming must follow Varia's current official wording.

Current raw data: catalog-audit/backup/before-models/products.json.
Output: catalog-audit/raw/fix_plans/models_grinders.json → {"edits":[…],"skipped":[…],"sources":[…]}.

Two kinds of edits:
1. Corrections: replace edits, following catalog-audit/raw/specfill_packages/FIX_CONTRADICTIONS.md exactly. `old` must
   occur exactly once, tags must be identical, and there is one edit per occurrence. Removing a whole `<li>…</li>` or
   `<p>…</p>` is allowed with "new": "" and "remove_element": true, if `old` is that complete balanced element.
2. Missing specs: at most one append block per product, following catalog-audit/raw/specfill_packages/BRIEF.md section 3:
   allowed tags h3/h4/ul/li/strong/p/br only; heading "מפרט טכני" or "מפרט טכני נוסף"; no value that duplicates the page.
Official manufacturer sources only (pages, datasheets, manuals). Record every value in "sources". Never guess.
No WooCommerce calls. Work dir: catalog-audit/work/models_grinders/.
Reply with: per product, what was corrected (old → new) and what was added, with source URLs.
