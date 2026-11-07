-- CoffeeFlow — B2B bag sales per product, for the packing list's B2B forecast.
--
-- Companion to store_bags_sold (20261026g): same shape and gate, channel
-- back_office (MFlow B2B invoicing) instead of pos + ecosite. A separate function
-- rather than a changed store_bags_sold so nothing existing is replaced.
-- Additive only.

CREATE OR REPLACE FUNCTION public.b2b_bags_sold(p_days INTEGER DEFAULT 28)
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
       AND l.channel = 'back_office'
       AND l.status_class IN ('counted','return')
       AND l.transaction_date >= now() - make_interval(days => greatest(1, least(p_days, 365)))
     GROUP BY l.cf_product_id;
END;
$$;
REVOKE ALL ON FUNCTION public.b2b_bags_sold(INTEGER) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.b2b_bags_sold(INTEGER) TO authenticated, service_role;

-- Verify (service role):  SELECT * FROM public.b2b_bags_sold(28) ORDER BY bags DESC;
