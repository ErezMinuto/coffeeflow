-- =============================================================================
-- Supplier invoices — phase 3a: every credit-card charge needs an invoice
--
-- Admin or the bookkeeper uploads a card statement (Bank Leumi "פרוט עסקאות
-- לכרטיס", exported as .xls, which is really an HTML table). The browser parses
-- it and stores one row per transaction here. Matching against
-- supplier_invoices is recomputed in the browser on every view
-- (src/lib/cardStatement.js), like the ledger reconciliation.
--
-- One import per card per billing month: re-uploading replaces it.
-- `kind` leaves room for the bank-account statement (transfers) later.
-- Access: admin and bookkeeper only.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.statement_imports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('card', 'bank')),
  account_label     text NOT NULL,     -- card's last 4 digits, e.g. 7113
  period_month      date NOT NULL,     -- first day of the billing month
  filename          text,
  line_count        integer NOT NULL DEFAULT 0,
  total_charged     numeric(14,2),
  imported_by       text NOT NULL DEFAULT (auth.jwt() ->> 'sub'),
  imported_by_name  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS statement_imports_month_idx ON public.statement_imports (period_month);

CREATE TABLE IF NOT EXISTS public.statement_lines (
  id             bigserial PRIMARY KEY,
  import_id      uuid NOT NULL REFERENCES public.statement_imports(id) ON DELETE CASCADE,
  txn_date       date,
  merchant       text,
  txn_amount     numeric(14,2) NOT NULL,   -- the purchase (all installments)
  charge_amount  numeric(14,2),            -- what this statement charged
  txn_type       text,                     -- עסקה רגילה / עסקת תשלומים … / סייקל חו"ל
  details        text                      -- e.g. installment 1 of 6
);
CREATE INDEX IF NOT EXISTS statement_lines_import_idx ON public.statement_lines (import_id);

ALTER TABLE public.statement_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.statement_lines   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.statement_imports FROM anon;
REVOKE ALL ON public.statement_lines   FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.statement_imports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.statement_lines   TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.statement_lines_id_seq TO authenticated;

DROP POLICY IF EXISTS statement_imports_books ON public.statement_imports;
CREATE POLICY statement_imports_books ON public.statement_imports
  FOR ALL TO authenticated
  USING (public.is_admin() OR public.is_bookkeeper())
  WITH CHECK (public.is_admin() OR public.is_bookkeeper());

DROP POLICY IF EXISTS statement_lines_books ON public.statement_lines;
CREATE POLICY statement_lines_books ON public.statement_lines
  FOR ALL TO authenticated
  USING (public.is_admin() OR public.is_bookkeeper())
  WITH CHECK (public.is_admin() OR public.is_bookkeeper());
