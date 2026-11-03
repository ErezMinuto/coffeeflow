-- CoffeeFlow — B2B customers as a proper list, linked from pending orders.
--
-- Until now an order's customer was free text (pending_orders.customer_name),
-- so the same café could appear under three spellings. b2b_customers holds the
-- name and contact details; pending_orders.customer_id points at it.
--
-- customer_name stays on pending_orders and is still written on every insert
-- (like product_name next to product_id): old orders keep reading correctly,
-- and a customer renamed later doesn't rewrite history.
--
-- Why it matters for stock: an order in status 'ready' reserves its bags, and
-- the app treats packed_stock − reserved as store stock (src/lib/reservedStock.js).
--
-- Access mirrors pending_orders after 20261017b: known staff only, no anon.
-- Additive only — no data is changed or deleted.

CREATE TABLE IF NOT EXISTS public.b2b_customers (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,         -- who added it (useSupabaseData.insert stamps it); not a filter
  name          TEXT NOT NULL,
  contact_name  TEXT,
  phone         TEXT,
  email         TEXT,
  notes         TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS b2b_customers_name_key ON public.b2b_customers (lower(btrim(name)));

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES public.b2b_customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS pending_orders_customer_id_idx ON public.pending_orders (customer_id);

ALTER TABLE public.b2b_customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS b2b_customers_staff ON public.b2b_customers;
CREATE POLICY b2b_customers_staff ON public.b2b_customers
  FOR ALL TO authenticated USING (public.is_staff()) WITH CHECK (public.is_staff());

REVOKE ALL ON public.b2b_customers FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.b2b_customers TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.b2b_customers_id_seq TO authenticated;

-- ── Verify ─────────────────────────────────────────────────────────────
--   SELECT policyname, roles, cmd FROM pg_policies WHERE tablename = 'b2b_customers';
--   SELECT has_table_privilege('anon', 'public.b2b_customers', 'SELECT');  -- false
