-- Website sales back-order; store sales past an empty shelf raise an alert.
--
-- How Minuto actually works:
--   • WEBSITE: a coffee is never out of stock. When an order comes in with no
--     packed bag, it is roasted and packed AFTER the sale and shipped then.
--   • STORE (POS, and back-office invoices): a bag can only be sold if it is
--     physically on the shelf. If the system shows none, someone packed and
--     did not log it.
--
-- Before this migration every MFlow sale was summed per product and the sum
-- was clamped at 0. A website order at 0 stock was thrown away, so when the
-- bag was later packed and logged it appeared as shelf stock although it had
-- already shipped. That phantom bag then hid the next real unlogged packing.
--
-- New model, one signed number per product (products.packed_stock):
--   > 0  bags on the shelf
--   < 0  bags owed to website orders (packing pays them off first, for free,
--        because packing simply adds to the number)
--
-- Sells are applied ONE AT A TIME in transaction order, because whether a
-- store sale hit an empty shelf depends on what came before it:
--   • website sale  → subtract, may go negative (back-order)
--   • store sale    → subtract, but never below LEAST(before, 0). Whatever
--                     the floor swallowed is a bag that existed but was never
--                     logged → recorded in stock_unlogged_alerts (one row per
--                     product per Israel day) for stock-update to email.
--   • any return    → add
--
-- apply_packed_stock_delta (coffee-bot packing, +bags) no longer floors a
-- positive delta at 0, which would have erased the back-order.

ALTER TABLE public.mflow_sell_events ADD COLUMN IF NOT EXISTS channel text;
COMMENT ON COLUMN public.mflow_sell_events.channel IS
  'web = EcoSite/WooCommerce order (may back-order); store = POS / back office (must come off the shelf).';

COMMENT ON COLUMN public.products.packed_stock IS
  'Signed. >0 = packed bags on the shelf. <0 = bags owed to website orders (sold before they were packed). See migration 20261109120000.';

-- ── One row per product per day where store sales outran the shelf ──────────
CREATE TABLE IF NOT EXISTS public.stock_unlogged_alerts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id      integer NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  alert_date      date    NOT NULL,                 -- Asia/Jerusalem calendar day
  units_unlogged  integer NOT NULL CHECK (units_unlogged > 0),
  sell_ids        bigint[] NOT NULL DEFAULT '{}',
  first_sell_at   timestamptz,
  last_sell_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- NULL until the owner email went out; stock-update retries until it does.
  emailed_at      timestamptz,
  UNIQUE (product_id, alert_date)
);
COMMENT ON TABLE public.stock_unlogged_alerts IS
  'Store/back-office sales of bags the system did not have: someone packed without logging. Written by apply_mflow_sells, emailed once per product per day by stock-update.';

ALTER TABLE public.stock_unlogged_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_unlogged_alerts FROM anon, authenticated;
GRANT ALL ON public.stock_unlogged_alerts TO service_role;

-- ── Packing: a positive delta is never floored ──────────────────────────────
-- Negative deltas keep the old "don't invent a debt" behaviour, but the floor
-- is LEAST(before, 0) so an existing back-order is never erased either.
CREATE OR REPLACE FUNCTION public.apply_packed_stock_delta(p_product_id integer, p_delta integer)
RETURNS TABLE(packed_before integer, packed_after integer, units_lost integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_before integer;
  v_after  integer;
BEGIN
  SELECT packed_stock INTO v_before FROM products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_delta >= 0 THEN
    v_after := v_before + p_delta;
  ELSE
    v_after := GREATEST(LEAST(v_before, 0), v_before + p_delta);
  END IF;

  UPDATE products SET packed_stock = v_after WHERE id = p_product_id;
  RETURN QUERY SELECT v_before, v_after, (v_before + p_delta) - v_after;
END;
$$;

-- ── MFlow sells, per sell, in order, by channel ─────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_mflow_sells(p_sells jsonb, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_missing  integer[];
  v_claimed  bigint[];
  v_skipped  bigint[];
  v_total    integer;
  v_adj      jsonb := '[]'::jsonb;
  v_unlogged jsonb := '[]'::jsonb;
  v_before   integer;
  v_after    integer;
  v_lost     integer;
  v_day      date;
  s          record;
  k          text;
  dq         integer;
  a          record;
BEGIN
  IF p_sells IS NULL OR jsonb_typeof(p_sells) <> 'array' THEN
    RAISE EXCEPTION 'apply_mflow_sells: p_sells must be a JSON array' USING ERRCODE = '22023';
  END IF;
  v_total := jsonb_array_length(p_sells);

  CREATE TEMP TABLE IF NOT EXISTS _mflow_in (
    mflow_sell_id bigint PRIMARY KEY, type text, status text, is_return boolean,
    source text, channel text, transaction_date timestamptz, coffee_delta jsonb
  ) ON COMMIT DROP;
  TRUNCATE _mflow_in;

  -- Per-product, per-call tally (same response shape as before + channel split).
  CREATE TEMP TABLE IF NOT EXISTS _mflow_adj (
    pid integer PRIMARY KEY, delta integer, web_delta integer, store_delta integer,
    packed_before integer, packed_after integer, units_unlogged integer
  ) ON COMMIT DROP;
  TRUNCATE _mflow_adj;

  INSERT INTO _mflow_in
  SELECT DISTINCT ON ((e->>'mflow_sell_id')::bigint)
         (e->>'mflow_sell_id')::bigint, e->>'type', e->>'status',
         COALESCE((e->>'is_return')::boolean, false), e->>'source',
         -- Anything not positively known to be a website order must come off
         -- the shelf: that is the side that raises alerts, never hides them.
         CASE WHEN e->>'channel' = 'web' THEN 'web' ELSE 'store' END,
         NULLIF(e->>'transaction_date', '')::timestamptz,
         COALESCE(e->'coffee_delta', '{}'::jsonb)
    FROM jsonb_array_elements(p_sells) e
   WHERE e ? 'mflow_sell_id';

  -- 1. Lock every touched product, in id order (no deadlock between runs).
  PERFORM 1 FROM products
   WHERE id IN (SELECT DISTINCT kk::integer FROM _mflow_in, jsonb_object_keys(coffee_delta) kk)
   ORDER BY id
   FOR UPDATE;

  -- 2. Products that don't exist: their sells are left out entirely.
  SELECT COALESCE(array_agg(DISTINCT kk::integer), '{}') INTO v_missing
    FROM _mflow_in, jsonb_object_keys(coffee_delta) kk
   WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = kk::integer);

  SELECT COALESCE(array_agg(i.mflow_sell_id ORDER BY i.mflow_sell_id), '{}') INTO v_skipped
    FROM _mflow_in i
   WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(i.coffee_delta) kk WHERE kk::integer = ANY (v_missing));
  DELETE FROM _mflow_in WHERE mflow_sell_id = ANY (v_skipped);

  -- 3. Claim. A row another run already inserted is not ours.
  WITH ins AS (
    INSERT INTO mflow_sell_events
           (mflow_sell_id, type, status, is_return, source, channel, transaction_date, coffee_delta, applied)
    SELECT mflow_sell_id, type, status, is_return, source, channel, transaction_date, coffee_delta, true
      FROM _mflow_in
    ON CONFLICT (mflow_sell_id) DO NOTHING
    RETURNING mflow_sell_id
  )
  SELECT COALESCE(array_agg(mflow_sell_id ORDER BY mflow_sell_id), '{}') INTO v_claimed FROM ins;

  -- 4. Apply each claimed sell in the order it happened.
  FOR s IN
    SELECT * FROM _mflow_in
     WHERE mflow_sell_id = ANY (v_claimed)
     ORDER BY transaction_date NULLS LAST, mflow_sell_id
  LOOP
    FOR k IN SELECT jsonb_object_keys(s.coffee_delta) ORDER BY 1 LOOP
      dq := round((s.coffee_delta->>k)::numeric)::integer;
      CONTINUE WHEN dq = 0;

      SELECT packed_stock INTO v_before FROM products WHERE id = k::integer;

      IF dq > 0 OR s.channel = 'web' THEN
        v_after := v_before + dq;                       -- returns; website back-order
      ELSE
        v_after := GREATEST(LEAST(v_before, 0), v_before + dq);
      END IF;
      v_lost := v_after - (v_before + dq);              -- > 0 only for a store sale past the shelf

      UPDATE products SET packed_stock = v_after WHERE id = k::integer;

      INSERT INTO inventory_adjustments
             (source, sku, description, qty_delta, packed_before, packed_after, applied, note)
      SELECT 'mflow_sell', COALESCE(p.sku, p.id::text), p.name, dq, v_before, v_after, true,
             COALESCE(p_note, 'mflow sells sync') || ' — sell ' || s.mflow_sell_id || ' (' || s.channel || ')'
               || CASE WHEN v_lost > 0 THEN ', ' || v_lost || ' bag(s) sold that were never logged as packed'
                       WHEN s.channel = 'web' AND v_after < 0 AND dq < 0 THEN ', back-ordered: ' || (-v_after) || ' bag(s) owed to website orders'
                       ELSE '' END
        FROM products p WHERE p.id = k::integer;

      INSERT INTO _mflow_adj AS t (pid, delta, web_delta, store_delta, packed_before, packed_after, units_unlogged)
      VALUES (k::integer, dq,
              CASE WHEN s.channel = 'web' THEN dq ELSE 0 END,
              CASE WHEN s.channel = 'web' THEN 0 ELSE dq END,
              v_before, v_after, v_lost)
      ON CONFLICT (pid) DO UPDATE SET
        delta          = t.delta + EXCLUDED.delta,
        web_delta      = t.web_delta + EXCLUDED.web_delta,
        store_delta    = t.store_delta + EXCLUDED.store_delta,
        packed_after   = EXCLUDED.packed_after,
        units_unlogged = t.units_unlogged + EXCLUDED.units_unlogged;

      IF v_lost > 0 THEN
        v_day := (COALESCE(s.transaction_date, now()) AT TIME ZONE 'Asia/Jerusalem')::date;
        INSERT INTO stock_unlogged_alerts AS u
               (product_id, alert_date, units_unlogged, sell_ids, first_sell_at, last_sell_at)
        VALUES (k::integer, v_day, v_lost, ARRAY[s.mflow_sell_id], s.transaction_date, s.transaction_date)
        ON CONFLICT (product_id, alert_date) DO UPDATE SET
          units_unlogged = u.units_unlogged + EXCLUDED.units_unlogged,
          sell_ids       = u.sell_ids || EXCLUDED.sell_ids,
          last_sell_at   = GREATEST(u.last_sell_at, EXCLUDED.last_sell_at),
          updated_at     = now();
        v_unlogged := v_unlogged || jsonb_build_object(
          'cf_product', k::integer, 'mflow_sell_id', s.mflow_sell_id, 'units', v_lost,
          'packed_before', v_before, 'transaction_date', s.transaction_date);
      END IF;
    END LOOP;
  END LOOP;

  FOR a IN SELECT * FROM _mflow_adj ORDER BY pid LOOP
    v_adj := v_adj || jsonb_build_object(
      'cf_product', a.pid, 'delta', a.delta, 'web_delta', a.web_delta, 'store_delta', a.store_delta,
      'packed_before', a.packed_before, 'packed_after', a.packed_after,
      -- Kept under the old name so existing callers keep reading it.
      'units_lost', a.units_unlogged);
  END LOOP;

  RETURN jsonb_build_object(
    'claimed',                 to_jsonb(v_claimed),
    'already_recorded',        v_total - cardinality(v_skipped) - cardinality(v_claimed),
    'skipped_missing_product', to_jsonb(v_skipped),
    'failed_products',         to_jsonb(v_missing),
    'adjustments',             v_adj,
    'unlogged',                v_unlogged
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_mflow_sells(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_mflow_sells(jsonb, text) TO service_role;
REVOKE ALL ON FUNCTION public.apply_packed_stock_delta(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_packed_stock_delta(integer, integer) TO service_role;
