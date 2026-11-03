-- =============================================================================
-- MFlow sells → packed_stock in ONE transaction: claim, then apply.
--
-- Why: stock-update / mflow_sync_sells applied the packed_stock deltas first
-- and inserted the mflow_sell_events dedupe rows afterwards, in a separate
-- request whose failure was only console-logged. Two overlapping syncs (cron +
-- a manual run, or a run that outlived the next tick) both saw the same sells
-- as new and both deducted them; a failed insert left the sells unrecorded so
-- the next run deducted them again. Either way real bags vanished from stock.
--
-- apply_mflow_sells does it in the opposite order inside one transaction:
--   1. lock every product the batch touches (FOR UPDATE, in id order);
--   2. sells touching a product that no longer exists are left out entirely
--      (not recorded, nothing applied) so they retry once the mapping is fixed;
--   3. INSERT the event rows ON CONFLICT DO NOTHING — a concurrent run that
--      already recorded a sell wins, and that sell is simply not ours;
--   4. apply the net delta of ONLY the rows this call inserted, through the
--      existing apply_packed_stock_delta (clamp at 0; units_lost is reported
--      here as a positive count — apply_packed_stock_delta returns it signed);
--   5. write the inventory_adjustments audit row per product.
-- Any error rolls the whole thing back, claims included, so nothing is ever
-- recorded without its stock movement or moved without being recorded.
--
-- p_sells: [{mflow_sell_id, type, status, is_return, source, transaction_date,
--            coffee_delta: {"<product_id>": signed_qty, ...}}, ...]
-- Returns: {claimed: [ids], already_recorded: n, skipped_missing_product: [ids],
--           failed_products: [product ids], adjustments: [{cf_product, delta,
--           packed_before, packed_after, units_lost}]}
--
-- Service role only. Idempotent (CREATE OR REPLACE, REVOKE/GRANT). Additive.
-- =============================================================================

CREATE OR REPLACE FUNCTION apply_mflow_sells(
  p_sells jsonb,
  p_note  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_missing  integer[];
  v_claimed  bigint[];
  v_skipped  bigint[];
  v_total    integer;
  v_adj      jsonb := '[]'::jsonb;
  r          record;
  d          record;
BEGIN
  IF p_sells IS NULL OR jsonb_typeof(p_sells) <> 'array' THEN
    RAISE EXCEPTION 'apply_mflow_sells: p_sells must be a JSON array' USING ERRCODE = '22023';
  END IF;
  v_total := jsonb_array_length(p_sells);

  CREATE TEMP TABLE IF NOT EXISTS _mflow_in (
    mflow_sell_id bigint PRIMARY KEY, type text, status text, is_return boolean,
    source text, transaction_date timestamptz, coffee_delta jsonb
  ) ON COMMIT DROP;
  TRUNCATE _mflow_in;

  INSERT INTO _mflow_in
  SELECT DISTINCT ON ((e->>'mflow_sell_id')::bigint)
         (e->>'mflow_sell_id')::bigint, e->>'type', e->>'status',
         COALESCE((e->>'is_return')::boolean, false), e->>'source',
         NULLIF(e->>'transaction_date', '')::timestamptz,
         COALESCE(e->'coffee_delta', '{}'::jsonb)
    FROM jsonb_array_elements(p_sells) e
   WHERE e ? 'mflow_sell_id';

  -- 1. Lock every touched product, in id order (no deadlock between runs).
  PERFORM 1 FROM products
   WHERE id IN (SELECT DISTINCT k::integer FROM _mflow_in, jsonb_object_keys(coffee_delta) k)
   ORDER BY id
   FOR UPDATE;

  -- 2. Products that don't exist: their sells are left out entirely.
  SELECT COALESCE(array_agg(DISTINCT k::integer), '{}') INTO v_missing
    FROM _mflow_in, jsonb_object_keys(coffee_delta) k
   WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = k::integer);

  SELECT COALESCE(array_agg(i.mflow_sell_id ORDER BY i.mflow_sell_id), '{}') INTO v_skipped
    FROM _mflow_in i
   WHERE EXISTS (SELECT 1 FROM jsonb_object_keys(i.coffee_delta) k WHERE k::integer = ANY (v_missing));
  DELETE FROM _mflow_in WHERE mflow_sell_id = ANY (v_skipped);

  -- 3. Claim. A row another run already inserted is not ours.
  WITH ins AS (
    INSERT INTO mflow_sell_events
           (mflow_sell_id, type, status, is_return, source, transaction_date, coffee_delta, applied)
    SELECT mflow_sell_id, type, status, is_return, source, transaction_date, coffee_delta, true
      FROM _mflow_in
    ON CONFLICT (mflow_sell_id) DO NOTHING
    RETURNING mflow_sell_id
  )
  SELECT COALESCE(array_agg(mflow_sell_id ORDER BY mflow_sell_id), '{}') INTO v_claimed FROM ins;

  -- 4 + 5. Net delta of the claimed rows only, per product.
  FOR d IN
    SELECT k::integer AS pid, round(sum((i.coffee_delta->>k)::numeric))::integer AS dq
      FROM _mflow_in i, jsonb_object_keys(i.coffee_delta) k
     WHERE i.mflow_sell_id = ANY (v_claimed)
     GROUP BY k::integer
     ORDER BY k::integer
  LOOP
    CONTINUE WHEN d.dq = 0;
    SELECT * INTO r FROM apply_packed_stock_delta(d.pid, d.dq);
    INSERT INTO inventory_adjustments
           (source, sku, description, qty_delta, packed_before, packed_after, applied, note)
    SELECT 'mflow_sell', COALESCE(p.sku, p.id::text), p.name, d.dq, r.packed_before, r.packed_after, true,
           COALESCE(p_note, 'mflow sells sync')
             || CASE WHEN r.units_lost <> 0 THEN ' — clamped at 0, ' || abs(r.units_lost) || ' unit(s) not deducted' ELSE '' END
      FROM products p WHERE p.id = d.pid;
    v_adj := v_adj || jsonb_build_object(
      'cf_product', d.pid, 'delta', d.dq,
      'packed_before', r.packed_before, 'packed_after', r.packed_after, 'units_lost', abs(r.units_lost));
  END LOOP;

  RETURN jsonb_build_object(
    'claimed',                 to_jsonb(v_claimed),
    'already_recorded',        v_total - cardinality(v_skipped) - cardinality(v_claimed),
    'skipped_missing_product', to_jsonb(v_skipped),
    'failed_products',         to_jsonb(v_missing),
    'adjustments',             v_adj
  );
END;
$$;

REVOKE ALL ON FUNCTION apply_mflow_sells(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_mflow_sells(jsonb, text) TO service_role;
