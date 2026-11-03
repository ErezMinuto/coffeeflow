-- =============================================================================
-- Supplier invoices — catch the same invoice uploaded twice
--
-- The identical FILE is already refused (unique file_sha256). The same
-- invoice photographed twice, or uploaded by two employees, gives two files.
--
-- 1. possible_duplicate_of: set by the supplier-invoices edge function when an
--    upload looks like an invoice already in the system (same supplier + same
--    number, or same supplier + date + total). The page shows it, and "approve
--    all" skips it. ON DELETE SET NULL: deleting the original clears the mark.
-- 2. A hard rule: two CONFIRMED invoices cannot share supplier + invoice
--    number (digits only — an RTL PDF can reverse "MGS2609802") + doc type.
--    Checked 2026-10-22: no rows in prod, so nothing violates it.
-- =============================================================================

ALTER TABLE public.supplier_invoices
  ADD COLUMN IF NOT EXISTS possible_duplicate_of uuid
    REFERENCES public.supplier_invoices(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoices_confirmed_number_key
  ON public.supplier_invoices (supplier_tax_id, (regexp_replace(invoice_number, '\D', '', 'g')), doc_type)
  WHERE status = 'confirmed'
    AND supplier_tax_id IS NOT NULL
    AND regexp_replace(coalesce(invoice_number, ''), '\D', '', 'g') <> '';
