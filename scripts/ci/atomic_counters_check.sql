-- Checks the atomic stock / counter RPCs (migration 20261017c) against real rows.
-- Always ends in RAISE EXCEPTION, so every write is rolled back. Prints only
-- pass/fail words, never stock values or amounts.
--
-- Dry-run before applying the migration (nothing persists):
--   BEGIN; <migration file>; <this file>; ROLLBACK;
-- After applying, run this file on its own.
DO $t$
DECLARE
  r       jsonb := '{}'::jsonb;
  o_id    bigint; p_id bigint; prod_id integer; c_id bigint;
  b numeric; a numeric; ok boolean;
  pb integer; pa integer;
  n0 integer; n1 integer;
  who text;
BEGIN
  SELECT id INTO o_id    FROM origins        ORDER BY id LIMIT 1;
  SELECT id INTO p_id    FROM roast_profiles ORDER BY id LIMIT 1;
  SELECT id INTO prod_id FROM products       ORDER BY id LIMIT 1;
  SELECT id INTO c_id    FROM campaigns      ORDER BY id LIMIT 1;

  -- Packing: delta applied to the current value, floored at 0.
  UPDATE origins SET roasted_stock = 1.5 WHERE id = o_id;
  SELECT stock_before, stock_after, applied INTO b, a, ok FROM apply_roasted_stock_delta('origin', o_id, -0.3333);
  r := r || jsonb_build_object('origin_delta', CASE WHEN b = 1.5 AND a = 1.167 AND ok
    AND (SELECT roasted_stock FROM origins WHERE id = o_id) = 1.167 THEN 'pass' ELSE 'FAIL' END);
  SELECT stock_after, applied INTO a, ok FROM apply_roasted_stock_delta('origin', o_id, -5);
  r := r || jsonb_build_object('origin_floor_0', CASE WHEN a = 0 AND ok THEN 'pass' ELSE 'FAIL' END);

  -- Shop: refused when short, nothing written; applied when it fits.
  UPDATE roast_profiles SET roasted_stock = 0.5 WHERE id = p_id;
  SELECT stock_after, applied INTO a, ok FROM apply_roasted_stock_delta('profile', p_id, -0.6, true);
  r := r || jsonb_build_object('profile_refuse_short', CASE WHEN NOT ok AND a = 0.5
    AND (SELECT roasted_stock FROM roast_profiles WHERE id = p_id) = 0.5 THEN 'pass' ELSE 'FAIL' END);
  SELECT stock_after, applied INTO a, ok FROM apply_roasted_stock_delta('profile', p_id, -0.2, true);
  r := r || jsonb_build_object('profile_apply_fits', CASE WHEN ok AND a = 0.3 THEN 'pass' ELSE 'FAIL' END);

  -- Unknown source type / missing row.
  BEGIN
    PERFORM apply_roasted_stock_delta('product', o_id, -1);
    r := r || '{"bad_source_type":"FAIL"}';
  EXCEPTION WHEN invalid_parameter_value THEN r := r || '{"bad_source_type":"pass"}';
  END;
  r := r || jsonb_build_object('missing_row', CASE WHEN NOT EXISTS (
    SELECT 1 FROM apply_roasted_stock_delta('origin', -1, -1)) THEN 'pass' ELSE 'FAIL' END);

  -- packed_stock delta (existing function, reused by coffee-bot).
  UPDATE products SET packed_stock = 4 WHERE id = prod_id;
  SELECT packed_before, packed_after INTO pb, pa FROM apply_packed_stock_delta(prod_id, 3);
  r := r || jsonb_build_object('packed_delta', CASE WHEN pb = 4 AND pa = 7 THEN 'pass' ELSE 'FAIL' END);

  -- Campaign counters.
  IF c_id IS NOT NULL THEN
    SELECT COALESCE(open_count, 0) INTO n0 FROM campaigns WHERE id = c_id;
    n1 := increment_campaign_stat(c_id, 'open_count');
    r := r || jsonb_build_object('campaign_increment', CASE WHEN n1 = n0 + 1 THEN 'pass' ELSE 'FAIL' END);
  END IF;
  BEGIN
    PERFORM increment_campaign_stat(c_id, 'recipient_count');
    r := r || '{"campaign_column_whitelist":"FAIL"}';
  EXCEPTION WHEN invalid_parameter_value THEN r := r || '{"campaign_column_whitelist":"pass"}';
  END;
  r := r || jsonb_build_object('campaign_missing_null',
    CASE WHEN increment_campaign_stat(-1, 'open_count') IS NULL THEN 'pass' ELSE 'FAIL' END);

  -- Only the service role may call them.
  FOREACH who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    r := r || jsonb_build_object(who || '_denied', CASE WHEN
          NOT has_function_privilege(who, 'apply_roasted_stock_delta(text,bigint,numeric,boolean)', 'EXECUTE')
      AND NOT has_function_privilege(who, 'increment_campaign_stat(bigint,text)', 'EXECUTE')
      AND NOT has_function_privilege(who, 'apply_packed_stock_delta(integer,integer)', 'EXECUTE')
      THEN 'pass' ELSE 'FAIL' END);
  END LOOP;
  r := r || jsonb_build_object('service_role_allowed', CASE WHEN
        has_function_privilege('service_role', 'apply_roasted_stock_delta(text,bigint,numeric,boolean)', 'EXECUTE')
    AND has_function_privilege('service_role', 'increment_campaign_stat(bigint,text)', 'EXECUTE')
    AND has_function_privilege('service_role', 'apply_packed_stock_delta(integer,integer)', 'EXECUTE')
    THEN 'pass' ELSE 'FAIL' END);

  RAISE EXCEPTION 'DRYRUN_RESULT %', r::text;
END
$t$;
