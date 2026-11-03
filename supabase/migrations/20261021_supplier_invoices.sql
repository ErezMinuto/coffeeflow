-- =============================================================================
-- Supplier invoices (חשבוניות ספקים) — phase 1: archive + monthly download
--
-- Staff photograph / scan / upload every invoice Minuto receives for a payment
-- to a supplier. The browser shrinks the file first; the supplier-invoices
-- edge function stores it in the private `supplier-invoices` bucket, reads the
-- fields with Claude, and inserts one row here. The uploader checks the fields
-- and confirms. The bookkeeper downloads a month as a ZIP.
--
-- WHO SEES WHAT
--   admin       everything; may edit any row
--   bookkeeper  NEW ROLE — every invoice, read only, and NOTHING else in
--               CoffeeFlow (see is_staff() below)
--   other staff (employee, schedule_manager) — their own uploads; may edit
--               them until confirmed
--   anon / signed-in strangers — nothing
-- INSERT and DELETE happen only in the edge function (service role).
--
-- Phase 2 (bookkeeper's Hashavshevet export) and phase 3 (card + bank
-- statements) add their own tables; booked_at is reserved for phase 2.
-- =============================================================================

-- ── 1. Roles ────────────────────────────────────────────────────────────────
-- The bookkeeper gets a user_roles row so the app knows who they are, but a
-- user_roles row is exactly what is_staff() tests — and is_staff() opens the
-- operational tables (employees, attendance, orders …) and every staff edge
-- function. So is_staff() now means "a team member", and the bookkeeper is not
-- one. Same body as 20261017b otherwise.
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = (auth.jwt() ->> 'sub')
       AND role <> 'bookkeeper'
  );
$$;
REVOKE ALL ON FUNCTION public.is_staff() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_bookkeeper()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = (auth.jwt() ->> 'sub')
       AND role = 'bookkeeper'
  );
$$;
REVOKE ALL ON FUNCTION public.is_bookkeeper() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_bookkeeper() TO authenticated, service_role;

-- ── 2. Table ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.supplier_invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- what the document says (read by Claude, checked by the uploader)
  supplier_name      text,
  supplier_tax_id    text,             -- ח.פ / ע.מ, digits only
  invoice_number     text,
  doc_type           text NOT NULL DEFAULT 'tax_invoice'
                     CHECK (doc_type IN ('tax_invoice', 'tax_invoice_receipt', 'receipt',
                                         'credit_note', 'transaction_invoice', 'other')),
  invoice_date       date,
  amount_before_vat  numeric(12,2),
  vat_amount         numeric(12,2),
  total_incl_vat     numeric(12,2),
  currency           text NOT NULL DEFAULT 'ILS',
  allocation_number  text,             -- מספר הקצאה (חשבוניות ישראל)
  notes              text,

  -- the file
  file_path          text NOT NULL UNIQUE,   -- object name inside the bucket
  file_mime          text NOT NULL,
  file_size          integer NOT NULL,
  file_sha256        text NOT NULL,
  original_filename  text,

  -- workflow
  status             text NOT NULL DEFAULT 'pending_review'
                     CHECK (status IN ('pending_review', 'confirmed')),
  extraction         jsonb,            -- Claude's raw answer, for audit
  uploaded_by        text NOT NULL,    -- Clerk user id
  uploaded_by_name   text,
  confirmed_at       timestamptz,
  booked_at          timestamptz,      -- phase 2: matched in the bookkeeper's file
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- The same file twice is always a mistake.
CREATE UNIQUE INDEX IF NOT EXISTS supplier_invoices_file_sha256_key
  ON public.supplier_invoices (file_sha256);
-- The same invoice photographed twice gives two different files; this finds it.
CREATE INDEX IF NOT EXISTS supplier_invoices_supplier_number_idx
  ON public.supplier_invoices (supplier_tax_id, invoice_number);
CREATE INDEX IF NOT EXISTS supplier_invoices_date_idx
  ON public.supplier_invoices (invoice_date);
CREATE INDEX IF NOT EXISTS supplier_invoices_uploaded_by_idx
  ON public.supplier_invoices (uploaded_by);

CREATE OR REPLACE FUNCTION public.supplier_invoices_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed' THEN
    NEW.confirmed_at := now();
  END IF;
  -- Columns the edge function owns; a client update cannot rewrite them.
  NEW.file_path   := OLD.file_path;
  NEW.file_mime   := OLD.file_mime;
  NEW.file_size   := OLD.file_size;
  NEW.file_sha256 := OLD.file_sha256;
  NEW.uploaded_by := OLD.uploaded_by;
  NEW.extraction  := OLD.extraction;
  NEW.created_at  := OLD.created_at;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS supplier_invoices_touch ON public.supplier_invoices;
CREATE TRIGGER supplier_invoices_touch
  BEFORE UPDATE ON public.supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION public.supplier_invoices_touch();

-- ── 3. Row-level security ───────────────────────────────────────────────────
ALTER TABLE public.supplier_invoices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.supplier_invoices FROM anon;
GRANT SELECT, UPDATE ON public.supplier_invoices TO authenticated;

DROP POLICY IF EXISTS supplier_invoices_select ON public.supplier_invoices;
CREATE POLICY supplier_invoices_select ON public.supplier_invoices
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR public.is_bookkeeper()
    OR (public.is_staff() AND uploaded_by = (auth.jwt() ->> 'sub'))
  );

DROP POLICY IF EXISTS supplier_invoices_update ON public.supplier_invoices;
CREATE POLICY supplier_invoices_update ON public.supplier_invoices
  FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR (public.is_staff() AND uploaded_by = (auth.jwt() ->> 'sub') AND status = 'pending_review')
  )
  WITH CHECK (
    public.is_admin()
    OR (public.is_staff() AND uploaded_by = (auth.jwt() ->> 'sub'))
  );

-- ── 4. Storage ──────────────────────────────────────────────────────────────
-- Private bucket. 10 MB per object is far above a shrunk photo (~200 KB) and
-- leaves room for a supplier's multi-page PDF. Writes and deletes go through
-- the edge function (service role); reads follow the table's visibility.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('supplier-invoices', 'supplier-invoices', false, 10485760,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS supplier_invoices_files_read ON storage.objects;
CREATE POLICY supplier_invoices_files_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'supplier-invoices'
    AND (
      public.is_admin()
      OR public.is_bookkeeper()
      OR EXISTS (
        SELECT 1 FROM public.supplier_invoices si
         WHERE si.file_path = storage.objects.name
           AND si.uploaded_by = (auth.jwt() ->> 'sub')
      )
    )
  );
