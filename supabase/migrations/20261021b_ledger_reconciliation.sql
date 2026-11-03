-- =============================================================================
-- Supplier invoices — phase 2: reconcile against the bookkeeper's ledger
--
-- The bookkeeper exports a כרטסת הנהלת חשבונות (Hashavshevet) for a period to
-- Excel. Admin or the bookkeeper uploads it on the invoices page; the browser
-- parses it and stores the lines here. The matching itself is NOT stored: the
-- page recomputes it against the current invoices every time (src/lib/
-- ledgerReconcile.js), so an invoice uploaded after the import still matches.
-- The page shows:
--   • invoices in CoffeeFlow that no ledger line matched  → not booked (alert)
--   • invoice-type ledger lines that matched no invoice    → no file uploaded
--   • matches whose amounts differ
-- supplier_invoices is never written here (the bookkeeper cannot update it).
--
-- Access: admin and bookkeeper only — read, import, delete an import.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ledger_imports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source            text NOT NULL DEFAULT 'hashavshevet' CHECK (source IN ('hashavshevet')),
  period_from       date NOT NULL,
  period_to         date NOT NULL,
  filename          text,
  line_count        integer NOT NULL DEFAULT 0,
  imported_by       text NOT NULL DEFAULT (auth.jwt() ->> 'sub'),
  imported_by_name  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from)
);
CREATE INDEX IF NOT EXISTS ledger_imports_period_idx ON public.ledger_imports (period_from, period_to);

CREATE TABLE IF NOT EXISTS public.ledger_lines (
  id                  bigserial PRIMARY KEY,
  import_id           uuid NOT NULL REFERENCES public.ledger_imports(id) ON DELETE CASCADE,
  account_key         text,            -- מפתח חשבון, e.g. 6002
  account_name        text,            -- e.g. קניות
  header_id           text,            -- כותרת
  movement_id         text,            -- תנועה
  batch               text,            -- מנה
  movement_type       text,            -- ס"ת: חס / חסר … (empty for bank/card imports)
  counter_account     text,            -- ח-ן נגדי: the supplier's ע.מ when it has its own card
  doc_date            date,            -- ת.אסמכ
  value_date          date,            -- ת.ערך
  ref1                text,            -- אסמ'
  ref2                text,            -- אסמ'2: the invoice number (often its last digits)
  details             text,            -- פרטים: usually the supplier name
  amount              numeric(14,2) NOT NULL   -- debit − credit
);
CREATE INDEX IF NOT EXISTS ledger_lines_import_idx ON public.ledger_lines (import_id);

ALTER TABLE public.ledger_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_lines   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ledger_imports FROM anon;
REVOKE ALL ON public.ledger_lines   FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ledger_imports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ledger_lines   TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.ledger_lines_id_seq TO authenticated;

DROP POLICY IF EXISTS ledger_imports_books ON public.ledger_imports;
CREATE POLICY ledger_imports_books ON public.ledger_imports
  FOR ALL TO authenticated
  USING (public.is_admin() OR public.is_bookkeeper())
  WITH CHECK (public.is_admin() OR public.is_bookkeeper());

DROP POLICY IF EXISTS ledger_lines_books ON public.ledger_lines;
CREATE POLICY ledger_lines_books ON public.ledger_lines
  FOR ALL TO authenticated
  USING (public.is_admin() OR public.is_bookkeeper())
  WITH CHECK (public.is_admin() OR public.is_bookkeeper());
