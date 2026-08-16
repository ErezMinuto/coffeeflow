-- =============================================================================
-- Atomic packed_stock delta.
--
-- Why: the MFlow sells sync (stock-update / mflow_sync_sells) loaded every
-- product's packed_stock into memory BEFORE paging through the MFlow API, then
-- wrote back `snapshot + delta` as an absolute value. That read-to-write window
-- spans every MFlow request, so any packing recorded by coffee-bot in between
-- was silently overwritten and the packed bags vanished.
--
-- This function re-reads packed_stock under a row lock and applies the delta in
-- the same statement, so a concurrent packing is preserved rather than clobbered.
--
-- Clamping at 0 is kept (no negative inventory), but the units lost to the clamp
-- are now RETURNED instead of silently discarded, so the caller can record them.
--
-- Returns zero rows when the product does not exist — the caller treats that as
-- a failure and leaves the sell unrecorded so it retries.
--
-- Applied directly to prod via the management API (CLI migrations are drifted).
-- Idempotent (CREATE OR REPLACE) and additive. Safe to re-run.
-- =============================================================================

CREATE OR REPLACE FUNCTION apply_packed_stock_delta(
  p_product_id INTEGER,
  p_delta      INTEGER
)
RETURNS TABLE (packed_before INTEGER, packed_after INTEGER, units_lost INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before INTEGER;
  v_after  INTEGER;
BEGIN
  SELECT packed_stock INTO v_before
    FROM products
   WHERE id = p_product_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_after := GREATEST(0, v_before + p_delta);

  UPDATE products SET packed_stock = v_after WHERE id = p_product_id;

  RETURN QUERY SELECT v_before, v_after, (v_before + p_delta) - v_after;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_packed_stock_delta(INTEGER, INTEGER) TO service_role;

-- Verify:
--   SELECT * FROM apply_packed_stock_delta(<product_id>, 0);  -- no-op, returns before=after
