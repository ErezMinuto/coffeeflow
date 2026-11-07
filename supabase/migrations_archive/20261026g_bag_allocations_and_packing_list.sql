-- CoffeeFlow — allocate packed bags to B2B customers + 7-day store packing list.
--
-- Replaces the reservation-by-order-status from 20261026f. B2B coffee is not a
-- roasting order: bags already packed are simply set aside for a customer.
-- An 'allocated' row takes its bags out of store stock (packed_stock − allocated,
-- src/lib/reservedStock.js); 'delivered' releases them, and the MFlow invoice
-- decrements packed_stock as before, so nothing is deducted twice.
--
-- pending_orders.customer_id from 20261026f stays (unused, harmless). Nothing
-- here changes or deletes existing data.
--
-- Access: known staff only (is_staff()), no anon — same as pending_orders.

-- ── 1. Allocations ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bag_allocations (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,         -- who allocated (useSupabaseData.insert stamps it); not a filter
  customer_id   BIGINT NOT NULL REFERENCES public.b2b_customers(id),
  product_id    BIGINT NOT NULL REFERENCES public.products(id),
  bags          INTEGER NOT NULL CHECK (bags > 0),
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'allocated' CHECK (status IN ('allocated','delivered')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bag_allocations_open_idx ON public.bag_allocations (product_id) WHERE status = 'allocated';

ALTER TABLE public.bag_allocations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bag_allocations_staff ON public.bag_allocations;
CREATE POLICY bag_allocations_staff ON public.bag_allocations
  FOR ALL TO authenticated USING (public.is_staff()) WITH CHECK (public.is_staff());
REVOKE ALL ON public.bag_allocations FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bag_allocations TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.bag_allocations_id_seq TO authenticated;

-- ── 2. Shared app settings (first use: WhatsApp number for the packing list) ──
CREATE TABLE IF NOT EXISTS public.app_settings (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,           -- last writer; not a filter
  key         TEXT NOT NULL UNIQUE,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_settings_staff ON public.app_settings;
CREATE POLICY app_settings_staff ON public.app_settings
  FOR ALL TO authenticated USING (public.is_staff()) WITH CHECK (public.is_staff());
REVOKE ALL ON public.app_settings FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_settings TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.app_settings_id_seq TO authenticated;

-- ── 3. Store bag sales per product ─────────────────────────────────────
-- mflow_sell_lines is admin-only; the packing list needs just one number per
-- product, so this exposes that and nothing else. Store = café (pos) + website
-- (ecosite). back_office (B2B) is left out: those bags are allocated, not
-- shelf demand. Returns carry their own negative quantity.
CREATE OR REPLACE FUNCTION public.store_bags_sold(p_days INTEGER DEFAULT 28)
RETURNS TABLE (product_id BIGINT, bags NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_staff() AND coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'staff only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT l.cf_product_id, sum(l.quantity)
      FROM public.mflow_sell_lines l
     WHERE l.cf_product_id IS NOT NULL
       AND l.channel IN ('pos','ecosite')
       AND l.status_class IN ('counted','return')
       AND l.transaction_date >= now() - make_interval(days => greatest(1, least(p_days, 365)))
     GROUP BY l.cf_product_id;
END;
$$;
REVOKE ALL ON FUNCTION public.store_bags_sold(INTEGER) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.store_bags_sold(INTEGER) TO authenticated, service_role;

-- ── Verify ─────────────────────────────────────────────────────────────
--   SELECT has_table_privilege('anon','public.bag_allocations','SELECT');   -- false
--   SELECT * FROM public.store_bags_sold(28) ORDER BY bags DESC;            -- as service role
