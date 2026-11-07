-- =============================================================================
-- Supplier invoices — no impossible dates
--
-- On 2026-10-22 an invoice was saved with invoice_date 0006-10-05 (the AI read
-- no date and the year was typed as "6"). A supplier invoice is from this
-- century. NOT VALID: the rule applies to every new INSERT/UPDATE but does not
-- reject the existing bad row, which a person fixes from its file; once that
-- is done, VALIDATE CONSTRAINT can be run.
-- =============================================================================

ALTER TABLE public.supplier_invoices
  DROP CONSTRAINT IF EXISTS supplier_invoices_invoice_date_sane;
ALTER TABLE public.supplier_invoices
  ADD CONSTRAINT supplier_invoices_invoice_date_sane
  CHECK (invoice_date IS NULL OR invoice_date >= DATE '2000-01-01') NOT VALID;
