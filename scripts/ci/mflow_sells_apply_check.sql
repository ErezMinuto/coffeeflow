-- Checks apply_mflow_sells (migration 20261024_apply_mflow_sells) against real
-- rows. Always ends in RAISE EXCEPTION, so every write is rolled back. Prints
-- only pass/fail words, never stock values.
--
-- Uses negative mflow_sell_ids, which MFlow never issues, so it cannot collide
-- with a real recorded sell.
--
-- Dry-run before applying the migration (nothing persists):
--   BEGIN; <migration file>; <this file>; ROLLBACK;
-- After applying, run this file on its own.
DO $t$
DECLARE
  r       jsonb := '{}'::jsonb;
  res     jsonb;
  p1 integer; p2 integer;
  n_adj0 integer;
  who text;
BEGIN
  SELECT id INTO p1 FROM products ORDER BY id LIMIT 1;
  SELECT id INTO p2 FROM products WHERE id > p1 ORDER BY id LIMIT 1;
  DELETE FROM mflow_sell_events WHERE mflow_sell_id IN (-910001, -910002, -910003, -910004);
  UPDATE products SET packed_stock = 10 WHERE id = p1;
  UPDATE products SET packed_stock = 1  WHERE id = p2;
  SELECT count(*) INTO n_adj0 FROM inventory_adjustments WHERE source = 'mflow_sell';

  -- Two new sells: p1 -3 and -2 (net -5), p2 -4 (clamps at 0, 3 lost).
  res := apply_mflow_sells(jsonb_build_array(
    jsonb_build_object('mflow_sell_id', -910001, 'status', 'Completed', 'coffee_delta', jsonb_build_object(p1::text, -3, p2::text, -4)),
    jsonb_build_object('mflow_sell_id', -910002, 'status', 'Completed', 'coffee_delta', jsonb_build_object(p1::text, -2))
  ), 'ci check');
  r := r || jsonb_build_object('claims_new', CASE WHEN jsonb_array_length(res->'claimed') = 2
    AND (res->>'already_recorded')::int = 0 THEN 'pass' ELSE 'FAIL' END);
  r := r || jsonb_build_object('applies_net_delta', CASE WHEN
    (SELECT packed_stock FROM products WHERE id = p1) = 5 THEN 'pass' ELSE 'FAIL' END);
  r := r || jsonb_build_object('clamp_reported', CASE WHEN
    (SELECT packed_stock FROM products WHERE id = p2) = 0
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(res->'adjustments') a
                WHERE (a->>'cf_product')::int = p2 AND (a->>'units_lost')::int = 3) THEN 'pass' ELSE 'FAIL' END);
  r := r || jsonb_build_object('events_recorded', CASE WHEN
    (SELECT count(*) FROM mflow_sell_events WHERE mflow_sell_id IN (-910001, -910002) AND applied) = 2 THEN 'pass' ELSE 'FAIL' END);
  r := r || jsonb_build_object('audit_rows', CASE WHEN
    (SELECT count(*) FROM inventory_adjustments WHERE source = 'mflow_sell') = n_adj0 + 2 THEN 'pass' ELSE 'FAIL' END);

  -- Same sells again (overlapping run): nothing claimed, stock unchanged.
  res := apply_mflow_sells(jsonb_build_array(
    jsonb_build_object('mflow_sell_id', -910001, 'coffee_delta', jsonb_build_object(p1::text, -3, p2::text, -4)),
    jsonb_build_object('mflow_sell_id', -910002, 'coffee_delta', jsonb_build_object(p1::text, -2)),
    jsonb_build_object('mflow_sell_id', -910003, 'coffee_delta', jsonb_build_object(p1::text, -1))
  ), 'ci check');
  r := r || jsonb_build_object('replay_not_reapplied', CASE WHEN
    (SELECT packed_stock FROM products WHERE id = p1) = 4
    AND jsonb_array_length(res->'claimed') = 1
    AND (res->>'already_recorded')::int = 2 THEN 'pass' ELSE 'FAIL' END);

  -- A sell touching a product that doesn't exist: not recorded, nothing applied.
  res := apply_mflow_sells(jsonb_build_array(
    jsonb_build_object('mflow_sell_id', -910004, 'coffee_delta', jsonb_build_object(p1::text, -1, '-1', -1))
  ), 'ci check');
  r := r || jsonb_build_object('missing_product_skipped', CASE WHEN
    (SELECT packed_stock FROM products WHERE id = p1) = 4
    AND NOT EXISTS (SELECT 1 FROM mflow_sell_events WHERE mflow_sell_id = -910004)
    AND res->'failed_products' @> '[-1]'::jsonb THEN 'pass' ELSE 'FAIL' END);

  -- Bad input is refused.
  BEGIN
    PERFORM apply_mflow_sells('{}'::jsonb);
    r := r || '{"rejects_non_array":"FAIL"}';
  EXCEPTION WHEN invalid_parameter_value THEN r := r || '{"rejects_non_array":"pass"}';
  END;

  -- Only the service role may call it.
  FOREACH who IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    r := r || jsonb_build_object(who || '_denied', CASE WHEN
      NOT has_function_privilege(who, 'apply_mflow_sells(jsonb,text)', 'EXECUTE') THEN 'pass' ELSE 'FAIL' END);
  END LOOP;
  r := r || jsonb_build_object('service_role_allowed', CASE WHEN
    has_function_privilege('service_role', 'apply_mflow_sells(jsonb,text)', 'EXECUTE') THEN 'pass' ELSE 'FAIL' END);

  RAISE EXCEPTION 'DRYRUN_RESULT %', r::text;
END
$t$;
