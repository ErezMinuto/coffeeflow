-- =============================================================================
-- Supplier invoices — monthly delivery packages to the bookkeeper
--
-- The bookkeeper does not get "the invoices dated in month M"; each month they
-- get EVERY confirmed invoice they have not received yet, whatever its date —
-- a late invoice from two months ago included. So each invoice remembers the
-- package it went out in (delivery_id); NULL = not sent yet.
--
-- create_invoice_delivery(ids) makes the package and marks its invoices in one
-- transaction (the page calls it only after the ZIP was built). It skips any
-- id that is not confirmed or was already sent, so two people clicking at once
-- cannot send an invoice twice. Old packages stay downloadable.
--
-- Access: admin and bookkeeper (the bookkeeper cannot UPDATE supplier_invoices,
-- hence SECURITY DEFINER with its own role check). A client UPDATE cannot touch
-- delivery_id (trigger), only this function can.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.invoice_deliveries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_count      integer NOT NULL,
  total_before_vat   numeric(14,2),
  total_incl_vat     numeric(14,2),
  oldest_invoice     date,
  newest_invoice     date,
  created_by         text NOT NULL,
  created_by_name    text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.supplier_invoices
  ADD COLUMN IF NOT EXISTS delivery_id uuid REFERENCES public.invoice_deliveries(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS supplier_invoices_undelivered_idx
  ON public.supplier_invoices (invoice_date) WHERE status = 'confirmed' AND delivery_id IS NULL;
CREATE INDEX IF NOT EXISTS supplier_invoices_delivery_idx ON public.supplier_invoices (delivery_id);

ALTER TABLE public.invoice_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_deliveries FROM anon;
GRANT SELECT ON public.invoice_deliveries TO authenticated;
DROP POLICY IF EXISTS invoice_deliveries_read ON public.invoice_deliveries;
CREATE POLICY invoice_deliveries_read ON public.invoice_deliveries
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_bookkeeper());

-- Same trigger as 20261021, plus: a client cannot set or clear delivery_id.
-- current_user is 'authenticated' for a client; inside the SECURITY DEFINER
-- function below it is the owner, so the function's write goes through.
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
  IF current_user IN ('authenticated', 'anon') THEN
    NEW.delivery_id := OLD.delivery_id;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.create_invoice_delivery(p_invoice_ids uuid[], p_created_by_name text DEFAULT NULL)
RETURNS public.invoice_deliveries
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.invoice_deliveries;
BEGIN
  IF NOT (public.is_admin() OR public.is_bookkeeper()) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.invoice_deliveries (invoice_count, created_by, created_by_name)
  VALUES (0, auth.jwt() ->> 'sub', p_created_by_name)
  RETURNING * INTO d;

  UPDATE public.supplier_invoices
     SET delivery_id = d.id
   WHERE id = ANY (p_invoice_ids)
     AND status = 'confirmed'
     AND delivery_id IS NULL;

  UPDATE public.invoice_deliveries v
     SET invoice_count    = s.n,
         total_before_vat = s.before,
         total_incl_vat   = s.total,
         oldest_invoice   = s.oldest,
         newest_invoice   = s.newest
    FROM (SELECT count(*) n, sum(amount_before_vat) before, sum(total_incl_vat) total,
                 min(invoice_date) oldest, max(invoice_date) newest
            FROM public.supplier_invoices WHERE delivery_id = d.id) s
   WHERE v.id = d.id
  RETURNING v.* INTO d;

  IF d.invoice_count = 0 THEN
    DELETE FROM public.invoice_deliveries WHERE id = d.id;
    RAISE EXCEPTION 'no invoices to send (already sent or not confirmed)' USING ERRCODE = 'P0002';
  END IF;
  RETURN d;
END $$;
REVOKE ALL ON FUNCTION public.create_invoice_delivery(uuid[], text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_delivery(uuid[], text) TO authenticated;
