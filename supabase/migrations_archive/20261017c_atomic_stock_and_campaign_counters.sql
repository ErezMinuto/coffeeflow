-- =============================================================================
-- Atomic roasted_stock deltas and campaign stat counters.
--
-- Why: coffee-bot read roasted_stock / packed_stock, computed the new value in
-- JS and wrote it back as an absolute number. Two packing reports (or a packing
-- and a shop-consumption command) for the same origin/profile/product inside
-- that window lost one deduction. resend-webhook did the same for the
-- campaigns open/click/bounce counters, so concurrent webhooks undercounted.
--
-- Each function below re-reads the value under a row lock and writes it in the
-- same transaction. packed_stock already has apply_packed_stock_delta
-- (20260816); coffee-bot now uses that one too.
--
-- Also: apply_packed_stock_delta was executable by anon/authenticated (Supabase
-- grants EXECUTE on new public functions to both by default). It is SECURITY
-- DEFINER, so anyone with the anon key could change packed_stock. Only edge
-- functions (service role) call it; revoke the rest.
--
-- Idempotent (CREATE OR REPLACE, REVOKE/GRANT) and additive. Safe to re-run.
-- =============================================================================

-- Roasted stock on origins (sourceType 'origin') or roast_profiles ('profile').
--
-- p_require_sufficient = false (packing): the bags were physically packed, so
--   the deduction always applies, floored at 0 (same as the old JS).
-- p_require_sufficient = true (shop consumption): refuse when the stock does not
--   cover it; nothing is written and applied = false.
--
-- Values are rounded to 3 decimals like the old JS toFixed(3).
-- Returns zero rows when the source does not exist.
CREATE OR REPLACE FUNCTION apply_roasted_stock_delta(
  p_source_type        TEXT,
  p_source_id          BIGINT,
  p_delta_kg           NUMERIC,
  p_require_sufficient BOOLEAN DEFAULT false
)
RETURNS TABLE (stock_before NUMERIC, stock_after NUMERIC, applied BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before NUMERIC;
  v_after  NUMERIC;
BEGIN
  IF p_source_type = 'origin' THEN
    SELECT COALESCE(roasted_stock, 0) INTO v_before FROM origins WHERE id = p_source_id FOR UPDATE;
  ELSIF p_source_type = 'profile' THEN
    SELECT COALESCE(roasted_stock, 0) INTO v_before FROM roast_profiles WHERE id = p_source_id FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'apply_roasted_stock_delta: unknown source type %', p_source_type
      USING ERRCODE = '22023';
  END IF;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_require_sufficient AND v_before + p_delta_kg < 0 THEN
    RETURN QUERY SELECT v_before, v_before, false;
    RETURN;
  END IF;

  v_after := round(GREATEST(0, v_before + p_delta_kg), 3);

  IF p_source_type = 'origin' THEN
    UPDATE origins SET roasted_stock = v_after WHERE id = p_source_id;
  ELSE
    UPDATE roast_profiles SET roasted_stock = v_after WHERE id = p_source_id;
  END IF;

  RETURN QUERY SELECT v_before, v_after, true;
END;
$$;

-- +1 on one of the campaigns stat columns. The column is whitelisted, never
-- interpolated from caller input unchecked. Returns the new value, or NULL
-- when the campaign does not exist.
CREATE OR REPLACE FUNCTION increment_campaign_stat(
  p_campaign_id BIGINT,
  p_column      TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new INTEGER;
BEGIN
  IF p_column NOT IN ('open_count', 'click_count', 'bounce_count') THEN
    RAISE EXCEPTION 'increment_campaign_stat: column % not allowed', p_column
      USING ERRCODE = '22023';
  END IF;

  EXECUTE format(
    'UPDATE campaigns SET %1$I = COALESCE(%1$I, 0) + 1 WHERE id = $1 RETURNING %1$I',
    p_column
  ) INTO v_new USING p_campaign_id;

  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION apply_roasted_stock_delta(TEXT, BIGINT, NUMERIC, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION increment_campaign_stat(BIGINT, TEXT)                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION apply_packed_stock_delta(INTEGER, INTEGER)                FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION apply_roasted_stock_delta(TEXT, BIGINT, NUMERIC, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION increment_campaign_stat(BIGINT, TEXT)                     TO service_role;
GRANT EXECUTE ON FUNCTION apply_packed_stock_delta(INTEGER, INTEGER)                TO service_role;
