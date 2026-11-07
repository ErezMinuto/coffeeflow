-- Baseline: the prod schema (public, app, ops) as of 2026-11-07, dumped from
-- ytydgldyeygpzmlxvpvb with `supabase db dump -s public,app,ops`.
--
-- Replaces the 172 historical migrations (now in supabase/migrations_archive/).
-- Most of those were applied by hand or through apply-migration.yml, and core
-- objects (employees, user_roles, is_admin, get_role_for_user) were never in git
-- at all, so this dump, not the archive, is the source of truth.
--
-- Supabase-managed schemas (auth, storage, realtime, vault, cron, net, ...) are
-- deliberately excluded. Storage buckets/policies: 00000000000001_storage.sql.
-- Cron jobs: supabase/cron/prod_jobs.sql (prod only, never a migration).

CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";
CREATE EXTENSION IF NOT EXISTS "pg_net";
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";

-- A fresh Supabase project grants ALL on every new object in public to anon,
-- authenticated and service_role (default privileges). Prod revoked many of
-- those after the fact, which pg_dump cannot express: it only re-states each
-- object's final GRANTs. So switch the defaults off while the objects below are
-- created; the dump's own GRANTs then reproduce prod's ACLs exactly, and its
-- trailing ALTER DEFAULT PRIVILEGES restore prod's defaults for future objects.
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES    FROM "anon", "authenticated", "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "anon", "authenticated", "service_role";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON FUNCTIONS FROM "anon", "authenticated", "service_role";




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "app";


ALTER SCHEMA "app" OWNER TO "postgres";


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE SCHEMA IF NOT EXISTS "ops";


ALTER SCHEMA "ops" OWNER TO "postgres";


COMMENT ON SCHEMA "ops" IS 'Operational tables that must never be reachable through the Data API. Not in PostgREST''s exposed schemas. Anything holding credentials belongs here, never in public.';



CREATE OR REPLACE FUNCTION "app"."supabase_url"() RETURNS "text"
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT 'https://ytydgldyeygpzmlxvpvb.supabase.co'
$$;


ALTER FUNCTION "app"."supabase_url"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."acquire_job_lease"("p_name" "text", "p_holder" "text", "p_ttl_seconds" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_got text;
BEGIN
  IF p_name IS NULL OR p_holder IS NULL OR p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 THEN
    RAISE EXCEPTION 'acquire_job_lease: name, holder and a positive ttl are required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO job_leases AS l (name, holder, acquired_at, expires_at)
  VALUES (p_name, p_holder, now(), now() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (name) DO UPDATE
     SET holder = EXCLUDED.holder, acquired_at = EXCLUDED.acquired_at, expires_at = EXCLUDED.expires_at
   WHERE l.expires_at < now() OR l.holder = EXCLUDED.holder
  RETURNING holder INTO v_got;
  RETURN v_got IS NOT NULL;
END;
$$;


ALTER FUNCTION "public"."acquire_job_lease"("p_name" "text", "p_holder" "text", "p_ttl_seconds" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_mflow_sells"("p_sells" "jsonb", "p_note" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."apply_mflow_sells"("p_sells" "jsonb", "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_packed_stock_delta"("p_product_id" integer, "p_delta" integer) RETURNS TABLE("packed_before" integer, "packed_after" integer, "units_lost" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."apply_packed_stock_delta"("p_product_id" integer, "p_delta" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_roasted_stock_delta"("p_source_type" "text", "p_source_id" bigint, "p_delta_kg" numeric, "p_require_sufficient" boolean DEFAULT false) RETURNS TABLE("stock_before" numeric, "stock_after" numeric, "applied" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."apply_roasted_stock_delta"("p_source_type" "text", "p_source_id" bigint, "p_delta_kg" numeric, "p_require_sufficient" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."b2b_bags_sold"("p_days" integer DEFAULT 28) RETURNS TABLE("product_id" bigint, "bags" numeric)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."b2b_bags_sold"("p_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_manage_schedule"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = (auth.jwt() ->> 'sub')
      AND role IN ('admin', 'schedule_manager')
  );
$$;


ALTER FUNCTION "public"."can_manage_schedule"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_bot_rate_limit"("p_telegram_id" "text", "p_bot_name" "text", "p_limit" integer, "p_window_seconds" integer) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO bot_rate_limit (telegram_id, bot_name, window_start, request_count)
  VALUES (p_telegram_id, p_bot_name, now(), 1)
  ON CONFLICT (telegram_id, bot_name) DO UPDATE SET
    window_start = CASE
      WHEN bot_rate_limit.window_start < now() - (p_window_seconds || ' seconds')::interval
        THEN now()
      ELSE bot_rate_limit.window_start
    END,
    request_count = CASE
      WHEN bot_rate_limit.window_start < now() - (p_window_seconds || ' seconds')::interval
        THEN 1
      ELSE bot_rate_limit.request_count + 1
    END
  RETURNING request_count INTO v_count;

  RETURN v_count <= p_limit;
END;
$$;


ALTER FUNCTION "public"."check_bot_rate_limit"("p_telegram_id" "text", "p_bot_name" "text", "p_limit" integer, "p_window_seconds" integer) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."invoice_deliveries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "invoice_count" integer NOT NULL,
    "total_before_vat" numeric(14,2),
    "total_incl_vat" numeric(14,2),
    "oldest_invoice" "date",
    "newest_invoice" "date",
    "created_by" "text" NOT NULL,
    "created_by_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."invoice_deliveries" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_invoice_delivery"("p_invoice_ids" "uuid"[], "p_created_by_name" "text" DEFAULT NULL::"text") RETURNS "public"."invoice_deliveries"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."create_invoice_delivery"("p_invoice_ids" "uuid"[], "p_created_by_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cron_job_health"("p_jobname" "text") RETURNS TABLE("active" boolean, "schedule" "text", "last_start" timestamp with time zone, "last_status" "text", "last_success" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'cron', 'public'
    AS $$
  SELECT
    j.active,
    j.schedule,
    (SELECT jrd.start_time
       FROM cron.job_run_details jrd
      WHERE jrd.jobid = j.jobid
      ORDER BY jrd.start_time DESC
      LIMIT 1) AS last_start,
    (SELECT jrd.status
       FROM cron.job_run_details jrd
      WHERE jrd.jobid = j.jobid
      ORDER BY jrd.start_time DESC
      LIMIT 1) AS last_status,
    -- The newest run that actually SUCCEEDED, regardless of what has happened
    -- since. This is the signal that separates a blip from a dead job.
    (SELECT jrd.start_time
       FROM cron.job_run_details jrd
      WHERE jrd.jobid = j.jobid
        AND jrd.status = 'succeeded'
      ORDER BY jrd.start_time DESC
      LIMIT 1) AS last_success
  FROM cron.job j
  WHERE j.jobname = p_jobname;
$$;


ALTER FUNCTION "public"."cron_job_health"("p_jobname" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_role"() RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_user_id TEXT;
  v_role    TEXT;
BEGIN
  v_user_id := auth.jwt() ->> 'sub';
  IF v_user_id IS NULL THEN
    RETURN 'employee';
  END IF;
  SELECT role INTO v_role FROM public.user_roles WHERE user_id = v_user_id LIMIT 1;
  RETURN COALESCE(v_role, 'employee');
END;
$$;


ALTER FUNCTION "public"."get_my_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_role_for_user"("p_user_id" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$ DECLARE v_role TEXT; BEGIN SELECT role INTO v_role FROM public.user_roles WHERE user_id = p_user_id LIMIT 1; RETURN COALESCE(v_role, 'employee'); END; $$;


ALTER FUNCTION "public"."get_role_for_user"("p_user_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."gsc_keyword_totals"("p_since" "date", "p_until" "date" DEFAULT NULL::"date") RETURNS TABLE("keyword" "text", "clicks" bigint, "impressions" bigint, "ctr" double precision, "position" double precision, "days" integer, "last_date" "date")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  SELECT g.keyword,
         sum(g.clicks)::bigint,
         sum(g.impressions)::bigint,
         CASE WHEN sum(g.impressions) > 0 THEN sum(g.clicks)::double precision / sum(g.impressions) ELSE 0 END,
         CASE WHEN sum(g.impressions) > 0
              THEN sum(g.position * g.impressions) / sum(g.impressions)
              ELSE avg(g.position) END,
         count(DISTINCT g.date)::integer,
         max(g.date)
  FROM google_search_console g
  WHERE g.keyword <> '__page__'           -- page rows are stored under this sentinel
    AND g.date >= p_since
    AND (p_until IS NULL OR g.date <= p_until)
  GROUP BY g.keyword
$$;


ALTER FUNCTION "public"."gsc_keyword_totals"("p_since" "date", "p_until" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."increment_campaign_stat"("p_campaign_id" bigint, "p_column" "text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
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
$_$;


ALTER FUNCTION "public"."increment_campaign_stat"("p_campaign_id" bigint, "p_column" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = (auth.jwt() ->> 'sub')
      AND role = 'admin'
  );
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_bookkeeper"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = (auth.jwt() ->> 'sub')
       AND role = 'bookkeeper'
  );
$$;


ALTER FUNCTION "public"."is_bookkeeper"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_staff"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = (auth.jwt() ->> 'sub')
       AND role <> 'bookkeeper'
  );
$$;


ALTER FUNCTION "public"."is_staff"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."messaging_resolve_customers"("p_limit" integer DEFAULT 2000) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  r          record;
  v_phone    text;
  v_email    text;
  v_ids      uuid[];
  v_losers   uuid[];
  v_target   uuid;
  n_created  int := 0;
  n_attached int := 0;
  n_merged   int := 0;
  n_skipped  int := 0;
BEGIN
  -- One resolver at a time: two concurrent runs could each create a
  -- customer for the same new person.
  PERFORM pg_advisory_xact_lock(hashtext('messaging_resolve_customers'));

  FOR r IN
    SELECT * FROM customer_orders
     WHERE customer_id IS NULL AND NOT resolve_skipped
     ORDER BY woo_order_id
     LIMIT p_limit
  LOOP
    v_phone := CASE WHEN r.phone_e164 IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM messaging_identity_blocklist b WHERE b.kind = 'phone' AND b.value = r.phone_e164)
               THEN r.phone_e164 END;
    v_email := CASE WHEN r.email_norm IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM messaging_identity_blocklist b WHERE b.kind = 'email' AND b.value = r.email_norm)
               THEN r.email_norm END;

    IF v_phone IS NULL AND v_email IS NULL AND r.woo_customer_id IS NULL THEN
      UPDATE customer_orders SET resolve_skipped = true WHERE woo_order_id = r.woo_order_id;
      n_skipped := n_skipped + 1;
      CONTINUE;
    END IF;

    SELECT array_agg(c.id ORDER BY c.seq) INTO v_ids
      FROM customers c
     WHERE c.merged_into IS NULL
       AND (   (v_phone IS NOT NULL AND v_phone = ANY (c.phones))
            OR (v_email IS NOT NULL AND v_email = ANY (c.emails))
            OR (r.woo_customer_id IS NOT NULL AND r.woo_customer_id = ANY (c.woo_customer_ids)));

    IF v_ids IS NULL THEN
      INSERT INTO customers (phones, emails, woo_customer_ids, phone_e164, first_name)
      VALUES (
        CASE WHEN v_phone IS NULL THEN '{}'::text[] ELSE ARRAY[v_phone] END,
        CASE WHEN v_email IS NULL THEN '{}'::text[] ELSE ARRAY[v_email] END,
        CASE WHEN r.woo_customer_id IS NULL THEN '{}'::int[] ELSE ARRAY[r.woo_customer_id] END,
        CASE WHEN r.phone_is_mobile THEN v_phone END,
        r.first_name)
      RETURNING id INTO v_target;
      n_created := n_created + 1;
    ELSE
      v_target := v_ids[1];   -- the oldest customer survives a merge
      v_losers := v_ids[2:];

      IF cardinality(v_losers) > 0 THEN
        UPDATE customers s SET
          phones           = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM customers c, unnest(c.phones) x WHERE c.id = ANY (v_ids)),
          emails           = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM customers c, unnest(c.emails) x WHERE c.id = ANY (v_ids)),
          woo_customer_ids = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM customers c, unnest(c.woo_customer_ids) x WHERE c.id = ANY (v_ids)),
          phone_e164       = coalesce(s.phone_e164, (SELECT c.phone_e164 FROM customers c WHERE c.id = ANY (v_losers) AND c.phone_e164 IS NOT NULL LIMIT 1)),
          first_name       = coalesce(s.first_name, (SELECT c.first_name FROM customers c WHERE c.id = ANY (v_losers) AND c.first_name IS NOT NULL LIMIT 1)),
          updated_at       = now()
        WHERE s.id = v_target;
        UPDATE customers       SET merged_into = v_target, updated_at = now() WHERE id = ANY (v_losers) OR merged_into = ANY (v_losers);
        UPDATE customer_orders SET customer_id = v_target WHERE customer_id = ANY (v_losers);
        n_merged := n_merged + cardinality(v_losers);
      END IF;

      UPDATE customers SET
        phones           = CASE WHEN v_phone IS NULL OR v_phone = ANY (phones) THEN phones ELSE phones || v_phone END,
        emails           = CASE WHEN v_email IS NULL OR v_email = ANY (emails) THEN emails ELSE emails || v_email END,
        woo_customer_ids = CASE WHEN r.woo_customer_id IS NULL OR r.woo_customer_id = ANY (woo_customer_ids)
                                THEN woo_customer_ids ELSE woo_customer_ids || r.woo_customer_id END,
        -- Orders resolve in id order, so the latest order's mobile wins.
        phone_e164       = CASE WHEN r.phone_is_mobile AND v_phone IS NOT NULL THEN v_phone ELSE phone_e164 END,
        first_name       = coalesce(r.first_name, first_name),
        updated_at       = now()
      WHERE id = v_target;
      n_attached := n_attached + 1;
    END IF;

    UPDATE customer_orders SET customer_id = v_target WHERE woo_order_id = r.woo_order_id;
  END LOOP;

  RETURN jsonb_build_object(
    'created',  n_created,
    'attached', n_attached,
    'merged',   n_merged,
    'skipped',  n_skipped,
    'remaining', (SELECT count(*) FROM customer_orders WHERE customer_id IS NULL AND NOT resolve_skipped));
END;
$$;


ALTER FUNCTION "public"."messaging_resolve_customers"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mx_norm"("t" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  SELECT nullif(trim(regexp_replace(lower(coalesce(t, '')), '[_[:space:]|-]+', ' ', 'g')), '')
$$;


ALTER FUNCTION "public"."mx_norm"("t" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mx_paid_summary"("p_days" integer DEFAULT 14, "p_end" "date" DEFAULT NULL::"date") RETURNS TABLE("platform" "text", "campaign_id" "text", "name" "text", "spend" numeric, "clicks" bigint, "impressions" bigint, "platform_purchases" numeric, "orders" bigint, "revenue_ex_vat" numeric, "real_roas" numeric, "real_cpa" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  WITH bounds AS (
    SELECT coalesce(p_end, (now() AT TIME ZONE 'Asia/Jerusalem')::date)            AS d1,
           coalesce(p_end, (now() AT TIME ZONE 'Asia/Jerusalem')::date) - (p_days - 1) AS d0
  ),
  spend AS (
    SELECT p.platform, p.campaign_id,
           sum(p.spend) AS spend, sum(p.clicks)::bigint AS clicks,
           sum(p.impressions)::bigint AS impressions,
           sum(p.platform_purchases) AS platform_purchases
    FROM mx_paid_daily p, bounds b
    WHERE p.day BETWEEN b.d0 AND b.d1
    GROUP BY 1, 2
  ),
  sales AS (
    SELECT w.ad_platform AS platform, w.campaign_id,
           count(*)::bigint AS orders, sum(w.revenue_ex_vat) AS revenue
    FROM mx_web_orders w, bounds b
    WHERE w.ad_platform IS NOT NULL AND w.day BETWEEN b.d0 AND b.d1
    GROUP BY 1, 2
  )
  SELECT coalesce(s.platform, a.platform)          AS platform,
         coalesce(s.campaign_id, a.campaign_id)    AS campaign_id,
         CASE WHEN coalesce(s.campaign_id, a.campaign_id) IS NULL THEN '(unattributed)'
              ELSE k.name END                      AS name,
         round(s.spend, 2), s.clicks, s.impressions, s.platform_purchases,
         coalesce(a.orders, 0),
         round(coalesce(a.revenue, 0), 2),
         CASE WHEN s.spend > 0 THEN round(coalesce(a.revenue, 0) / s.spend, 2) END,
         CASE WHEN coalesce(a.orders, 0) > 0 AND s.spend > 0 THEN round(s.spend / a.orders, 2) END
  FROM spend s
  FULL JOIN sales a ON a.platform = s.platform AND a.campaign_id IS NOT DISTINCT FROM s.campaign_id
  LEFT JOIN mx_campaigns k
         ON k.platform = coalesce(s.platform, a.platform)
        AND k.campaign_id = coalesce(s.campaign_id, a.campaign_id)
  WHERE coalesce(s.spend, 0) > 0 OR coalesce(a.orders, 0) > 0
  ORDER BY 1, s.spend DESC NULLS LAST
$$;


ALTER FUNCTION "public"."mx_paid_summary"("p_days" integer, "p_end" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."mx_paid_summary"("p_days" integer, "p_end" "date") IS 'Per-campaign spend vs attributed web revenue (MFlow ex-VAT) for the last p_days ending p_end (default today, Israel). Rows with campaign_id NULL are paid orders no campaign could claim. real_roas is attributed revenue ÷ spend.';



CREATE OR REPLACE FUNCTION "public"."mx_revenue_summary"("p_days" integer DEFAULT 30, "p_end" "date" DEFAULT NULL::"date") RETURNS TABLE("channel" "text", "revenue_ex_vat" numeric, "sales" bigint, "prev_revenue_ex_vat" numeric, "prev_sales" bigint, "change_pct" numeric)
    LANGUAGE "sql" STABLE
    AS $$
  WITH b AS (
    SELECT coalesce(p_end, (now() AT TIME ZONE 'Asia/Jerusalem')::date) AS d1
  ),
  cur AS (
    SELECT r.channel, sum(r.revenue_ex_vat) AS rev, sum(r.sales)::bigint AS sales
    FROM mx_revenue_daily r, b WHERE r.day BETWEEN b.d1 - (p_days - 1) AND b.d1 GROUP BY 1
  ),
  prev AS (
    SELECT r.channel, sum(r.revenue_ex_vat) AS rev, sum(r.sales)::bigint AS sales
    FROM mx_revenue_daily r, b WHERE r.day BETWEEN b.d1 - (2 * p_days - 1) AND b.d1 - p_days GROUP BY 1
  ),
  j AS (
    SELECT coalesce(c.channel, p.channel) AS channel,
           coalesce(c.rev, 0) AS rev, coalesce(c.sales, 0) AS sales,
           coalesce(p.rev, 0) AS prev, coalesce(p.sales, 0) AS prev_sales
    FROM cur c FULL JOIN prev p ON p.channel = c.channel
  )
  SELECT channel, round(rev, 2), sales, round(prev, 2), prev_sales,
         CASE WHEN prev <> 0 THEN round(100 * (rev - prev) / abs(prev), 1) END
  FROM j
  UNION ALL
  SELECT 'total', round(sum(rev), 2), sum(sales)::bigint, round(sum(prev), 2), sum(prev_sales)::bigint,
         CASE WHEN sum(prev) <> 0 THEN round(100 * (sum(rev) - sum(prev)) / abs(sum(prev)), 1) END
  FROM j
$$;


ALTER FUNCTION "public"."mx_revenue_summary"("p_days" integer, "p_end" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."mx_revenue_summary"("p_days" integer, "p_end" "date") IS 'Revenue (MFlow ex-VAT) per channel plus a total row, for the last p_days and the p_days before. The strategist''s north star is the total row.';



CREATE OR REPLACE FUNCTION "public"."ops_delete_secret"("p_name" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_count int;
begin
  delete from vault.secrets s where s.name = p_name;
  get diagnostics v_count = row_count;
  return case when v_count > 0 then 'deleted' else 'not found' end;
end;
$$;


ALTER FUNCTION "public"."ops_delete_secret"("p_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."ops_delete_secret"("p_name" "text") IS 'Delete a Vault secret by name. service_role only.';



CREATE OR REPLACE FUNCTION "public"."ops_get_secrets"("p_names" "text"[]) RETURNS TABLE("name" "text", "secret" "text")
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select s.name::text, s.decrypted_secret::text
  from vault.decrypted_secrets s
  where s.name = any(p_names)
$$;


ALTER FUNCTION "public"."ops_get_secrets"("p_names" "text"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."ops_get_secrets"("p_names" "text"[]) IS 'Fetch decrypted Vault secrets by name. service_role only. Callers must never print the values.';



CREATE OR REPLACE FUNCTION "public"."ops_list_secret_names"() RETURNS TABLE("name" "text", "description" "text", "updated_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select s.name::text, s.description::text, s.updated_at
  from vault.decrypted_secrets s
  order by s.name
$$;


ALTER FUNCTION "public"."ops_list_secret_names"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."ops_list_secret_names"() IS 'List Vault secret names and metadata. Returns no secret values — safe to display.';



CREATE OR REPLACE FUNCTION "public"."ops_set_secret"("p_name" "text", "p_secret" "text", "p_description" "text" DEFAULT ''::"text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_id uuid;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'a secret needs a name';
  end if;
  if p_secret is null or p_secret = '' then
    raise exception 'refusing to store an empty value for %', p_name;
  end if;

  select s.id into v_id from vault.secrets s where s.name = p_name;

  if v_id is null then
    perform vault.create_secret(p_secret, p_name, coalesce(p_description, ''));
    return 'created';
  else
    perform vault.update_secret(v_id, p_secret, p_name, nullif(p_description, ''));
    return 'updated';
  end if;
end;
$$;


ALTER FUNCTION "public"."ops_set_secret"("p_name" "text", "p_secret" "text", "p_description" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."ops_set_secret"("p_name" "text", "p_secret" "text", "p_description" "text") IS 'Upsert a Vault secret by name. service_role only. Never logs or returns the value.';



CREATE OR REPLACE FUNCTION "public"."purge_chat_messages"("p_keep_days" integer DEFAULT 60) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_cutoff  TIMESTAMPTZ := NOW() - (p_keep_days || ' days')::INTERVAL;
  v_batch   INTEGER;
  v_total   INTEGER := 0;
BEGIN
  LOOP
    DELETE FROM chat_messages
    WHERE id IN (
      SELECT id FROM chat_messages WHERE created_at < v_cutoff LIMIT 10000
    );
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
    EXIT WHEN v_batch = 0;
  END LOOP;
  RETURN v_total;
END;
$$;


ALTER FUNCTION "public"."purge_chat_messages"("p_keep_days" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."purge_chat_messages"("p_keep_days" integer) IS 'Deletes chat_messages rows older than p_keep_days (default 60) in 10k batches. Returns rows deleted. Run daily by chat-messages-purge-daily. EXECUTE revoked from anon/authenticated/PUBLIC: SECURITY DEFINER + caller-supplied window would let the anon key wipe the table.';



CREATE OR REPLACE FUNCTION "public"."purge_packing_logs"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM packing_logs WHERE packed_at < NOW() - INTERVAL '10 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;


ALTER FUNCTION "public"."purge_packing_logs"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_system_logs"("p_keep_days" integer DEFAULT 30) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_cutoff  TIMESTAMPTZ := NOW() - (p_keep_days || ' days')::INTERVAL;
  v_batch   INTEGER;
  v_total   INTEGER := 0;
BEGIN
  LOOP
    DELETE FROM system_logs
    WHERE id IN (
      SELECT id FROM system_logs WHERE ts < v_cutoff LIMIT 10000
    );
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
    EXIT WHEN v_batch = 0;
  END LOOP;
  RETURN v_total;
END;
$$;


ALTER FUNCTION "public"."purge_system_logs"("p_keep_days" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."purge_system_logs"("p_keep_days" integer) IS 'Deletes system_logs rows older than p_keep_days in 10k batches. Returns rows deleted. Run daily by system-logs-purge-daily.';



CREATE OR REPLACE FUNCTION "public"."reel_render_dispatch"("p_task_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
DECLARE
  v_token text;
  v_recent int;
BEGIN
  SELECT decrypted_secret INTO v_token
  FROM vault.decrypted_secrets
  WHERE name = 'github_reel_dispatch_token'
  LIMIT 1;

  IF v_token IS NULL THEN
    RAISE LOG 'reel_render_dispatch: vault secret github_reel_dispatch_token missing; task % left pending', p_task_id;
    RETURN;
  END IF;

  -- Runaway guard: seo_tasks is writable with the anon key, so cap GitHub runs.
  SELECT count(*) INTO v_recent
  FROM seo_tasks
  WHERE task_type = 'reel_render'
    AND attempts > 0
    AND updated_at > now() - interval '1 hour';
  IF v_recent >= 20 THEN
    RAISE LOG 'reel_render_dispatch: 20 dispatches in the last hour; task % deferred', p_task_id;
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://api.github.com/repos/ErezMinuto/coffeeflow/actions/workflows/render-reel.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'coffeeflow-reel-dispatch',
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('task_id', p_task_id::text)),
    timeout_milliseconds := 10000
  );

  -- locked_until = "give the workflow this long to claim it before re-dispatching"
  UPDATE seo_tasks
  SET attempts = attempts + 1,
      locked_until = now() + interval '15 minutes',
      updated_at = now()
  WHERE id = p_task_id AND status = 'pending';
END;
$$;


ALTER FUNCTION "public"."reel_render_dispatch"("p_task_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reel_render_on_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  PERFORM public.reel_render_dispatch(NEW.id);
  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."reel_render_on_insert"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reel_render_sweep"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  r record;
BEGIN
  -- Rendering takes ~2 minutes; 45 minutes in processing means the run died
  -- before its finalize step could report.
  UPDATE seo_tasks
  SET status = 'failed',
      error_msg = 'render timed out (no result from GitHub Actions within 45 minutes)',
      updated_at = now()
  WHERE task_type = 'reel_render'
    AND status = 'processing'
    AND started_at < now() - interval '45 minutes';

  -- Dispatched max_attempts times and never claimed: stop retrying.
  UPDATE seo_tasks
  SET status = 'failed',
      error_msg = 'render never started after ' || attempts || ' dispatch attempts (check the GitHub token and the Render reel workflow)',
      updated_at = now()
  WHERE task_type = 'reel_render'
    AND status = 'pending'
    AND attempts >= max_attempts
    AND (locked_until IS NULL OR locked_until < now());

  FOR r IN
    SELECT id FROM seo_tasks
    WHERE task_type = 'reel_render'
      AND status = 'pending'
      AND attempts < max_attempts
      AND (locked_until IS NULL OR locked_until < now())
    ORDER BY created_at
    LIMIT 5
  LOOP
    PERFORM public.reel_render_dispatch(r.id);
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."reel_render_sweep"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_job_lease"("p_name" "text", "p_holder" "text") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  WITH d AS (DELETE FROM job_leases WHERE name = p_name AND holder = p_holder RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM d);
$$;


ALTER FUNCTION "public"."release_job_lease"("p_name" "text", "p_holder" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."seo_tasks_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."seo_tasks_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."store_bags_sold"("p_days" integer DEFAULT 28) RETURNS TABLE("product_id" bigint, "bags" numeric)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."store_bags_sold"("p_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."supplier_invoices_touch"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
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


ALTER FUNCTION "public"."supplier_invoices_touch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."update_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vehicle_driver_at"("local_ts" timestamp without time zone) RETURNS TABLE("driver_name" "text", "started_at" timestamp with time zone, "ended_at" timestamp with time zone, "end_reason" "text")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT t.driver_name, t.started_at, t.ended_at, t.end_reason
  FROM vehicle_trips t
  WHERE t.started_at <= (local_ts AT TIME ZONE 'Asia/Jerusalem')
    AND coalesce(t.ended_at, now()) >= (local_ts AT TIME ZONE 'Asia/Jerusalem')
  ORDER BY t.started_at;
$$;


ALTER FUNCTION "public"."vehicle_driver_at"("local_ts" timestamp without time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vehicle_trip_add_manual"("p_employee_id" bigint, "p_started_local" timestamp without time zone, "p_ended_local" timestamp without time zone, "p_note" "text" DEFAULT NULL::"text") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_name  text;
  v_start timestamptz := p_started_local AT TIME ZONE 'Asia/Jerusalem';
  v_end   timestamptz := p_ended_local   AT TIME ZONE 'Asia/Jerusalem';
  v_id    bigint;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  IF p_started_local IS NULL OR p_ended_local IS NULL THEN
    RAISE EXCEPTION 'start and end are required';
  END IF;
  IF v_end <= v_start THEN
    RAISE EXCEPTION 'end must be after start';
  END IF;
  IF v_end > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'end is in the future';
  END IF;
  SELECT name INTO v_name FROM employees WHERE id = p_employee_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'no such employee';
  END IF;

  INSERT INTO vehicle_trips (employee_id, driver_name, started_at, ended_at, end_reason, note, added_by)
  VALUES (p_employee_id, v_name, v_start, v_end, 'manual', nullif(trim(p_note), ''), auth.jwt() ->> 'sub')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;


ALTER FUNCTION "public"."vehicle_trip_add_manual"("p_employee_id" bigint, "p_started_local" timestamp without time zone, "p_ended_local" timestamp without time zone, "p_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vehicle_trip_delete_manual"("p_id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
  END IF;
  DELETE FROM vehicle_trips WHERE id = p_id AND end_reason = 'manual';
  RETURN FOUND;
END;
$$;


ALTER FUNCTION "public"."vehicle_trip_delete_manual"("p_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vehicle_trips_between"("from_day" "date", "to_day" "date") RETURNS TABLE("id" bigint, "driver_name" "text", "started_at" timestamp with time zone, "ended_at" timestamp with time zone, "end_reason" "text", "note" "text")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT t.id, t.driver_name, t.started_at, t.ended_at, t.end_reason, t.note
  FROM vehicle_trips t
  WHERE t.started_at < ((to_day + 1)::timestamp AT TIME ZONE 'Asia/Jerusalem')
    AND coalesce(t.ended_at, now()) >= (from_day::timestamp AT TIME ZONE 'Asia/Jerusalem')
  ORDER BY t.started_at DESC;
$$;


ALTER FUNCTION "public"."vehicle_trips_between"("from_day" "date", "to_day" "date") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ops"."cron_job_backup_20260920" (
    "jobid" bigint,
    "schedule" "text",
    "command" "text",
    "nodename" "text",
    "nodeport" integer,
    "database" "text",
    "username" "text",
    "active" boolean,
    "jobname" "text"
);


ALTER TABLE "ops"."cron_job_backup_20260920" OWNER TO "postgres";


COMMENT ON TABLE "ops"."cron_job_backup_20260920" IS 'Snapshot of cron.job before 20260920_cron_worker_pressure.sql. Contains service-role headers in the command column — keep it out of public. Restore one schedule with: SELECT cron.alter_job(j.jobid, schedule := b.schedule) FROM cron.job j JOIN ops.cron_job_backup_20260920 b USING (jobname) WHERE j.jobname = ...;';



CREATE TABLE IF NOT EXISTS "ops"."policy_backup_20261017" (
    "saved_at" timestamp with time zone,
    "schemaname" "name",
    "tablename" "name",
    "policyname" "name",
    "permissive" "text",
    "roles" "name"[],
    "cmd" "text",
    "qual" "text" COLLATE "pg_catalog"."C",
    "with_check" "text" COLLATE "pg_catalog"."C"
);


ALTER TABLE "ops"."policy_backup_20261017" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ops"."policy_backup_20261017b" (
    "saved_at" timestamp with time zone,
    "schemaname" "name",
    "tablename" "name",
    "policyname" "name",
    "permissive" "text",
    "roles" "name"[],
    "cmd" "text",
    "qual" "text" COLLATE "pg_catalog"."C",
    "with_check" "text" COLLATE "pg_catalog"."C"
);


ALTER TABLE "ops"."policy_backup_20261017b" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "ops"."policy_backup_20261018c" (
    "saved_at" timestamp with time zone,
    "schemaname" "name",
    "tablename" "name",
    "policyname" "name",
    "permissive" "text",
    "roles" "name"[],
    "cmd" "text",
    "qual" "text" COLLATE "pg_catalog"."C",
    "with_check" "text" COLLATE "pg_catalog"."C"
);


ALTER TABLE "ops"."policy_backup_20261018c" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."advisor_completed_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "week_start" "date" NOT NULL,
    "action_id" "text" NOT NULL,
    "action_label" "text",
    "state" "text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "advisor_completed_actions_state_check" CHECK (("state" = ANY (ARRAY['done'::"text", 'skipped'::"text", 'snoozed'::"text"])))
);


ALTER TABLE "public"."advisor_completed_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."advisor_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "agent_type" "text" NOT NULL,
    "week_start" "date" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "report" "jsonb",
    "error_msg" "text",
    "model" "text",
    "tokens_used" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."advisor_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."advisor_scores" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "week_start" "date" NOT NULL,
    "winning_agent" "text" NOT NULL,
    "score" integer NOT NULL,
    "feedback_text" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "advisor_scores_score_check" CHECK ((("score" >= 1) AND ("score" <= 5)))
);


ALTER TABLE "public"."advisor_scores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_cost_ledger" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_fn" "text" NOT NULL,
    "run_id" "uuid",
    "model" "text",
    "input_tokens" integer DEFAULT 0 NOT NULL,
    "output_tokens" integer DEFAULT 0 NOT NULL,
    "cache_read_tokens" integer DEFAULT 0 NOT NULL,
    "cache_creation_tokens" integer DEFAULT 0 NOT NULL,
    "est_usd" numeric(10,4) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agent_cost_ledger" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."agent_missions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "objective" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "state" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "steps_taken" integer DEFAULT 0 NOT NULL,
    "max_steps" integer DEFAULT 30 NOT NULL,
    "locked_until" timestamp with time zone,
    "worker_id" "text",
    "created_by" "text" DEFAULT 'chat_agent'::"text" NOT NULL,
    "last_step_at" timestamp with time zone,
    "last_briefing_at" timestamp with time zone,
    "result_summary" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."agent_missions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_visibility_probes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "query_id" "uuid" NOT NULL,
    "query_text" "text" NOT NULL,
    "llm_provider" "text" NOT NULL,
    "response_text" "text" NOT NULL,
    "minuto_mentioned" boolean DEFAULT false NOT NULL,
    "minuto_mention_count" integer DEFAULT 0 NOT NULL,
    "minuto_mention_context" "text",
    "competitors_mentioned" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "minuto_position_chars" integer,
    "response_tokens" integer,
    "cost_usd" numeric,
    "error" "text",
    "ran_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_visibility_probes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_visibility_queries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "query" "text" NOT NULL,
    "language" "text" DEFAULT 'he'::"text" NOT NULL,
    "category" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ai_visibility_queries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_settings" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "key" "text" NOT NULL,
    "value" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."app_settings" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."app_settings_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."app_settings_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."app_settings_id_seq" OWNED BY "public"."app_settings"."id";



CREATE TABLE IF NOT EXISTS "public"."artisan_profiles" (
    "id" bigint NOT NULL,
    "roast_id" bigint NOT NULL,
    "artisan_uuid" "text" NOT NULL,
    "roasted_at" timestamp with time zone NOT NULL,
    "beans" "text",
    "title" "text",
    "batch_label" "text",
    "operator" "text",
    "green_kg" numeric,
    "roasted_kg" numeric,
    "charge_et" numeric,
    "charge_bt" numeric,
    "drop_et" numeric,
    "drop_bt" numeric,
    "total_time_sec" numeric,
    "computed" "jsonb",
    "meta" "jsonb",
    "filename" "text",
    "user_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."artisan_profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."artisan_profiles" IS 'The Artisan roast file uploaded onto a roast record — one per roast, replaced on re-upload. Curve arrays (timex/temp1/temp2) are stripped before storage to keep the row small.';



COMMENT ON COLUMN "public"."artisan_profiles"."meta" IS 'Artisan profile body with timex/temp1/temp2/extratemp* removed — keeps rows ~3KB instead of ~50KB.';



CREATE SEQUENCE IF NOT EXISTS "public"."artisan_profiles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."artisan_profiles_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."artisan_profiles_id_seq" OWNED BY "public"."artisan_profiles"."id";



CREATE TABLE IF NOT EXISTS "public"."attendance_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "employee_id" bigint NOT NULL,
    "event_type" "text" NOT NULL,
    "event_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text" DEFAULT 'telegram'::"text" NOT NULL,
    "note" "text",
    "edited_by_user_id" "text",
    "edited_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "attendance_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['in'::"text", 'out'::"text"]))),
    CONSTRAINT "attendance_events_source_check" CHECK (("source" = ANY (ARRAY['telegram'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."attendance_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."attendance_holidays" (
    "holiday_date" "date" NOT NULL,
    "label" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."attendance_holidays" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."attendance_reminders_sent" (
    "employee_id" bigint NOT NULL,
    "shift_date" "date" NOT NULL,
    "position" "text" NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reminder_type" "text" DEFAULT 'in'::"text" NOT NULL,
    CONSTRAINT "attendance_reminders_sent_reminder_type_check" CHECK (("reminder_type" = ANY (ARRAY['in'::"text", 'out'::"text"])))
);


ALTER TABLE "public"."attendance_reminders_sent" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."attendance_settings" (
    "id" integer DEFAULT 1 NOT NULL,
    "accountant_email" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "checkin_grace_minutes" integer DEFAULT 10 NOT NULL,
    "checkout_grace_minutes" integer DEFAULT 30 NOT NULL,
    CONSTRAINT "attendance_settings_id_check" CHECK (("id" = 1))
);


ALTER TABLE "public"."attendance_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."availability_submissions" (
    "id" bigint NOT NULL,
    "employee_id" bigint NOT NULL,
    "week_start" "date" NOT NULL,
    "days" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "submitted_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."availability_submissions" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."availability_submissions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."availability_submissions_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."availability_submissions_id_seq" OWNED BY "public"."availability_submissions"."id";



CREATE TABLE IF NOT EXISTS "public"."b2b_customers" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "contact_name" "text",
    "phone" "text",
    "email" "text",
    "notes" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."b2b_customers" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."b2b_customers_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."b2b_customers_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."b2b_customers_id_seq" OWNED BY "public"."b2b_customers"."id";



CREATE TABLE IF NOT EXISTS "public"."bag_allocations" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "customer_id" bigint NOT NULL,
    "product_id" bigint NOT NULL,
    "bags" integer NOT NULL,
    "notes" "text",
    "status" "text" DEFAULT 'allocated'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "delivered_at" timestamp with time zone,
    CONSTRAINT "bag_allocations_bags_check" CHECK (("bags" > 0)),
    CONSTRAINT "bag_allocations_status_check" CHECK (("status" = ANY (ARRAY['allocated'::"text", 'delivered'::"text"])))
);


ALTER TABLE "public"."bag_allocations" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."bag_allocations_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."bag_allocations_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."bag_allocations_id_seq" OWNED BY "public"."bag_allocations"."id";



CREATE TABLE IF NOT EXISTS "public"."coffee_sales_daily" (
    "day" "date" NOT NULL,
    "sku" "text" NOT NULL,
    "name" "text",
    "bags" numeric DEFAULT 0 NOT NULL,
    "revenue" numeric DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."coffee_sales_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mflow_sell_lines" (
    "mflow_sell_id" bigint NOT NULL,
    "line_id" bigint NOT NULL,
    "is_return" boolean DEFAULT false NOT NULL,
    "transaction_date" timestamp with time zone NOT NULL,
    "sell_source" "text",
    "channel" "text" NOT NULL,
    "woocommerce_order_id" bigint,
    "status" "text" NOT NULL,
    "status_class" "text" NOT NULL,
    "sku" "text",
    "mflow_product_id" bigint,
    "variation_id" bigint,
    "cf_product_id" bigint,
    "product_name" "text",
    "variation_name" "text",
    "quantity" numeric(12,3) DEFAULT 0 NOT NULL,
    "unit_price_exc_tax" numeric(12,4),
    "discount_amount" numeric(12,4) DEFAULT 0 NOT NULL,
    "item_tax" numeric(12,4) DEFAULT 0 NOT NULL,
    "line_revenue_exc_tax" numeric(14,4) DEFAULT 0 NOT NULL,
    "dpp_exc_tax" numeric(12,4),
    "synced_at" timestamp with time zone NOT NULL,
    CONSTRAINT "mflow_sell_lines_status_class_check" CHECK (("status_class" = ANY (ARRAY['counted'::"text", 'return'::"text", 'excluded'::"text"])))
);


ALTER TABLE "public"."mflow_sell_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_sku_map" (
    "sku" "text" NOT NULL,
    "product_id" bigint NOT NULL,
    "label" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."product_sku_map" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."bean_sales_daily" WITH ("security_invoker"='on') AS
 SELECT ("l"."transaction_date")::"date" AS "day",
    'mflow'::"text" AS "source",
    "l"."cf_product_id",
    "l"."sku",
    "sum"("l"."quantity") FILTER (WHERE ("l"."line_revenue_exc_tax" > (0)::numeric)) AS "paid_units",
    "sum"("l"."quantity") FILTER (WHERE ("l"."line_revenue_exc_tax" <= (0)::numeric)) AS "free_units",
    "sum"("l"."quantity") AS "bean_units",
    "sum"("l"."line_revenue_exc_tax") AS "revenue_ex_vat"
   FROM "public"."mflow_sell_lines" "l"
  WHERE (("l"."status_class" <> 'excluded'::"text") AND ("l"."cf_product_id" IS NOT NULL))
  GROUP BY (("l"."transaction_date")::"date"), 'mflow'::"text", "l"."cf_product_id", "l"."sku"
UNION ALL
 SELECT "c"."day",
    'icount'::"text" AS "source",
    "m"."product_id" AS "cf_product_id",
    "c"."sku",
    "sum"("c"."bags") FILTER (WHERE ("c"."revenue" > (0)::numeric)) AS "paid_units",
    "sum"("c"."bags") FILTER (WHERE ("c"."revenue" <= (0)::numeric)) AS "free_units",
    "sum"("c"."bags") AS "bean_units",
    "sum"("c"."revenue") AS "revenue_ex_vat"
   FROM ("public"."coffee_sales_daily" "c"
     LEFT JOIN "public"."product_sku_map" "m" ON (("m"."sku" = "c"."sku")))
  GROUP BY "c"."day", 'icount'::"text", "m"."product_id", "c"."sku";


ALTER VIEW "public"."bean_sales_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bot_rate_limit" (
    "telegram_id" "text" NOT NULL,
    "bot_name" "text" NOT NULL,
    "window_start" timestamp with time zone DEFAULT "now"() NOT NULL,
    "request_count" integer DEFAULT 1 NOT NULL
);


ALTER TABLE "public"."bot_rate_limit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_events" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "campaign_id" bigint,
    "resend_email_id" "text",
    "event_type" "text" NOT NULL,
    "recipient_email" "text" NOT NULL,
    "event_data" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."campaign_events" OWNER TO "postgres";


ALTER TABLE "public"."campaign_events" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."campaign_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."campaigns" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "channel" "text" DEFAULT 'email'::"text" NOT NULL,
    "subject" "text",
    "message" "text",
    "html_content" "text",
    "recipient_count" integer DEFAULT 0,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "sent_at" timestamp with time zone,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "campaign_type" "text" DEFAULT 'manual'::"text",
    "product_ids" "text"[],
    "preheader" "text",
    "cta_text" "text",
    "cta_url" "text",
    "open_count" integer DEFAULT 0,
    "click_count" integer DEFAULT 0,
    "bounce_count" integer DEFAULT 0
);


ALTER TABLE "public"."campaigns" OWNER TO "postgres";


ALTER TABLE "public"."campaigns" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."campaigns_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."chat_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "text" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text" DEFAULT ''::"text" NOT NULL,
    "tool_calls" "jsonb",
    "tool_call_id" "text",
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chat_messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text", 'tool'::"text", 'system'::"text"])))
);


ALTER TABLE "public"."chat_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coffee_bot_pending_packing" (
    "telegram_id" "text" NOT NULL,
    "chat_id" "text" NOT NULL,
    "product_id" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."coffee_bot_pending_packing" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."competitor_pages" (
    "id" bigint NOT NULL,
    "domain" "text",
    "fb_vanity" "text",
    "fb_page_id" "text",
    "name" "text",
    "discovery_source" "text" DEFAULT 'seed'::"text" NOT NULL,
    "resolve_attempts" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "first_seen" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_checked" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ig_username" "text"
);


ALTER TABLE "public"."competitor_pages" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."competitor_pages_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."competitor_pages_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."competitor_pages_id_seq" OWNED BY "public"."competitor_pages"."id";



CREATE TABLE IF NOT EXISTS "public"."contact_group_members" (
    "id" bigint NOT NULL,
    "group_id" bigint NOT NULL,
    "email" "text" NOT NULL,
    "name" "text",
    "added_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."contact_group_members" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."contact_group_members_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."contact_group_members_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."contact_group_members_id_seq" OWNED BY "public"."contact_group_members"."id";



CREATE TABLE IF NOT EXISTS "public"."contact_groups" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_test_group" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."contact_groups" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."contact_groups_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."contact_groups_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."contact_groups_id_seq" OWNED BY "public"."contact_groups"."id";



CREATE TABLE IF NOT EXISTS "public"."cost_settings" (
    "id" bigint NOT NULL,
    "bag_330g" numeric DEFAULT 0.70,
    "bag_250g" numeric DEFAULT 0.60,
    "bag_1000g" numeric DEFAULT 2.00,
    "label" numeric DEFAULT 0.08,
    "gas_per_roast" numeric DEFAULT 10.00,
    "labor_per_hour" numeric DEFAULT 60,
    "roasting_time_minutes" numeric DEFAULT 17,
    "packaging_time_minutes" numeric DEFAULT 0.5,
    "batch_size_kg" numeric DEFAULT 15,
    "user_id" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "employee_group_chat_id" "text",
    CONSTRAINT "cost_settings_bag_1000g_check" CHECK (("bag_1000g" >= (0)::numeric)),
    CONSTRAINT "cost_settings_bag_250g_check" CHECK (("bag_250g" >= (0)::numeric)),
    CONSTRAINT "cost_settings_bag_330g_check" CHECK (("bag_330g" >= (0)::numeric)),
    CONSTRAINT "cost_settings_batch_size_kg_check" CHECK (("batch_size_kg" > (0)::numeric)),
    CONSTRAINT "cost_settings_gas_per_roast_check" CHECK (("gas_per_roast" >= (0)::numeric)),
    CONSTRAINT "cost_settings_label_check" CHECK (("label" >= (0)::numeric)),
    CONSTRAINT "cost_settings_labor_per_hour_check" CHECK (("labor_per_hour" >= (0)::numeric)),
    CONSTRAINT "cost_settings_packaging_time_minutes_check" CHECK (("packaging_time_minutes" >= (0)::numeric)),
    CONSTRAINT "cost_settings_roasting_time_minutes_check" CHECK (("roasting_time_minutes" >= (0)::numeric))
);


ALTER TABLE "public"."cost_settings" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."cost_settings_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."cost_settings_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."cost_settings_id_seq" OWNED BY "public"."cost_settings"."id";



CREATE TABLE IF NOT EXISTS "public"."customer_orders" (
    "woo_order_id" integer NOT NULL,
    "customer_id" "uuid",
    "resolve_skipped" boolean DEFAULT false NOT NULL,
    "status" "text" NOT NULL,
    "created_via" "text",
    "date_created" timestamp with time zone NOT NULL,
    "date_paid" timestamp with time zone,
    "date_completed" timestamp with time zone,
    "date_modified" timestamp with time zone,
    "woo_customer_id" integer,
    "email_norm" "text",
    "phone_raw" "text",
    "phone_e164" "text",
    "phone_is_mobile" boolean DEFAULT false NOT NULL,
    "first_name" "text",
    "delivery_method" "text" NOT NULL,
    "shipping_method_id" "text",
    "cargo_shipment_id" "text",
    "has_beans" boolean DEFAULT false NOT NULL,
    "bean_grams" integer,
    "lines" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "marketing_consent" boolean,
    "consent_text_version" "text",
    "consent_at" timestamp with time zone,
    CONSTRAINT "customer_orders_delivery_method_check" CHECK (("delivery_method" = ANY (ARRAY['ship'::"text", 'pickup'::"text", 'none'::"text"])))
);


ALTER TABLE "public"."customer_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_rfm" (
    "email" "text" NOT NULL,
    "first_order_date" "date" NOT NULL,
    "last_order_date" "date" NOT NULL,
    "order_count" integer NOT NULL,
    "total_spent_ils" numeric(10,2) NOT NULL,
    "days_since_last" integer NOT NULL,
    "r_score" smallint NOT NULL,
    "f_score" smallint NOT NULL,
    "m_score" smallint NOT NULL,
    "segment" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "customer_id" "uuid",
    "bean_grams" integer,
    CONSTRAINT "customer_rfm_f_score_check" CHECK ((("f_score" >= 1) AND ("f_score" <= 5))),
    CONSTRAINT "customer_rfm_m_score_check" CHECK ((("m_score" >= 1) AND ("m_score" <= 5))),
    CONSTRAINT "customer_rfm_r_score_check" CHECK ((("r_score" >= 1) AND ("r_score" <= 5)))
);


ALTER TABLE "public"."customer_rfm" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "seq" bigint NOT NULL,
    "phone_e164" "text",
    "phones" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "emails" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "woo_customer_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
    "first_name" "text",
    "merged_into" "uuid",
    "created_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."customers" OWNER TO "postgres";


ALTER TABLE "public"."customers" ALTER COLUMN "seq" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."customers_seq_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."email_automation_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trigger_type" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "delay_days" integer DEFAULT 3 NOT NULL,
    "max_lookback_days" integer DEFAULT 3 NOT NULL,
    "subject_template" "text" NOT NULL,
    "body_html_template" "text" NOT NULL,
    "coupon_percent" integer,
    "coupon_expiry_days" integer DEFAULT 60 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "coupon_product_category_slugs" "text"[] DEFAULT ARRAY[]::"text"[] NOT NULL,
    "coupon_product_category_ids" integer[] DEFAULT ARRAY[]::integer[] NOT NULL,
    "not_before_date" "date",
    "settings" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."email_automation_templates" OWNER TO "postgres";


COMMENT ON COLUMN "public"."email_automation_templates"."not_before_date" IS 'Abandoned-cart go-live floor: ignore carts whose order_date is before this date. NULL = no floor. Set per trigger_type.';



CREATE TABLE IF NOT EXISTS "public"."email_automations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "trigger_type" "text" NOT NULL,
    "customer_email" "text" NOT NULL,
    "customer_name" "text",
    "woo_order_id" integer,
    "coupon_code" "text",
    "status" "text" NOT NULL,
    "resend_email_id" "text",
    "scheduled_for" timestamp with time zone NOT NULL,
    "sent_at" timestamp with time zone,
    "error_msg" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."email_automations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."employees" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "role" "text" DEFAULT 'general'::"text" NOT NULL,
    "max_days" integer DEFAULT 5 NOT NULL,
    "telegram_id" bigint,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "phone" "text",
    "barista_skills" boolean DEFAULT false NOT NULL,
    "end_time" time without time zone,
    "barista_level" integer DEFAULT 1,
    "roaster_level" integer DEFAULT 1
);


ALTER TABLE "public"."employees" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."employees_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."employees_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."employees_id_seq" OWNED BY "public"."employees"."id";



CREATE TABLE IF NOT EXISTS "public"."facebook_comments" (
    "comment_id" "text" NOT NULL,
    "post_id" "text" NOT NULL,
    "message" "text",
    "from_name" "text",
    "from_id" "text",
    "like_count" integer,
    "comment_count" integer,
    "created_time" timestamp with time zone,
    "parent_comment_id" "text",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."facebook_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."form_submissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "form_type" "text" NOT NULL,
    "email" "text" NOT NULL,
    "name" "text",
    "phone" "text",
    "message" "text",
    "consent_given" boolean DEFAULT false NOT NULL,
    "ip_address" "text",
    "user_agent" "text",
    "status" "text" DEFAULT 'received'::"text" NOT NULL,
    "forward_sent" boolean DEFAULT false NOT NULL,
    "ack_sent" boolean DEFAULT false NOT NULL,
    "added_to_list" boolean DEFAULT false NOT NULL,
    "error_msg" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "order_id" "text"
);


ALTER TABLE "public"."form_submissions" OWNER TO "postgres";


COMMENT ON TABLE "public"."form_submissions" IS 'Audit log of every form submission from minuto.co.il. Newsletter and callback forms also write to marketing_contacts; contact form does not (its consent is contact-only). The form_type column distinguishes flows.';



COMMENT ON COLUMN "public"."form_submissions"."order_id" IS 'Order number from cancel_order form submissions. NULL for other form types.';



CREATE TABLE IF NOT EXISTS "public"."ga4_pages_daily" (
    "date" "date" NOT NULL,
    "page_path" "text" NOT NULL,
    "channel_group" "text" DEFAULT 'Organic Search'::"text" NOT NULL,
    "sessions" integer DEFAULT 0 NOT NULL,
    "active_users" integer DEFAULT 0 NOT NULL,
    "engaged_sessions" integer DEFAULT 0 NOT NULL,
    "screen_page_views" integer DEFAULT 0 NOT NULL,
    "bounce_rate" numeric,
    "avg_session_duration" numeric,
    "conversions" numeric DEFAULT 0 NOT NULL,
    "conversion_value" numeric DEFAULT 0 NOT NULL,
    "synced_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ga4_pages_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gemini_prompt_cache" (
    "cache_key" "text" NOT NULL,
    "cache_name" "text" NOT NULL,
    "model" "text" NOT NULL,
    "token_count" integer,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_used_at" timestamp with time zone
);


ALTER TABLE "public"."gemini_prompt_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."google_account_settings" (
    "customer_id" "text" NOT NULL,
    "descriptive_name" "text",
    "currency_code" "text",
    "time_zone" "text",
    "auto_tagging_enabled" boolean,
    "conversion_tracking_status" "text",
    "has_enhanced_conversions" boolean,
    "test_account" boolean,
    "manager" boolean,
    "linked_ga4_property_id" "text",
    "linked_merchant_center_id" "text",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."google_account_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."google_ad_drafts" (
    "id" bigint NOT NULL,
    "idea_id" "text" NOT NULL,
    "customer_id" "text" NOT NULL,
    "campaign_id" "text" NOT NULL,
    "budget_id" "text",
    "ad_group_id" "text",
    "ad_id" "text",
    "asset_group_id" "text",
    "campaign_name" "text",
    "campaign_type" "text",
    "daily_budget_ils" numeric,
    "spec" "jsonb",
    "warnings" "text"[],
    "status" "text" DEFAULT 'PAUSED'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."google_ad_drafts" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."google_ad_drafts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."google_ad_drafts_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."google_ad_drafts_id_seq" OWNED BY "public"."google_ad_drafts"."id";



CREATE TABLE IF NOT EXISTS "public"."google_ad_group_daily" (
    "ad_group_id" "text" NOT NULL,
    "campaign_id" "text" NOT NULL,
    "ad_group_name" "text",
    "date" "date" NOT NULL,
    "impressions" bigint DEFAULT 0,
    "clicks" bigint DEFAULT 0,
    "cost_micros" bigint DEFAULT 0,
    "conversions" numeric DEFAULT 0,
    "conversion_value" numeric DEFAULT 0,
    "ctr" numeric,
    "search_impression_share" numeric,
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."google_ad_group_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."google_ad_group_settings" (
    "ad_group_id" "text" NOT NULL,
    "campaign_id" "text" NOT NULL,
    "name" "text",
    "status" "text",
    "type" "text",
    "cpc_bid_micros" bigint,
    "target_cpa_micros" bigint,
    "target_roas" numeric,
    "audience_signals" "jsonb",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."google_ad_group_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."google_ads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ad_id" "text" NOT NULL,
    "ad_group_id" "text" NOT NULL,
    "ad_group_name" "text",
    "campaign_id" "text" NOT NULL,
    "campaign_name" "text",
    "status" "text",
    "ad_strength" "text",
    "headlines" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "descriptions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "final_urls" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "impressions" integer DEFAULT 0,
    "clicks" integer DEFAULT 0,
    "cost" numeric DEFAULT 0,
    "ctr" numeric DEFAULT 0,
    "conversions" numeric DEFAULT 0,
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."google_ads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."google_audiences" (
    "audience_id" "text" NOT NULL,
    "name" "text",
    "type" "text",
    "description" "text",
    "size_for_search" bigint,
    "size_for_display" bigint,
    "membership_status" "text",
    "membership_life_span_days" integer,
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."google_audiences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."google_business_reviews" (
    "review_id" "text" NOT NULL,
    "author_name" "text",
    "rating" integer,
    "text" "text",
    "language" "text",
    "created_time" timestamp with time zone,
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."google_business_reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."google_campaign_settings" (
    "campaign_id" "text" NOT NULL,
    "name" "text",
    "status" "text",
    "advertising_channel_type" "text",
    "bidding_strategy_type" "text",
    "target_cpa_micros" bigint,
    "target_roas" numeric,
    "target_search_network" boolean,
    "target_content_network" boolean,
    "target_partner_search" boolean,
    "daily_budget_micros" bigint,
    "budget_delivery_method" "text",
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "ad_schedule" "jsonb",
    "geo_targets" "jsonb",
    "device_modifiers" "jsonb",
    "final_url_suffix" "text",
    "tracking_template" "text",
    "frequency_cap_secs" "jsonb",
    "start_date" "date",
    "end_date" "date"
);


ALTER TABLE "public"."google_campaign_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."google_campaigns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "text" NOT NULL,
    "date" "date" NOT NULL,
    "name" "text",
    "status" "text",
    "impressions" integer DEFAULT 0,
    "clicks" integer DEFAULT 0,
    "cost" numeric DEFAULT 0,
    "ctr" numeric DEFAULT 0,
    "cpc" numeric DEFAULT 0,
    "conversions" numeric DEFAULT 0,
    "conversion_value" numeric DEFAULT 0,
    "roas" numeric DEFAULT 0,
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "search_impression_share" numeric,
    "search_budget_lost_impression_share" numeric,
    "search_rank_lost_impression_share" numeric,
    "search_top_impression_share" numeric,
    "primary_conversions" numeric(12,2),
    "primary_conversion_value" numeric(12,2)
);


ALTER TABLE "public"."google_campaigns" OWNER TO "postgres";


COMMENT ON COLUMN "public"."google_campaigns"."conversions" IS 'LEGACY, INFLATED: prefers all_conversions, which counts Secondary actions (page views, add-to-cart, phone clicks) alongside real ones. Kept for historical continuity — use primary_conversions for any cost-per-acquisition decision.';



COMMENT ON COLUMN "public"."google_campaigns"."primary_conversions" IS 'metrics.conversions — PRIMARY conversion actions only. The denominator for CPA, and the same metric the ad-level and keyword-level syncs already use.';



CREATE TABLE IF NOT EXISTS "public"."google_click_mapping" (
    "gclid" "text" NOT NULL,
    "campaign_id" "text",
    "ad_group_id" "text",
    "keyword_text" "text",
    "click_date" "date",
    "device" "text",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."google_click_mapping" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."google_conversion_actions" (
    "action_id" "text" NOT NULL,
    "name" "text",
    "category" "text",
    "type" "text",
    "status" "text",
    "primary_for_goal" boolean,
    "include_in_conversions" boolean,
    "counting_type" "text",
    "attribution_model" "text",
    "value_type" "text",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."google_conversion_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."google_keywords_daily" (
    "campaign_id" "text" NOT NULL,
    "ad_group_id" "text" NOT NULL,
    "keyword_text" "text" NOT NULL,
    "match_type" "text" NOT NULL,
    "date" "date" NOT NULL,
    "impressions" bigint DEFAULT 0,
    "clicks" bigint DEFAULT 0,
    "cost_micros" bigint DEFAULT 0,
    "conversions" numeric DEFAULT 0,
    "conversion_value" numeric DEFAULT 0,
    "ctr" numeric,
    "avg_cpc_micros" bigint,
    "quality_score" integer,
    "search_impression_share" numeric,
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."google_keywords_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."google_search_console" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "date" "date" NOT NULL,
    "keyword" "text" NOT NULL,
    "page" "text",
    "clicks" integer DEFAULT 0 NOT NULL,
    "impressions" integer DEFAULT 0 NOT NULL,
    "ctr" double precision DEFAULT 0 NOT NULL,
    "position" double precision DEFAULT 0 NOT NULL,
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."google_search_console" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."google_search_terms" (
    "campaign_id" "text" NOT NULL,
    "ad_group_id" "text" NOT NULL,
    "search_term" "text" NOT NULL,
    "triggering_keyword" "text",
    "match_type" "text",
    "date" "date" NOT NULL,
    "impressions" bigint DEFAULT 0,
    "clicks" bigint DEFAULT 0,
    "cost_micros" bigint DEFAULT 0,
    "conversions" numeric DEFAULT 0,
    "conversion_value" numeric DEFAULT 0,
    "status" "text",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."google_search_terms" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."industry_articles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_id" "uuid" NOT NULL,
    "source_name" "text" NOT NULL,
    "source_category" "text" NOT NULL,
    "url" "text" NOT NULL,
    "title" "text" NOT NULL,
    "published_at" timestamp with time zone,
    "raw_content" "text",
    "insight" "text",
    "relevance" numeric,
    "tags" "text"[],
    "summarized_at" timestamp with time zone,
    "fetched_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."industry_articles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."industry_sources" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "rss_url" "text" NOT NULL,
    "category" "text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "max_per_run" integer DEFAULT 5 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."industry_sources" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."instagram_comments" (
    "comment_id" "text" NOT NULL,
    "post_id" "text" NOT NULL,
    "text" "text",
    "username" "text",
    "like_count" integer,
    "replies_count" integer,
    "created_time" timestamp with time zone,
    "parent_comment_id" "text",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."instagram_comments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."instagram_dm_threads" (
    "conversation_id" "text" NOT NULL,
    "participant_id" "text",
    "participant_username" "text",
    "message_count" integer,
    "unread_count" integer,
    "last_message_time" timestamp with time zone,
    "first_synced_at" timestamp with time zone DEFAULT "now"(),
    "last_synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."instagram_dm_threads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."instagram_dms" (
    "message_id" "text" NOT NULL,
    "conversation_id" "text" NOT NULL,
    "sender_id" "text",
    "sender_username" "text",
    "is_from_minuto" boolean,
    "message" "text",
    "attachments" "jsonb",
    "created_time" timestamp with time zone,
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "purged" boolean DEFAULT false
);


ALTER TABLE "public"."instagram_dms" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_adjustments" (
    "id" bigint NOT NULL,
    "source" "text" DEFAULT 'icount'::"text" NOT NULL,
    "sku" "text" NOT NULL,
    "description" "text",
    "qty_delta" numeric(12,3) NOT NULL,
    "woo_product_id" integer,
    "woo_before" numeric(12,3),
    "woo_after" numeric(12,3),
    "packed_before" numeric(12,3),
    "packed_after" numeric(12,3),
    "applied" boolean DEFAULT false NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "supplier" "text",
    "unit_cost" numeric(12,2),
    "unit_cost_before" numeric(12,2),
    "sale_price" numeric(12,2)
);


ALTER TABLE "public"."inventory_adjustments" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."inventory_adjustments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."inventory_adjustments_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."inventory_adjustments_id_seq" OWNED BY "public"."inventory_adjustments"."id";



CREATE TABLE IF NOT EXISTS "public"."job_leases" (
    "name" "text" NOT NULL,
    "holder" "text" NOT NULL,
    "acquired_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL
);


ALTER TABLE "public"."job_leases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."keyword_ideas" (
    "keyword" "text" NOT NULL,
    "avg_monthly_searches" bigint DEFAULT 0,
    "competition" "text",
    "competition_index" double precision DEFAULT 0,
    "low_top_bid_micros" bigint DEFAULT 0,
    "high_top_bid_micros" bigint DEFAULT 0,
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."keyword_ideas" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ledger_imports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source" "text" DEFAULT 'hashavshevet'::"text" NOT NULL,
    "period_from" "date" NOT NULL,
    "period_to" "date" NOT NULL,
    "filename" "text",
    "line_count" integer DEFAULT 0 NOT NULL,
    "imported_by" "text" DEFAULT ("auth"."jwt"() ->> 'sub'::"text") NOT NULL,
    "imported_by_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "ledger_imports_check" CHECK (("period_to" >= "period_from")),
    CONSTRAINT "ledger_imports_source_check" CHECK (("source" = 'hashavshevet'::"text"))
);


ALTER TABLE "public"."ledger_imports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ledger_lines" (
    "id" bigint NOT NULL,
    "import_id" "uuid" NOT NULL,
    "account_key" "text",
    "account_name" "text",
    "header_id" "text",
    "movement_id" "text",
    "batch" "text",
    "movement_type" "text",
    "counter_account" "text",
    "doc_date" "date",
    "value_date" "date",
    "ref1" "text",
    "ref2" "text",
    "details" "text",
    "amount" numeric(14,2) NOT NULL
);


ALTER TABLE "public"."ledger_lines" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."ledger_lines_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."ledger_lines_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."ledger_lines_id_seq" OWNED BY "public"."ledger_lines"."id";



CREATE TABLE IF NOT EXISTS "public"."market_research" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "research_date" "date" NOT NULL,
    "source" "text" NOT NULL,
    "raw_data" "jsonb",
    "summary" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."market_research" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."marketing_contacts" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "email" "text" NOT NULL,
    "phone" "text",
    "name" "text",
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "opted_in" boolean DEFAULT false NOT NULL,
    "brevo_id" bigint,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."marketing_contacts" OWNER TO "postgres";


ALTER TABLE "public"."marketing_contacts" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."marketing_contacts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."messaging_identity_blocklist" (
    "kind" "text" NOT NULL,
    "value" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "messaging_identity_blocklist_kind_check" CHECK (("kind" = ANY (ARRAY['phone'::"text", 'email'::"text"])))
);


ALTER TABLE "public"."messaging_identity_blocklist" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."messaging_reminder_prefs" (
    "id" bigint NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "source" "text" NOT NULL,
    "actor" "text",
    "created_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    CONSTRAINT "messaging_reminder_prefs_action_check" CHECK (("action" = ANY (ARRAY['stop'::"text", 'resume'::"text"]))),
    CONSTRAINT "messaging_reminder_prefs_source_check" CHECK (("source" = ANY (ARRAY['email_link'::"text", 'one_click'::"text", 'dashboard'::"text"])))
);


ALTER TABLE "public"."messaging_reminder_prefs" OWNER TO "postgres";


ALTER TABLE "public"."messaging_reminder_prefs" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."messaging_reminder_prefs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."meta_account_settings" (
    "ad_account_id" "text" NOT NULL,
    "name" "text",
    "currency" "text",
    "time_zone" "text",
    "business_id" "text",
    "pixel_id" "text",
    "amount_spent" numeric,
    "spend_cap" numeric,
    "account_status" integer,
    "funding_source" "text",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."meta_account_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meta_ad_adsets" (
    "adset_id" "text" NOT NULL,
    "campaign_id" "text" NOT NULL,
    "name" "text",
    "status" "text",
    "effective_status" "text",
    "optimization_goal" "text",
    "billing_event" "text",
    "bid_strategy" "text",
    "daily_budget" numeric,
    "lifetime_budget" numeric,
    "budget_remaining" numeric,
    "targeting" "jsonb",
    "promoted_object" "jsonb",
    "destination_type" "text",
    "learning_stage_info" "jsonb",
    "created_time" timestamp with time zone,
    "updated_time" timestamp with time zone,
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."meta_ad_adsets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meta_ad_campaigns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "text" NOT NULL,
    "date" "date" NOT NULL,
    "name" "text",
    "status" "text",
    "objective" "text",
    "spend" numeric DEFAULT 0,
    "impressions" integer DEFAULT 0,
    "clicks" integer DEFAULT 0,
    "cpm" numeric DEFAULT 0,
    "cpc" numeric DEFAULT 0,
    "ctr" numeric DEFAULT 0,
    "conversions" integer DEFAULT 0,
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "purchases" integer,
    "purchase_value" numeric(12,2),
    "actions_breakdown" "jsonb"
);


ALTER TABLE "public"."meta_ad_campaigns" OWNER TO "postgres";


COMMENT ON COLUMN "public"."meta_ad_campaigns"."conversions" IS 'LEGACY, INFLATED: sums purchase + add_to_cart + initiate_checkout + add_payment_info + all offsite_conversion.*. One shopper counts several times. Kept for historical continuity only — use `purchases` for any cost-per-acquisition decision.';



COMMENT ON COLUMN "public"."meta_ad_campaigns"."purchases" IS 'True purchases only: action_type purchase / offsite_conversion.fb_pixel_purchase / onsite_conversion.purchase. This is the denominator for CPA.';



CREATE TABLE IF NOT EXISTS "public"."meta_ad_daily" (
    "ad_id" "text" NOT NULL,
    "adset_id" "text",
    "campaign_id" "text",
    "date" "date" NOT NULL,
    "impressions" bigint DEFAULT 0,
    "clicks" bigint DEFAULT 0,
    "spend" numeric DEFAULT 0,
    "conversions" numeric DEFAULT 0,
    "ctr" numeric,
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "purchases" integer,
    "purchase_value" numeric(12,2),
    "actions_breakdown" "jsonb"
);


ALTER TABLE "public"."meta_ad_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meta_ad_drafts" (
    "id" bigint NOT NULL,
    "idea_id" "text" NOT NULL,
    "ad_account_id" "text" NOT NULL,
    "campaign_id" "text" NOT NULL,
    "adset_id" "text",
    "ad_id" "text",
    "creative_id" "text",
    "campaign_name" "text",
    "objective" "text",
    "daily_budget_ils" numeric,
    "spec" "jsonb",
    "warnings" "text"[],
    "status" "text" DEFAULT 'PAUSED'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."meta_ad_drafts" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."meta_ad_drafts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."meta_ad_drafts_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."meta_ad_drafts_id_seq" OWNED BY "public"."meta_ad_drafts"."id";



CREATE TABLE IF NOT EXISTS "public"."meta_ads" (
    "ad_id" "text" NOT NULL,
    "adset_id" "text" NOT NULL,
    "campaign_id" "text" NOT NULL,
    "name" "text",
    "status" "text",
    "effective_status" "text",
    "creative_id" "text",
    "creative_type" "text",
    "title" "text",
    "body" "text",
    "call_to_action" "text",
    "link_url" "text",
    "image_url" "text",
    "video_id" "text",
    "created_time" timestamp with time zone,
    "updated_time" timestamp with time zone,
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."meta_ads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meta_adset_daily" (
    "adset_id" "text" NOT NULL,
    "campaign_id" "text",
    "date" "date" NOT NULL,
    "impressions" bigint DEFAULT 0,
    "clicks" bigint DEFAULT 0,
    "spend" numeric DEFAULT 0,
    "conversions" numeric DEFAULT 0,
    "cpm" numeric,
    "cpc" numeric,
    "ctr" numeric,
    "frequency" numeric,
    "reach" bigint,
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."meta_adset_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meta_daily_insights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "date" "date" NOT NULL,
    "reach" integer DEFAULT 0,
    "impressions" integer DEFAULT 0,
    "follower_count" integer DEFAULT 0,
    "profile_views" integer DEFAULT 0,
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."meta_daily_insights" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meta_organic_posts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "post_id" "text" NOT NULL,
    "post_type" "text" DEFAULT 'post'::"text",
    "message" "text",
    "created_at" timestamp with time zone,
    "reach" integer DEFAULT 0,
    "impressions" integer DEFAULT 0,
    "likes" integer DEFAULT 0,
    "comments" integer DEFAULT 0,
    "shares" integer DEFAULT 0,
    "saves" integer DEFAULT 0,
    "thumbnail_url" "text",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."meta_organic_posts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meta_placement_daily" (
    "adset_id" "text" NOT NULL,
    "campaign_id" "text",
    "publisher_platform" "text" NOT NULL,
    "platform_position" "text" NOT NULL,
    "date" "date" NOT NULL,
    "impressions" bigint DEFAULT 0,
    "clicks" bigint DEFAULT 0,
    "spend" numeric DEFAULT 0,
    "conversions" numeric DEFAULT 0,
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."meta_placement_daily" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."mflow_revenue" WITH ("security_invoker"='true') AS
 SELECT "mflow_sell_id",
    "line_id",
    "is_return",
    "transaction_date",
    "sell_source",
    "channel",
    "woocommerce_order_id",
    "status",
    "status_class",
    "sku",
    "mflow_product_id",
    "variation_id",
    "cf_product_id",
    "product_name",
    "variation_name",
    "quantity",
    "unit_price_exc_tax",
    "discount_amount",
    "item_tax",
    "line_revenue_exc_tax",
    "dpp_exc_tax",
    "synced_at"
   FROM "public"."mflow_sell_lines"
  WHERE ("status_class" = ANY (ARRAY['counted'::"text", 'return'::"text"]));


ALTER VIEW "public"."mflow_revenue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mflow_sell_events" (
    "mflow_sell_id" bigint NOT NULL,
    "type" "text",
    "status" "text",
    "is_return" boolean DEFAULT false NOT NULL,
    "source" "text",
    "transaction_date" timestamp with time zone,
    "coffee_delta" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "applied" boolean DEFAULT false NOT NULL,
    "processed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."mflow_sell_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."minuto_blog_posts" (
    "id" bigint NOT NULL,
    "url" "text" NOT NULL,
    "title" "text" NOT NULL,
    "published_at" timestamp with time zone,
    "description" "text",
    "first_seen" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."minuto_blog_posts" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."minuto_blog_posts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."minuto_blog_posts_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."minuto_blog_posts_id_seq" OWNED BY "public"."minuto_blog_posts"."id";



CREATE OR REPLACE VIEW "public"."mx_campaigns" WITH ("security_invoker"='true') AS
 SELECT DISTINCT ON ("platform", "campaign_id") "platform",
    "campaign_id",
    "name"
   FROM ( SELECT 'google'::"text" AS "platform",
            "google_campaigns"."campaign_id",
            "google_campaigns"."name",
            "google_campaigns"."date"
           FROM "public"."google_campaigns"
        UNION ALL
         SELECT 'meta'::"text" AS "text",
            "meta_ad_campaigns"."campaign_id",
            "meta_ad_campaigns"."name",
            "meta_ad_campaigns"."date"
           FROM "public"."meta_ad_campaigns") "c"
  ORDER BY "platform", "campaign_id", "date" DESC;


ALTER VIEW "public"."mx_campaigns" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."mx_paid_daily" WITH ("security_invoker"='true') AS
 SELECT 'google'::"text" AS "platform",
    "google_campaigns"."campaign_id",
    "google_campaigns"."name",
    "google_campaigns"."date" AS "day",
    COALESCE("google_campaigns"."cost", (0)::numeric) AS "spend",
    COALESCE("google_campaigns"."clicks", 0) AS "clicks",
    COALESCE("google_campaigns"."impressions", 0) AS "impressions",
    "google_campaigns"."primary_conversions" AS "platform_purchases",
    "google_campaigns"."primary_conversion_value" AS "platform_value"
   FROM "public"."google_campaigns"
UNION ALL
 SELECT 'meta'::"text" AS "platform",
    "meta_ad_campaigns"."campaign_id",
    "meta_ad_campaigns"."name",
    "meta_ad_campaigns"."date" AS "day",
    COALESCE("meta_ad_campaigns"."spend", (0)::numeric) AS "spend",
    COALESCE("meta_ad_campaigns"."clicks", 0) AS "clicks",
    COALESCE("meta_ad_campaigns"."impressions", 0) AS "impressions",
    "meta_ad_campaigns"."purchases" AS "platform_purchases",
    "meta_ad_campaigns"."purchase_value" AS "platform_value"
   FROM "public"."meta_ad_campaigns";


ALTER VIEW "public"."mx_paid_daily" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."mx_revenue_daily" WITH ("security_invoker"='true') AS
 SELECT (("transaction_date" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date" AS "day",
    "channel",
    "round"("sum"("line_revenue_exc_tax"), 2) AS "revenue_ex_vat",
    "round"("sum"("line_revenue_exc_tax") FILTER (WHERE "is_return"), 2) AS "returns_ex_vat",
    "count"(DISTINCT "mflow_sell_id") FILTER (WHERE (NOT "is_return")) AS "sales"
   FROM "public"."mflow_revenue"
  GROUP BY ((("transaction_date" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date"), "channel";


ALTER VIEW "public"."mx_revenue_daily" OWNER TO "postgres";


COMMENT ON VIEW "public"."mx_revenue_daily" IS 'THE revenue number. MFlow, ex-VAT, returns netted, per Israel day and channel (pos=café, ecosite=web, back_office=B2B). Use this for any revenue figure.';



CREATE TABLE IF NOT EXISTS "public"."woo_orders" (
    "id" bigint NOT NULL,
    "woo_order_id" integer NOT NULL,
    "order_date" "date" NOT NULL,
    "status" "text" NOT NULL,
    "total" numeric(10,2) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'ILS'::"text" NOT NULL,
    "items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "customer_email" "text",
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "utm_source" "text",
    "utm_medium" "text",
    "utm_campaign" "text",
    "utm_content" "text",
    "utm_term" "text",
    "tracking_type" "text",
    "gclid" "text",
    "customer_note" "text"
);


ALTER TABLE "public"."woo_orders" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."mx_web_orders" WITH ("security_invoker"='true') AS
 WITH "sales" AS MATERIALIZED (
         SELECT "mflow_revenue"."woocommerce_order_id",
            "min"((("mflow_revenue"."transaction_date" AT TIME ZONE 'Asia/Jerusalem'::"text"))::"date") AS "day",
            "round"("sum"("mflow_revenue"."line_revenue_exc_tax"), 2) AS "revenue_ex_vat"
           FROM "public"."mflow_revenue"
          WHERE (("mflow_revenue"."channel" = 'ecosite'::"text") AND ("mflow_revenue"."woocommerce_order_id" IS NOT NULL))
          GROUP BY "mflow_revenue"."woocommerce_order_id"
        ), "camps" AS MATERIALIZED (
         SELECT "mx_campaigns"."platform",
            "mx_campaigns"."campaign_id",
            "public"."mx_norm"("mx_campaigns"."name") AS "nname"
           FROM "public"."mx_campaigns"
        ), "by_name" AS MATERIALIZED (
         SELECT "camps"."platform",
            "camps"."nname",
            "min"("camps"."campaign_id") AS "campaign_id"
           FROM "camps"
          WHERE ("camps"."nname" IS NOT NULL)
          GROUP BY "camps"."platform", "camps"."nname"
        ), "classified" AS MATERIALIZED (
         SELECT "s"."woocommerce_order_id" AS "woo_order_id",
            "s"."day",
            "s"."revenue_ex_vat",
            "w"."customer_email",
            "w"."utm_source",
            "w"."utm_medium",
            "w"."utm_campaign",
            "w"."gclid",
            ("w"."woo_order_id" IS NULL) AS "missing_woo_row",
                CASE
                    WHEN (("w"."gclid" IS NOT NULL) OR (("lower"(COALESCE("w"."utm_source", ''::"text")) ~~ '%google%'::"text") AND ("lower"(COALESCE("w"."utm_medium", ''::"text")) ~ '(cpc|ppc|paid|pmax|shopping)'::"text"))) THEN 'google_ads'::"text"
                    WHEN (("lower"(COALESCE("w"."utm_source", ''::"text")) ~ '(facebook|^fb$|instagram|^ig$|meta)'::"text") AND ("lower"(COALESCE("w"."utm_medium", ''::"text")) ~ '(cpc|cpm|paid|ads?$|paid_social)'::"text")) THEN 'meta_ads'::"text"
                    WHEN (("lower"(COALESCE("w"."utm_source", ''::"text")) = 'email'::"text") OR ("lower"(COALESCE("w"."utm_medium", ''::"text")) = 'email'::"text")) THEN 'email'::"text"
                    WHEN ("w"."tracking_type" = 'organic'::"text") THEN 'organic_search'::"text"
                    WHEN ("lower"(COALESCE("w"."utm_source", ''::"text")) ~ '(facebook|^fb$|instagram|^ig$|meta)'::"text") THEN 'social'::"text"
                    WHEN ("w"."tracking_type" = 'referral'::"text") THEN 'referral'::"text"
                    WHEN ("w"."tracking_type" = 'typein'::"text") THEN 'direct'::"text"
                    ELSE 'other'::"text"
                END AS "source_group",
            TRIM(BOTH FROM "w"."utm_campaign") AS "utm_campaign_trim",
            "public"."mx_norm"("w"."utm_campaign") AS "utm_campaign_norm"
           FROM ("sales" "s"
             LEFT JOIN "public"."woo_orders" "w" ON (("w"."woo_order_id" = "s"."woocommerce_order_id")))
        ), "p" AS MATERIALIZED (
         SELECT "c"."woo_order_id",
            "c"."day",
            "c"."revenue_ex_vat",
            "c"."customer_email",
            "c"."utm_source",
            "c"."utm_medium",
            "c"."utm_campaign",
            "c"."gclid",
            "c"."missing_woo_row",
            "c"."source_group",
            "c"."utm_campaign_trim",
            "c"."utm_campaign_norm",
                CASE "c"."source_group"
                    WHEN 'google_ads'::"text" THEN 'google'::"text"
                    WHEN 'meta_ads'::"text" THEN 'meta'::"text"
                    ELSE NULL::"text"
                END AS "ad_platform"
           FROM "classified" "c"
        )
 SELECT "p"."woo_order_id",
    "p"."day",
    "p"."revenue_ex_vat",
    "p"."customer_email",
    "p"."source_group",
    "p"."utm_source",
    "p"."utm_medium",
    "p"."utm_campaign",
    "p"."gclid",
    "p"."missing_woo_row",
    "p"."ad_platform",
    COALESCE("gm"."campaign_id", "byid"."campaign_id", "bn"."campaign_id") AS "campaign_id",
        CASE
            WHEN ("gm"."campaign_id" IS NOT NULL) THEN 'gclid'::"text"
            WHEN ("byid"."campaign_id" IS NOT NULL) THEN 'utm_campaign_id'::"text"
            WHEN ("bn"."campaign_id" IS NOT NULL) THEN 'utm_campaign_name'::"text"
            WHEN ("p"."ad_platform" IS NOT NULL) THEN 'unattributed'::"text"
            ELSE NULL::"text"
        END AS "attribution"
   FROM ((("p"
     LEFT JOIN "public"."google_click_mapping" "gm" ON ((("p"."ad_platform" = 'google'::"text") AND ("gm"."gclid" = "p"."gclid"))))
     LEFT JOIN "camps" "byid" ON ((("p"."ad_platform" IS NOT NULL) AND ("byid"."platform" = "p"."ad_platform") AND ("byid"."campaign_id" = "p"."utm_campaign_trim"))))
     LEFT JOIN "by_name" "bn" ON ((("p"."ad_platform" IS NOT NULL) AND ("bn"."platform" = "p"."ad_platform") AND ("bn"."nname" = "p"."utm_campaign_norm"))));


ALTER VIEW "public"."mx_web_orders" OWNER TO "postgres";


COMMENT ON VIEW "public"."mx_web_orders" IS 'One row per real web order (MFlow ecosite, ex-VAT) with its traffic source and, for paid traffic, the campaign it is attributed to (gclid, then utm_campaign as id or name). attribution = unattributed means paid traffic we could not place.';



CREATE TABLE IF NOT EXISTS "public"."oauth_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "platform" "text" NOT NULL,
    "access_token" "text" NOT NULL,
    "refresh_token" "text",
    "expires_at" timestamp with time zone,
    "account_name" "text",
    "account_id" "text",
    "meta" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."oauth_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."opening_shift_confirmations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "schedule_id" bigint NOT NULL,
    "shift_date" "date" NOT NULL,
    "day_code" "text" NOT NULL,
    "employee_name" "text" NOT NULL,
    "telegram_id" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "sent_at" timestamp with time zone,
    "reminder_count" integer DEFAULT 0 NOT NULL,
    "last_reminded_at" timestamp with time zone,
    "confirmed_at" timestamp with time zone,
    "manager_alerted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "opening_shift_confirmations_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'confirmed'::"text"])))
);


ALTER TABLE "public"."opening_shift_confirmations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."operators" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "user_id" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."operators" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."operators_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."operators_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."operators_id_seq" OWNED BY "public"."operators"."id";



CREATE TABLE IF NOT EXISTS "public"."ops_profile" (
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "description" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."ops_profile" OWNER TO "postgres";


COMMENT ON TABLE "public"."ops_profile" IS 'Non-secret operating context for AI sessions. Never store credentials here — use Vault.';



CREATE TABLE IF NOT EXISTS "public"."origins" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "weight_loss" numeric NOT NULL,
    "cost_per_kg" numeric NOT NULL,
    "stock" numeric DEFAULT 0,
    "roasted_stock" numeric DEFAULT 0,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "user_id" "text" NOT NULL,
    "min_stock" numeric(10,2) DEFAULT 10.0,
    "last_synced_at" timestamp with time zone,
    "critical_stock" numeric DEFAULT 0,
    "daily_average" numeric DEFAULT 0,
    CONSTRAINT "origins_cost_per_kg_check" CHECK (("cost_per_kg" >= (0)::numeric)),
    CONSTRAINT "origins_roasted_stock_check" CHECK (("roasted_stock" >= (0)::numeric)),
    CONSTRAINT "origins_stock_check" CHECK (("stock" >= (0)::numeric)),
    CONSTRAINT "origins_weight_loss_check" CHECK ((("weight_loss" >= (0)::numeric) AND ("weight_loss" <= (100)::numeric)))
);


ALTER TABLE "public"."origins" OWNER TO "postgres";


COMMENT ON COLUMN "public"."origins"."min_stock" IS 'Minimum stock threshold in kg - triggers low stock alert';



CREATE SEQUENCE IF NOT EXISTS "public"."origins_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."origins_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."origins_id_seq" OWNED BY "public"."origins"."id";



CREATE TABLE IF NOT EXISTS "public"."packing_logs" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "product_id" bigint,
    "product_name" "text" NOT NULL,
    "bags_count" integer NOT NULL,
    "roasted_deducted" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "reported_by" "text",
    "packed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."packing_logs" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."packing_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."packing_logs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."packing_logs_id_seq" OWNED BY "public"."packing_logs"."id";



CREATE TABLE IF NOT EXISTS "public"."pending_orders" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "customer_name" "text" NOT NULL,
    "product_id" bigint,
    "product_name" "text" NOT NULL,
    "quantity_bags" integer NOT NULL,
    "expected_date" "date",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "customer_id" bigint
);


ALTER TABLE "public"."pending_orders" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."pending_orders_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."pending_orders_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."pending_orders_id_seq" OWNED BY "public"."pending_orders"."id";



CREATE TABLE IF NOT EXISTS "public"."product_reviews" (
    "review_id" "text" NOT NULL,
    "product_slug" "text",
    "product_name" "text",
    "product_category" "text",
    "rating" integer,
    "author" "text",
    "title" "text",
    "body" "text",
    "verified_buyer" boolean,
    "created_date" "date",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."product_reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "size" integer NOT NULL,
    "type" "text" NOT NULL,
    "description" "text",
    "recipe" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "user_id" "text" NOT NULL,
    "sku" "text",
    "packed_stock" integer DEFAULT 0 NOT NULL,
    "min_packed_stock" integer DEFAULT 0 NOT NULL,
    "last_synced_at" timestamp with time zone,
    CONSTRAINT "products_size_check" CHECK (("size" > 0)),
    CONSTRAINT "products_type_check" CHECK (("type" = ANY (ARRAY['single'::"text", 'blend'::"text"])))
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."products_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."products_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."products_id_seq" OWNED BY "public"."products"."id";



CREATE TABLE IF NOT EXISTS "public"."roast_checklist_templates" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "name" "text" DEFAULT 'רשימת קלייה'::"text" NOT NULL,
    "variables" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "steps" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."roast_checklist_templates" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."roast_checklist_templates_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."roast_checklist_templates_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."roast_checklist_templates_id_seq" OWNED BY "public"."roast_checklist_templates"."id";



CREATE TABLE IF NOT EXISTS "public"."roast_components" (
    "id" bigint NOT NULL,
    "roast_id" bigint NOT NULL,
    "origin_id" bigint NOT NULL,
    "green_weight_used" numeric NOT NULL
);


ALTER TABLE "public"."roast_components" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."roast_components_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."roast_components_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."roast_components_id_seq" OWNED BY "public"."roast_components"."id";



CREATE TABLE IF NOT EXISTS "public"."roast_profile_ingredients" (
    "id" bigint NOT NULL,
    "profile_id" bigint NOT NULL,
    "origin_id" bigint NOT NULL,
    "percentage" numeric NOT NULL
);


ALTER TABLE "public"."roast_profile_ingredients" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."roast_profile_ingredients_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."roast_profile_ingredients_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."roast_profile_ingredients_id_seq" OWNED BY "public"."roast_profile_ingredients"."id";



CREATE TABLE IF NOT EXISTS "public"."roast_profiles" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "roast_level" "text" DEFAULT 'none'::"text" NOT NULL,
    "roasted_stock" numeric DEFAULT 0 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone,
    "daily_average" numeric DEFAULT 0,
    "min_stock" numeric DEFAULT 0
);


ALTER TABLE "public"."roast_profiles" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."roast_profiles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."roast_profiles_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."roast_profiles_id_seq" OWNED BY "public"."roast_profiles"."id";



CREATE TABLE IF NOT EXISTS "public"."roasts" (
    "id" bigint NOT NULL,
    "origin_id" bigint,
    "green_weight" numeric NOT NULL,
    "roasted_weight" numeric NOT NULL,
    "operator" "text" NOT NULL,
    "date" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone,
    "user_id" "text" NOT NULL,
    "batch_number" "text",
    "roast_profile_id" bigint,
    "color_reading" numeric,
    "charge_et" numeric,
    "charge_bt" numeric,
    "drop_et" numeric,
    "drop_bt" numeric,
    "artisan_uuid" "text",
    CONSTRAINT "roasts_green_weight_check" CHECK (("green_weight" > (0)::numeric)),
    CONSTRAINT "roasts_roasted_weight_check" CHECK (("roasted_weight" > (0)::numeric))
);


ALTER TABLE "public"."roasts" OWNER TO "postgres";


COMMENT ON COLUMN "public"."roasts"."charge_et" IS 'Artisan CHARGE_ET — טמפ'' הטענה, °C';



COMMENT ON COLUMN "public"."roasts"."charge_bt" IS 'Artisan CHARGE_BT — bean temp at charge, °C';



COMMENT ON COLUMN "public"."roasts"."drop_et" IS 'Artisan DROP_ET — env temp at drop, °C';



COMMENT ON COLUMN "public"."roasts"."drop_bt" IS 'Artisan DROP_BT — טמפ'' סיום, °C';



COMMENT ON COLUMN "public"."roasts"."artisan_uuid" IS 'Artisan roastUUID of the uploaded file; NULL = no Artisan file on this roast';



CREATE SEQUENCE IF NOT EXISTS "public"."roasts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."roasts_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."roasts_id_seq" OWNED BY "public"."roasts"."id";



CREATE TABLE IF NOT EXISTS "public"."schedule_assignments" (
    "id" bigint NOT NULL,
    "schedule_id" bigint NOT NULL,
    "day" "text" NOT NULL,
    "employee_id" bigint,
    "position" "text" NOT NULL,
    "employee_name" "text"
);


ALTER TABLE "public"."schedule_assignments" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."schedule_assignments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."schedule_assignments_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."schedule_assignments_id_seq" OWNED BY "public"."schedule_assignments"."id";



CREATE TABLE IF NOT EXISTS "public"."schedules" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "week_start" "date" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "day_types" "jsonb",
    "roast_days" "jsonb",
    "published_at" timestamp with time zone
);


ALTER TABLE "public"."schedules" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."schedules_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."schedules_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."schedules_id_seq" OWNED BY "public"."schedules"."id";



CREATE TABLE IF NOT EXISTS "public"."seo_experiments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hypothesis" "text" NOT NULL,
    "task_type" "text" NOT NULL,
    "primary_metric" "text" NOT NULL,
    "min_lookback_days" integer DEFAULT 7 NOT NULL,
    "min_sample_size" integer DEFAULT 50 NOT NULL,
    "win_margin_multiplier" numeric DEFAULT 1.5 NOT NULL,
    "status" "text" DEFAULT 'collecting'::"text" NOT NULL,
    "winner_task_id" "uuid",
    "evaluation_summary" "jsonb",
    "recorded_learning_id" "uuid",
    "parent_experiment_id" "uuid",
    "orchestrator_run_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "evaluated_at" timestamp with time zone,
    CONSTRAINT "seo_experiments_status_check" CHECK (("status" = ANY (ARRAY['collecting'::"text", 'evaluating'::"text", 'evaluated'::"text", 'inconclusive'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."seo_experiments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."seo_learnings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scope" "text" NOT NULL,
    "insight" "text" NOT NULL,
    "evidence_task_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "created_by" "text" NOT NULL,
    "superseded_at" timestamp with time zone,
    "superseded_reason" "text",
    "superseded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "evidence_score" numeric DEFAULT 0 NOT NULL,
    "evidence_log" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL
);


ALTER TABLE "public"."seo_learnings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."seo_metrics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "logged_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text" NOT NULL,
    "metrics_payload" "jsonb" NOT NULL
);


ALTER TABLE "public"."seo_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."seo_tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "task_type" "text" NOT NULL,
    "task_subtype" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "max_attempts" integer DEFAULT 3 NOT NULL,
    "parent_task_id" "uuid",
    "depends_on" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "brief_data" "jsonb" NOT NULL,
    "result_data" "jsonb",
    "error_msg" "text",
    "locked_until" timestamp with time zone,
    "worker_id" "text",
    "scheduled_for" timestamp with time zone DEFAULT "now"() NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "orchestrator_run_id" "uuid",
    "rationale" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "experiment_id" "uuid",
    "variation_label" "text",
    CONSTRAINT "seo_tasks_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'completed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."seo_tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."shop_consumption_logs" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "source_type" "text" NOT NULL,
    "source_id" bigint NOT NULL,
    "source_name" "text" NOT NULL,
    "grams" integer NOT NULL,
    "reported_by" "text",
    "taken_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "shop_consumption_logs_grams_check" CHECK (("grams" > 0)),
    CONSTRAINT "shop_consumption_logs_source_type_check" CHECK (("source_type" = ANY (ARRAY['origin'::"text", 'profile'::"text"])))
);


ALTER TABLE "public"."shop_consumption_logs" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."shop_consumption_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."shop_consumption_logs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."shop_consumption_logs_id_seq" OWNED BY "public"."shop_consumption_logs"."id";



CREATE TABLE IF NOT EXISTS "public"."statement_imports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "kind" "text" NOT NULL,
    "account_label" "text" NOT NULL,
    "period_month" "date" NOT NULL,
    "filename" "text",
    "line_count" integer DEFAULT 0 NOT NULL,
    "total_charged" numeric(14,2),
    "imported_by" "text" DEFAULT ("auth"."jwt"() ->> 'sub'::"text") NOT NULL,
    "imported_by_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "statement_imports_kind_check" CHECK (("kind" = ANY (ARRAY['card'::"text", 'bank'::"text"])))
);


ALTER TABLE "public"."statement_imports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."statement_lines" (
    "id" bigint NOT NULL,
    "import_id" "uuid" NOT NULL,
    "txn_date" "date",
    "merchant" "text",
    "txn_amount" numeric(14,2) NOT NULL,
    "charge_amount" numeric(14,2),
    "txn_type" "text",
    "details" "text"
);


ALTER TABLE "public"."statement_lines" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."statement_lines_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."statement_lines_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."statement_lines_id_seq" OWNED BY "public"."statement_lines"."id";



CREATE TABLE IF NOT EXISTS "public"."strategic_briefs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid",
    "week_start" "date" NOT NULL,
    "summary" "text" NOT NULL,
    "diagnosis" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "top_thesis" "text",
    "recommendations" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "out_of_hands" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "strategic_briefs_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'emailed'::"text", 'reviewed'::"text"])))
);


ALTER TABLE "public"."strategic_briefs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."strategic_recommendations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "brief_id" "uuid",
    "run_id" "uuid",
    "thesis_id" "uuid",
    "title" "text" NOT NULL,
    "rationale" "text",
    "action_type" "text" DEFAULT 'none'::"text" NOT NULL,
    "action_params" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "success_metric" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'proposed'::"text" NOT NULL,
    "draft_ref" "text",
    "draft_error" "text",
    "locked_until" timestamp with time zone,
    "worker_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "revision_count" integer DEFAULT 0 NOT NULL,
    "critique_attempts" integer DEFAULT 0 NOT NULL,
    "critique_log" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "last_feedback" "text",
    "artifact_snapshot" "jsonb",
    "auto_approved" boolean DEFAULT false NOT NULL,
    CONSTRAINT "strategic_recommendations_action_type_check" CHECK (("action_type" = ANY (ARRAY['email_campaign'::"text", 'content_blog'::"text", 'content_ig'::"text", 'ad_meta'::"text", 'ad_google'::"text", 'none'::"text"]))),
    CONSTRAINT "strategic_recommendations_status_check" CHECK (("status" = ANY (ARRAY['proposed'::"text", 'approved'::"text", 'drafting'::"text", 'drafted'::"text", 'dismissed'::"text", 'failed'::"text", 'awaiting_critique'::"text", 'revising'::"text", 'exporting'::"text", 'ready_for_review'::"text", 'needs_human'::"text"])))
);


ALTER TABLE "public"."strategic_recommendations" OWNER TO "postgres";


COMMENT ON COLUMN "public"."strategic_recommendations"."critique_log" IS 'Append-only list of critic verdicts: {at, revision, pass, issues[{severity,rule,detail}], feedback, model}.';



COMMENT ON COLUMN "public"."strategic_recommendations"."artifact_snapshot" IS 'The draft under critique (text, spec, image URLs). Never base64: images are Storage URLs.';



CREATE TABLE IF NOT EXISTS "public"."strategic_theses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "thesis" "text" NOT NULL,
    "lever" "text" NOT NULL,
    "rationale" "text",
    "evidence_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "success_metric" "text" NOT NULL,
    "metric_baseline" numeric,
    "check_date" "date",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "outcome" "text",
    "superseded_by" "uuid",
    "run_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "strategic_theses_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'validated'::"text", 'refuted'::"text", 'superseded'::"text"])))
);


ALTER TABLE "public"."strategic_theses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."strategist_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "status" "text" DEFAULT 'thinking'::"text" NOT NULL,
    "trigger" "text" DEFAULT 'cron'::"text" NOT NULL,
    "week_start" "date",
    "snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "state" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "steps_taken" integer DEFAULT 0 NOT NULL,
    "max_steps" integer DEFAULT 12 NOT NULL,
    "locked_until" timestamp with time zone,
    "worker_id" "text",
    "brief_id" "uuid",
    "cost_tokens" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "strategist_runs_status_check" CHECK (("status" = ANY (ARRAY['thinking'::"text", 'brief_ready'::"text", 'failed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."strategist_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."strategist_signals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "kind" "text" NOT NULL,
    "title" "text" NOT NULL,
    "detail" "text",
    "evidence" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "blocked_decision" "text",
    "leverage" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "decline_reason" "text",
    "dedupe_key" "text",
    "run_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pr_url" "text",
    "fixer_note" "text",
    "sources" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "implementation_steps" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "effort" "text",
    "cost_estimate" "text",
    "check_metric" "text",
    CONSTRAINT "strategist_signals_kind_check" CHECK (("kind" = ANY (ARRAY['capability_request'::"text", 'bug_report'::"text", 'feature_idea'::"text", 'innovation_pitch'::"text"]))),
    CONSTRAINT "strategist_signals_pitch_shape_check" CHECK ((("kind" <> 'innovation_pitch'::"text") OR (("jsonb_typeof"("sources") = 'array'::"text") AND ("jsonb_array_length"("sources") > 0) AND ("jsonb_typeof"("implementation_steps") = 'array'::"text") AND ("jsonb_array_length"("implementation_steps") > 0) AND ("effort" IS NOT NULL) AND ("effort" = ANY (ARRAY['small'::"text", 'medium'::"text", 'large'::"text"])) AND ("check_metric" IS NOT NULL) AND ("check_metric" = ANY (ARRAY['bean_revenue'::"text", 'orders'::"text", 'repeat_purchase_rate'::"text", 'roas'::"text", 'cpa'::"text", 'email_ctr'::"text", 'organic_sessions'::"text"])) AND ("dedupe_key" IS NOT NULL) AND ("length"("dedupe_key") > 0)))),
    CONSTRAINT "strategist_signals_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'approved'::"text", 'building'::"text", 'shipped'::"text", 'declined'::"text", 'needs_human'::"text"])))
);


ALTER TABLE "public"."strategist_signals" OWNER TO "postgres";


COMMENT ON COLUMN "public"."strategist_signals"."check_metric" IS 'innovation_pitch only: the metric the pitch should move. One of bean_revenue, orders, repeat_purchase_rate, roas, cpa, email_ctr, organic_sessions.';



CREATE TABLE IF NOT EXISTS "public"."supplier_invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "supplier_name" "text",
    "supplier_tax_id" "text",
    "invoice_number" "text",
    "doc_type" "text" DEFAULT 'tax_invoice'::"text" NOT NULL,
    "invoice_date" "date",
    "amount_before_vat" numeric(12,2),
    "vat_amount" numeric(12,2),
    "total_incl_vat" numeric(12,2),
    "currency" "text" DEFAULT 'ILS'::"text" NOT NULL,
    "allocation_number" "text",
    "notes" "text",
    "file_path" "text" NOT NULL,
    "file_mime" "text" NOT NULL,
    "file_size" integer NOT NULL,
    "file_sha256" "text" NOT NULL,
    "original_filename" "text",
    "status" "text" DEFAULT 'pending_review'::"text" NOT NULL,
    "extraction" "jsonb",
    "uploaded_by" "text" NOT NULL,
    "uploaded_by_name" "text",
    "confirmed_at" timestamp with time zone,
    "booked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "possible_duplicate_of" "uuid",
    "delivery_id" "uuid",
    CONSTRAINT "supplier_invoices_doc_type_check" CHECK (("doc_type" = ANY (ARRAY['tax_invoice'::"text", 'tax_invoice_receipt'::"text", 'receipt'::"text", 'credit_note'::"text", 'transaction_invoice'::"text", 'other'::"text"]))),
    CONSTRAINT "supplier_invoices_status_check" CHECK (("status" = ANY (ARRAY['pending_review'::"text", 'confirmed'::"text"])))
);


ALTER TABLE "public"."supplier_invoices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sync_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "platform" "text" NOT NULL,
    "status" "text" NOT NULL,
    "records" integer DEFAULT 0,
    "error_msg" "text",
    "started_at" timestamp with time zone DEFAULT "now"(),
    "finished_at" timestamp with time zone,
    "stats" "jsonb"
);


ALTER TABLE "public"."sync_log" OWNER TO "postgres";


COMMENT ON COLUMN "public"."sync_log"."status" IS 'one of: running, success, partial, error. Frontend polls until != running.';



CREATE TABLE IF NOT EXISTS "public"."system_config" (
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL,
    "description" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_by" "text",
    "reasoning" "text"
);


ALTER TABLE "public"."system_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."system_logs" (
    "id" bigint NOT NULL,
    "ts" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fn" "text" NOT NULL,
    "run_id" "uuid" NOT NULL,
    "seq" integer DEFAULT 0 NOT NULL,
    "level" "text" NOT NULL,
    "event" "text",
    "message" "text" NOT NULL,
    "data" "jsonb",
    "duration_ms" integer,
    "error_name" "text",
    "error_stack" "text",
    "run_status" "text"
);


ALTER TABLE "public"."system_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."system_logs" IS 'Durable cross-function log. Written by supabase/functions/_shared/logger.ts; read with scripts/logs.sh. Purged after 30 days by the system-logs-purge-daily cron.';



COMMENT ON COLUMN "public"."system_logs"."run_id" IS 'One invocation of one function. Join lines on this to reconstruct a trace.';



COMMENT ON COLUMN "public"."system_logs"."event" IS 'Stable machine-readable step key, e.g. sync.start / woo.fetch.fail. Prefer filtering on this over message text.';



CREATE OR REPLACE VIEW "public"."system_log_runs" WITH ("security_invoker"='true') AS
 SELECT "run_id",
    "min"("fn") AS "fn",
    "min"("ts") AS "started_at",
    "max"("ts") AS "ended_at",
    "max"("duration_ms") FILTER (WHERE ("run_status" IS NOT NULL)) AS "duration_ms",
    COALESCE("max"("run_status") FILTER (WHERE ("run_status" = ANY (ARRAY['success'::"text", 'partial'::"text", 'error'::"text"]))), 'incomplete'::"text") AS "status",
    "count"(*) FILTER (WHERE ("level" = 'error'::"text")) AS "errors",
    "count"(*) FILTER (WHERE ("level" = 'warn'::"text")) AS "warnings",
    "count"(*) AS "lines"
   FROM "public"."system_logs"
  GROUP BY "run_id";


ALTER VIEW "public"."system_log_runs" OWNER TO "postgres";


COMMENT ON VIEW "public"."system_log_runs" IS 'One row per invocation. status=incomplete means the run never wrote a terminal line — it was killed mid-flight.';



CREATE SEQUENCE IF NOT EXISTS "public"."system_logs_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."system_logs_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."system_logs_id_seq" OWNED BY "public"."system_logs"."id";



CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "role" "text" DEFAULT 'employee'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "email" "text",
    "full_name" "text"
);


ALTER TABLE "public"."user_roles" OWNER TO "postgres";


ALTER TABLE "public"."user_roles" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."user_roles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."vehicle_trips" (
    "id" bigint NOT NULL,
    "employee_id" bigint,
    "driver_name" "text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp with time zone,
    "end_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "note" "text",
    "added_by" "text",
    CONSTRAINT "vehicle_trips_check" CHECK ((("ended_at" IS NULL) OR ("ended_at" >= "started_at"))),
    CONSTRAINT "vehicle_trips_check1" CHECK ((("ended_at" IS NULL) = ("end_reason" IS NULL))),
    CONSTRAINT "vehicle_trips_end_reason_check" CHECK (("end_reason" = ANY (ARRAY['returned'::"text", 'handover'::"text", 'admin'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."vehicle_trips" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."vehicle_trips_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."vehicle_trips_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."vehicle_trips_id_seq" OWNED BY "public"."vehicle_trips"."id";



CREATE TABLE IF NOT EXISTS "public"."voc_insights" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "insight_type" "text" NOT NULL,
    "pattern" "text" NOT NULL,
    "real_meaning" "text",
    "suggested_response" "text",
    "frequency" integer DEFAULT 1,
    "example_phrases" "jsonb" DEFAULT '[]'::"jsonb",
    "customer_stage" "text",
    "product_context" "text",
    "source_breakdown" "jsonb" DEFAULT '{}'::"jsonb",
    "confidence" "text" DEFAULT 'medium'::"text",
    "first_seen_at" timestamp with time zone DEFAULT "now"(),
    "last_mined_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."voc_insights" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."voc_mining_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"(),
    "finished_at" timestamp with time zone,
    "sources_processed" "jsonb",
    "insights_created" integer DEFAULT 0,
    "insights_updated" integer DEFAULT 0,
    "error_msg" "text",
    "status" "text" DEFAULT 'running'::"text"
);


ALTER TABLE "public"."voc_mining_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."waiting_customers" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "customer_name" "text" NOT NULL,
    "phone" "text",
    "product_id" bigint,
    "notes" "text",
    "notified_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "product" "text",
    "is_handled" boolean DEFAULT false
);


ALTER TABLE "public"."waiting_customers" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."waiting_customers_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."waiting_customers_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."waiting_customers_id_seq" OWNED BY "public"."waiting_customers"."id";



CREATE TABLE IF NOT EXISTS "public"."whatsapp_messages" (
    "id" bigint NOT NULL,
    "wa_message_id" "text" NOT NULL,
    "wa_id" "text" NOT NULL,
    "direction" "text" NOT NULL,
    "msg_type" "text" NOT NULL,
    "body" "text",
    "profile_name" "text",
    "referral" "jsonb",
    "run_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "whatsapp_messages_direction_check" CHECK (("direction" = ANY (ARRAY['in'::"text", 'out'::"text", 'human'::"text"])))
);


ALTER TABLE "public"."whatsapp_messages" OWNER TO "postgres";


ALTER TABLE "public"."whatsapp_messages" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."whatsapp_messages_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."woo_order_items_enriched" (
    "order_id" bigint NOT NULL,
    "line_index" integer NOT NULL,
    "product_name" "text",
    "sku" "text",
    "product_category" "text",
    "quantity" integer,
    "line_total" numeric,
    "order_date" "date",
    "utm_source" "text",
    "utm_campaign" "text",
    "gclid" "text",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."woo_order_items_enriched" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."woo_order_items_enriched_mflow_removed" (
    "order_id" bigint NOT NULL,
    "line_index" integer NOT NULL,
    "product_name" "text",
    "sku" "text",
    "product_category" "text",
    "quantity" integer,
    "line_total" numeric,
    "order_date" "date",
    "utm_source" "text",
    "utm_campaign" "text",
    "gclid" "text",
    "synced_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."woo_order_items_enriched_mflow_removed" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."woo_orders_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."woo_orders_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."woo_orders_id_seq" OWNED BY "public"."woo_orders"."id";



CREATE TABLE IF NOT EXISTS "public"."woo_orders_mflow_removed" (
    "id" bigint DEFAULT "nextval"('"public"."woo_orders_id_seq"'::"regclass") NOT NULL,
    "woo_order_id" integer NOT NULL,
    "order_date" "date" NOT NULL,
    "status" "text" NOT NULL,
    "total" numeric(10,2) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'ILS'::"text" NOT NULL,
    "items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "customer_email" "text",
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "utm_source" "text",
    "utm_medium" "text",
    "utm_campaign" "text",
    "utm_content" "text",
    "utm_term" "text",
    "tracking_type" "text",
    "gclid" "text",
    "customer_note" "text"
);


ALTER TABLE "public"."woo_orders_mflow_removed" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."woo_products" (
    "id" bigint NOT NULL,
    "user_id" "text" NOT NULL,
    "woo_id" integer NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text",
    "permalink" "text",
    "price" "text",
    "regular_price" "text",
    "sale_price" "text",
    "short_description" "text",
    "image_url" "text",
    "image_urls" "text"[],
    "categories" "text"[],
    "stock_status" "text" DEFAULT 'instock'::"text",
    "sku" "text",
    "synced_at" timestamp with time zone DEFAULT "now"(),
    "description" "text"
);


ALTER TABLE "public"."woo_products" OWNER TO "postgres";


ALTER TABLE "public"."woo_products" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."woo_products_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE ONLY "public"."app_settings" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."app_settings_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."artisan_profiles" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."artisan_profiles_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."availability_submissions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."availability_submissions_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."b2b_customers" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."b2b_customers_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."bag_allocations" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."bag_allocations_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."competitor_pages" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."competitor_pages_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."contact_group_members" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."contact_group_members_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."contact_groups" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."contact_groups_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."cost_settings" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."cost_settings_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."employees" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."employees_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."google_ad_drafts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."google_ad_drafts_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."inventory_adjustments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."inventory_adjustments_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."ledger_lines" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."ledger_lines_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."meta_ad_drafts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."meta_ad_drafts_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."minuto_blog_posts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."minuto_blog_posts_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."operators" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."operators_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."origins" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."origins_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."packing_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."packing_logs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."pending_orders" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."pending_orders_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."products" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."products_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."roast_checklist_templates" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."roast_checklist_templates_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."roast_components" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."roast_components_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."roast_profile_ingredients" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."roast_profile_ingredients_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."roast_profiles" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."roast_profiles_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."roasts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."roasts_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."schedule_assignments" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."schedule_assignments_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."schedules" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."schedules_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."shop_consumption_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."shop_consumption_logs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."statement_lines" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."statement_lines_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."system_logs" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."system_logs_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."vehicle_trips" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."vehicle_trips_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."waiting_customers" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."waiting_customers_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."woo_orders" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."woo_orders_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."advisor_completed_actions"
    ADD CONSTRAINT "advisor_completed_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."advisor_completed_actions"
    ADD CONSTRAINT "advisor_completed_actions_week_start_action_id_key" UNIQUE ("week_start", "action_id");



ALTER TABLE ONLY "public"."advisor_reports"
    ADD CONSTRAINT "advisor_reports_agent_type_week_start_key" UNIQUE ("agent_type", "week_start");



ALTER TABLE ONLY "public"."advisor_reports"
    ADD CONSTRAINT "advisor_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."advisor_scores"
    ADD CONSTRAINT "advisor_scores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."advisor_scores"
    ADD CONSTRAINT "advisor_scores_week_start_key" UNIQUE ("week_start");



ALTER TABLE ONLY "public"."agent_cost_ledger"
    ADD CONSTRAINT "agent_cost_ledger_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."agent_missions"
    ADD CONSTRAINT "agent_missions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_visibility_probes"
    ADD CONSTRAINT "ai_visibility_probes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_visibility_queries"
    ADD CONSTRAINT "ai_visibility_queries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app_settings"
    ADD CONSTRAINT "app_settings_key_key" UNIQUE ("key");



ALTER TABLE ONLY "public"."app_settings"
    ADD CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."artisan_profiles"
    ADD CONSTRAINT "artisan_profiles_artisan_uuid_key" UNIQUE ("artisan_uuid");



ALTER TABLE ONLY "public"."artisan_profiles"
    ADD CONSTRAINT "artisan_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."artisan_profiles"
    ADD CONSTRAINT "artisan_profiles_roast_id_key" UNIQUE ("roast_id");



ALTER TABLE ONLY "public"."attendance_events"
    ADD CONSTRAINT "attendance_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."attendance_holidays"
    ADD CONSTRAINT "attendance_holidays_pkey" PRIMARY KEY ("holiday_date");



ALTER TABLE ONLY "public"."attendance_reminders_sent"
    ADD CONSTRAINT "attendance_reminders_sent_pkey" PRIMARY KEY ("employee_id", "shift_date", "position", "reminder_type");



ALTER TABLE ONLY "public"."attendance_settings"
    ADD CONSTRAINT "attendance_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."availability_submissions"
    ADD CONSTRAINT "availability_submissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."b2b_customers"
    ADD CONSTRAINT "b2b_customers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bag_allocations"
    ADD CONSTRAINT "bag_allocations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bot_rate_limit"
    ADD CONSTRAINT "bot_rate_limit_pkey" PRIMARY KEY ("telegram_id", "bot_name");



ALTER TABLE ONLY "public"."campaign_events"
    ADD CONSTRAINT "campaign_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."coffee_bot_pending_packing"
    ADD CONSTRAINT "coffee_bot_pending_packing_pkey" PRIMARY KEY ("telegram_id");



ALTER TABLE ONLY "public"."coffee_sales_daily"
    ADD CONSTRAINT "coffee_sales_daily_pkey" PRIMARY KEY ("day", "sku");



ALTER TABLE ONLY "public"."competitor_pages"
    ADD CONSTRAINT "competitor_pages_domain_key" UNIQUE ("domain");



ALTER TABLE ONLY "public"."competitor_pages"
    ADD CONSTRAINT "competitor_pages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_group_members"
    ADD CONSTRAINT "contact_group_members_group_id_email_key" UNIQUE ("group_id", "email");



ALTER TABLE ONLY "public"."contact_group_members"
    ADD CONSTRAINT "contact_group_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contact_groups"
    ADD CONSTRAINT "contact_groups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cost_settings"
    ADD CONSTRAINT "cost_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cost_settings"
    ADD CONSTRAINT "cost_settings_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."customer_orders"
    ADD CONSTRAINT "customer_orders_pkey" PRIMARY KEY ("woo_order_id");



ALTER TABLE ONLY "public"."customer_rfm"
    ADD CONSTRAINT "customer_rfm_pkey" PRIMARY KEY ("email");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_automation_templates"
    ADD CONSTRAINT "email_automation_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."email_automation_templates"
    ADD CONSTRAINT "email_automation_templates_trigger_type_key" UNIQUE ("trigger_type");



ALTER TABLE ONLY "public"."email_automations"
    ADD CONSTRAINT "email_automations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."employees"
    ADD CONSTRAINT "employees_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."facebook_comments"
    ADD CONSTRAINT "facebook_comments_pkey" PRIMARY KEY ("comment_id");



ALTER TABLE ONLY "public"."form_submissions"
    ADD CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ga4_pages_daily"
    ADD CONSTRAINT "ga4_pages_daily_pkey" PRIMARY KEY ("date", "page_path", "channel_group");



ALTER TABLE ONLY "public"."gemini_prompt_cache"
    ADD CONSTRAINT "gemini_prompt_cache_pkey" PRIMARY KEY ("cache_key");



ALTER TABLE ONLY "public"."google_account_settings"
    ADD CONSTRAINT "google_account_settings_pkey" PRIMARY KEY ("customer_id");



ALTER TABLE ONLY "public"."google_ad_drafts"
    ADD CONSTRAINT "google_ad_drafts_idea_id_key" UNIQUE ("idea_id");



ALTER TABLE ONLY "public"."google_ad_drafts"
    ADD CONSTRAINT "google_ad_drafts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."google_ad_group_daily"
    ADD CONSTRAINT "google_ad_group_daily_pkey" PRIMARY KEY ("ad_group_id", "date");



ALTER TABLE ONLY "public"."google_ad_group_settings"
    ADD CONSTRAINT "google_ad_group_settings_pkey" PRIMARY KEY ("ad_group_id");



ALTER TABLE ONLY "public"."google_ads"
    ADD CONSTRAINT "google_ads_ad_id_key" UNIQUE ("ad_id");



ALTER TABLE ONLY "public"."google_ads"
    ADD CONSTRAINT "google_ads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."google_audiences"
    ADD CONSTRAINT "google_audiences_pkey" PRIMARY KEY ("audience_id");



ALTER TABLE ONLY "public"."google_business_reviews"
    ADD CONSTRAINT "google_business_reviews_pkey" PRIMARY KEY ("review_id");



ALTER TABLE ONLY "public"."google_campaign_settings"
    ADD CONSTRAINT "google_campaign_settings_pkey" PRIMARY KEY ("campaign_id");



ALTER TABLE ONLY "public"."google_campaigns"
    ADD CONSTRAINT "google_campaigns_campaign_id_date_key" UNIQUE ("campaign_id", "date");



ALTER TABLE ONLY "public"."google_campaigns"
    ADD CONSTRAINT "google_campaigns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."google_click_mapping"
    ADD CONSTRAINT "google_click_mapping_pkey" PRIMARY KEY ("gclid");



ALTER TABLE ONLY "public"."google_conversion_actions"
    ADD CONSTRAINT "google_conversion_actions_pkey" PRIMARY KEY ("action_id");



ALTER TABLE ONLY "public"."google_keywords_daily"
    ADD CONSTRAINT "google_keywords_daily_pkey" PRIMARY KEY ("campaign_id", "ad_group_id", "keyword_text", "match_type", "date");



ALTER TABLE ONLY "public"."google_search_console"
    ADD CONSTRAINT "google_search_console_date_keyword_page_key" UNIQUE NULLS NOT DISTINCT ("date", "keyword", "page");



ALTER TABLE ONLY "public"."google_search_console"
    ADD CONSTRAINT "google_search_console_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."google_search_terms"
    ADD CONSTRAINT "google_search_terms_pkey" PRIMARY KEY ("campaign_id", "ad_group_id", "search_term", "date");



ALTER TABLE ONLY "public"."industry_articles"
    ADD CONSTRAINT "industry_articles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."industry_articles"
    ADD CONSTRAINT "industry_articles_url_key" UNIQUE ("url");



ALTER TABLE ONLY "public"."industry_sources"
    ADD CONSTRAINT "industry_sources_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."industry_sources"
    ADD CONSTRAINT "industry_sources_rss_url_key" UNIQUE ("rss_url");



ALTER TABLE ONLY "public"."instagram_comments"
    ADD CONSTRAINT "instagram_comments_pkey" PRIMARY KEY ("comment_id");



ALTER TABLE ONLY "public"."instagram_dm_threads"
    ADD CONSTRAINT "instagram_dm_threads_pkey" PRIMARY KEY ("conversation_id");



ALTER TABLE ONLY "public"."instagram_dms"
    ADD CONSTRAINT "instagram_dms_pkey" PRIMARY KEY ("message_id");



ALTER TABLE ONLY "public"."inventory_adjustments"
    ADD CONSTRAINT "inventory_adjustments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invoice_deliveries"
    ADD CONSTRAINT "invoice_deliveries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."job_leases"
    ADD CONSTRAINT "job_leases_pkey" PRIMARY KEY ("name");



ALTER TABLE ONLY "public"."keyword_ideas"
    ADD CONSTRAINT "keyword_ideas_pkey" PRIMARY KEY ("keyword");



ALTER TABLE ONLY "public"."ledger_imports"
    ADD CONSTRAINT "ledger_imports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ledger_lines"
    ADD CONSTRAINT "ledger_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."market_research"
    ADD CONSTRAINT "market_research_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."market_research"
    ADD CONSTRAINT "market_research_research_date_source_key" UNIQUE ("research_date", "source");



ALTER TABLE ONLY "public"."marketing_contacts"
    ADD CONSTRAINT "marketing_contacts_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."marketing_contacts"
    ADD CONSTRAINT "marketing_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."messaging_identity_blocklist"
    ADD CONSTRAINT "messaging_identity_blocklist_pkey" PRIMARY KEY ("kind", "value");



ALTER TABLE ONLY "public"."messaging_reminder_prefs"
    ADD CONSTRAINT "messaging_reminder_prefs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meta_account_settings"
    ADD CONSTRAINT "meta_account_settings_pkey" PRIMARY KEY ("ad_account_id");



ALTER TABLE ONLY "public"."meta_ad_adsets"
    ADD CONSTRAINT "meta_ad_adsets_pkey" PRIMARY KEY ("adset_id");



ALTER TABLE ONLY "public"."meta_ad_campaigns"
    ADD CONSTRAINT "meta_ad_campaigns_campaign_id_date_key" UNIQUE ("campaign_id", "date");



ALTER TABLE ONLY "public"."meta_ad_campaigns"
    ADD CONSTRAINT "meta_ad_campaigns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meta_ad_daily"
    ADD CONSTRAINT "meta_ad_daily_pkey" PRIMARY KEY ("ad_id", "date");



ALTER TABLE ONLY "public"."meta_ad_drafts"
    ADD CONSTRAINT "meta_ad_drafts_idea_id_key" UNIQUE ("idea_id");



ALTER TABLE ONLY "public"."meta_ad_drafts"
    ADD CONSTRAINT "meta_ad_drafts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meta_ads"
    ADD CONSTRAINT "meta_ads_pkey" PRIMARY KEY ("ad_id");



ALTER TABLE ONLY "public"."meta_adset_daily"
    ADD CONSTRAINT "meta_adset_daily_pkey" PRIMARY KEY ("adset_id", "date");



ALTER TABLE ONLY "public"."meta_daily_insights"
    ADD CONSTRAINT "meta_daily_insights_date_key" UNIQUE ("date");



ALTER TABLE ONLY "public"."meta_daily_insights"
    ADD CONSTRAINT "meta_daily_insights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meta_organic_posts"
    ADD CONSTRAINT "meta_organic_posts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meta_organic_posts"
    ADD CONSTRAINT "meta_organic_posts_post_id_key" UNIQUE ("post_id");



ALTER TABLE ONLY "public"."meta_placement_daily"
    ADD CONSTRAINT "meta_placement_daily_pkey" PRIMARY KEY ("adset_id", "publisher_platform", "platform_position", "date");



ALTER TABLE ONLY "public"."mflow_sell_events"
    ADD CONSTRAINT "mflow_sell_events_pkey" PRIMARY KEY ("mflow_sell_id");



ALTER TABLE ONLY "public"."mflow_sell_lines"
    ADD CONSTRAINT "mflow_sell_lines_pkey" PRIMARY KEY ("mflow_sell_id", "line_id", "is_return");



ALTER TABLE ONLY "public"."minuto_blog_posts"
    ADD CONSTRAINT "minuto_blog_posts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."minuto_blog_posts"
    ADD CONSTRAINT "minuto_blog_posts_url_key" UNIQUE ("url");



ALTER TABLE ONLY "public"."oauth_tokens"
    ADD CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."oauth_tokens"
    ADD CONSTRAINT "oauth_tokens_platform_key" UNIQUE ("platform");



ALTER TABLE ONLY "public"."opening_shift_confirmations"
    ADD CONSTRAINT "opening_shift_confirmations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."operators"
    ADD CONSTRAINT "operators_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ops_profile"
    ADD CONSTRAINT "ops_profile_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."origins"
    ADD CONSTRAINT "origins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."packing_logs"
    ADD CONSTRAINT "packing_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pending_orders"
    ADD CONSTRAINT "pending_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_reviews"
    ADD CONSTRAINT "product_reviews_pkey" PRIMARY KEY ("review_id");



ALTER TABLE ONLY "public"."product_sku_map"
    ADD CONSTRAINT "product_sku_map_pkey" PRIMARY KEY ("sku");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."roast_checklist_templates"
    ADD CONSTRAINT "roast_checklist_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."roast_components"
    ADD CONSTRAINT "roast_components_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."roast_profile_ingredients"
    ADD CONSTRAINT "roast_profile_ingredients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."roast_profiles"
    ADD CONSTRAINT "roast_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."roasts"
    ADD CONSTRAINT "roasts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedule_assignments"
    ADD CONSTRAINT "schedule_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedule_assignments"
    ADD CONSTRAINT "schedule_assignments_unique" UNIQUE ("schedule_id", "day", "position");



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."seo_experiments"
    ADD CONSTRAINT "seo_experiments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."seo_learnings"
    ADD CONSTRAINT "seo_learnings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."seo_metrics"
    ADD CONSTRAINT "seo_metrics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."seo_tasks"
    ADD CONSTRAINT "seo_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."shop_consumption_logs"
    ADD CONSTRAINT "shop_consumption_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."statement_imports"
    ADD CONSTRAINT "statement_imports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."statement_lines"
    ADD CONSTRAINT "statement_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."strategic_briefs"
    ADD CONSTRAINT "strategic_briefs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."strategic_recommendations"
    ADD CONSTRAINT "strategic_recommendations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."strategic_theses"
    ADD CONSTRAINT "strategic_theses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."strategist_runs"
    ADD CONSTRAINT "strategist_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."strategist_signals"
    ADD CONSTRAINT "strategist_signals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplier_invoices"
    ADD CONSTRAINT "supplier_invoices_file_path_key" UNIQUE ("file_path");



ALTER TABLE "public"."supplier_invoices"
    ADD CONSTRAINT "supplier_invoices_invoice_date_sane" CHECK ((("invoice_date" IS NULL) OR ("invoice_date" >= '2000-01-01'::"date"))) NOT VALID;



ALTER TABLE ONLY "public"."supplier_invoices"
    ADD CONSTRAINT "supplier_invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sync_log"
    ADD CONSTRAINT "sync_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."system_config"
    ADD CONSTRAINT "system_config_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."system_logs"
    ADD CONSTRAINT "system_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."vehicle_trips"
    ADD CONSTRAINT "vehicle_trips_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voc_insights"
    ADD CONSTRAINT "voc_insights_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."voc_mining_runs"
    ADD CONSTRAINT "voc_mining_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."waiting_customers"
    ADD CONSTRAINT "waiting_customers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."whatsapp_messages"
    ADD CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."whatsapp_messages"
    ADD CONSTRAINT "whatsapp_messages_wa_message_id_key" UNIQUE ("wa_message_id");



ALTER TABLE ONLY "public"."woo_order_items_enriched"
    ADD CONSTRAINT "woo_order_items_enriched_pkey" PRIMARY KEY ("order_id", "line_index");



ALTER TABLE ONLY "public"."woo_orders"
    ADD CONSTRAINT "woo_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."woo_orders"
    ADD CONSTRAINT "woo_orders_woo_order_id_key" UNIQUE ("woo_order_id");



ALTER TABLE ONLY "public"."woo_products"
    ADD CONSTRAINT "woo_products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."woo_products"
    ADD CONSTRAINT "woo_products_user_id_woo_id_key" UNIQUE ("user_id", "woo_id");



CREATE INDEX "agent_cost_ledger_created_idx" ON "public"."agent_cost_ledger" USING "btree" ("created_at" DESC);



CREATE INDEX "ai_visibility_probes_provider_recent_idx" ON "public"."ai_visibility_probes" USING "btree" ("llm_provider", "ran_at" DESC);



CREATE INDEX "ai_visibility_probes_query_recent_idx" ON "public"."ai_visibility_probes" USING "btree" ("query_id", "ran_at" DESC);



CREATE INDEX "ai_visibility_probes_recent_mentions_idx" ON "public"."ai_visibility_probes" USING "btree" ("ran_at" DESC) WHERE ("error" IS NULL);



CREATE INDEX "attendance_events_at_idx" ON "public"."attendance_events" USING "btree" ("event_at" DESC);



CREATE INDEX "attendance_events_emp_at_idx" ON "public"."attendance_events" USING "btree" ("employee_id", "event_at" DESC);



CREATE UNIQUE INDEX "b2b_customers_name_key" ON "public"."b2b_customers" USING "btree" ("lower"("btrim"("name")));



CREATE INDEX "bag_allocations_open_idx" ON "public"."bag_allocations" USING "btree" ("product_id") WHERE ("status" = 'allocated'::"text");



CREATE INDEX "bot_rate_limit_window_idx" ON "public"."bot_rate_limit" USING "btree" ("window_start");



CREATE INDEX "chat_messages_created_at_idx" ON "public"."chat_messages" USING "btree" ("created_at");



CREATE INDEX "chat_messages_session_idx" ON "public"."chat_messages" USING "btree" ("session_id", "created_at");



CREATE INDEX "coffee_bot_pending_packing_created_idx" ON "public"."coffee_bot_pending_packing" USING "btree" ("created_at");



CREATE INDEX "coffee_sales_daily_day_idx" ON "public"."coffee_sales_daily" USING "btree" ("day");



CREATE INDEX "competitor_pages_domain_idx" ON "public"."competitor_pages" USING "btree" ("domain") WHERE ("domain" IS NOT NULL);



CREATE INDEX "competitor_pages_fb_page_id_idx" ON "public"."competitor_pages" USING "btree" ("fb_page_id") WHERE ("fb_page_id" IS NOT NULL);



CREATE INDEX "contact_group_members_group_id_idx" ON "public"."contact_group_members" USING "btree" ("group_id");



CREATE INDEX "contact_groups_is_test_group_idx" ON "public"."contact_groups" USING "btree" ("is_test_group") WHERE ("is_test_group" = true);



CREATE INDEX "customer_orders_customer_idx" ON "public"."customer_orders" USING "btree" ("customer_id", "date_created");



CREATE INDEX "customer_orders_modified_idx" ON "public"."customer_orders" USING "btree" ("date_modified" DESC);



CREATE INDEX "customer_orders_unresolved_idx" ON "public"."customer_orders" USING "btree" ("woo_order_id") WHERE (("customer_id" IS NULL) AND (NOT "resolve_skipped"));



CREATE INDEX "customer_rfm_last_order_idx" ON "public"."customer_rfm" USING "btree" ("last_order_date" DESC);



CREATE INDEX "customer_rfm_segment_idx" ON "public"."customer_rfm" USING "btree" ("segment");



CREATE INDEX "customers_emails_gin" ON "public"."customers" USING "gin" ("emails");



CREATE INDEX "customers_live_idx" ON "public"."customers" USING "btree" ("id") WHERE ("merged_into" IS NULL);



CREATE INDEX "customers_phones_gin" ON "public"."customers" USING "gin" ("phones");



CREATE INDEX "customers_wooids_gin" ON "public"."customers" USING "gin" ("woo_customer_ids");



CREATE INDEX "ga4_pages_daily_channel_date_idx" ON "public"."ga4_pages_daily" USING "btree" ("channel_group", "date" DESC);



CREATE INDEX "ga4_pages_daily_page_date_idx" ON "public"."ga4_pages_daily" USING "btree" ("page_path", "date" DESC);



CREATE INDEX "gemini_prompt_cache_expiry_idx" ON "public"."gemini_prompt_cache" USING "btree" ("expires_at");



CREATE INDEX "gsc_clicks_idx" ON "public"."google_search_console" USING "btree" ("clicks" DESC);



CREATE INDEX "gsc_date_idx" ON "public"."google_search_console" USING "btree" ("date" DESC);



CREATE INDEX "gsc_keyword_idx" ON "public"."google_search_console" USING "btree" ("keyword");



CREATE INDEX "idx_agent_missions_active" ON "public"."agent_missions" USING "btree" ("status", "locked_until") WHERE ("status" = 'active'::"text");



CREATE INDEX "idx_campaign_events_campaign" ON "public"."campaign_events" USING "btree" ("campaign_id", "event_type");



CREATE INDEX "idx_campaign_events_dedup" ON "public"."campaign_events" USING "btree" ("resend_email_id", "event_type");



CREATE INDEX "idx_email_automations_pending" ON "public"."email_automations" USING "btree" ("status", "scheduled_for") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_email_automations_trigger_sent" ON "public"."email_automations" USING "btree" ("trigger_type", "sent_at" DESC NULLS LAST);



CREATE INDEX "idx_fb_comments_post" ON "public"."facebook_comments" USING "btree" ("post_id");



CREATE INDEX "idx_fb_comments_time" ON "public"."facebook_comments" USING "btree" ("created_time" DESC);



CREATE INDEX "idx_form_submissions_email" ON "public"."form_submissions" USING "btree" ("lower"(TRIM(BOTH FROM "email")), "created_at" DESC);



CREATE INDEX "idx_form_submissions_recent" ON "public"."form_submissions" USING "btree" ("form_type", "created_at" DESC);



CREATE INDEX "idx_gcm_campaign" ON "public"."google_click_mapping" USING "btree" ("campaign_id");



CREATE INDEX "idx_gcm_date" ON "public"."google_click_mapping" USING "btree" ("click_date");



CREATE INDEX "idx_google_ad_drafts_created" ON "public"."google_ad_drafts" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_google_ag_daily_campaign" ON "public"."google_ad_group_daily" USING "btree" ("campaign_id", "date");



CREATE INDEX "idx_google_ag_settings_campaign" ON "public"."google_ad_group_settings" USING "btree" ("campaign_id");



CREATE INDEX "idx_google_biz_reviews_time" ON "public"."google_business_reviews" USING "btree" ("created_time" DESC);



CREATE INDEX "idx_google_kw_daily_campaign" ON "public"."google_keywords_daily" USING "btree" ("campaign_id", "date");



CREATE INDEX "idx_google_st_campaign_date" ON "public"."google_search_terms" USING "btree" ("campaign_id", "date");



CREATE INDEX "idx_google_st_waste" ON "public"."google_search_terms" USING "btree" ("campaign_id", "conversions", "cost_micros");



CREATE INDEX "idx_ig_comments_post" ON "public"."instagram_comments" USING "btree" ("post_id");



CREATE INDEX "idx_ig_comments_time" ON "public"."instagram_comments" USING "btree" ("created_time" DESC);



CREATE INDEX "idx_ig_dm_threads_last_msg" ON "public"."instagram_dm_threads" USING "btree" ("last_message_time" DESC);



CREATE INDEX "idx_ig_dms_conversation" ON "public"."instagram_dms" USING "btree" ("conversation_id");



CREATE INDEX "idx_ig_dms_time" ON "public"."instagram_dms" USING "btree" ("created_time" DESC);



CREATE INDEX "idx_ig_dms_unpurged" ON "public"."instagram_dms" USING "btree" ("purged") WHERE ("purged" = false);



CREATE INDEX "idx_meta_ad_adsets_campaign" ON "public"."meta_ad_adsets" USING "btree" ("campaign_id");



CREATE INDEX "idx_meta_ad_adsets_status" ON "public"."meta_ad_adsets" USING "btree" ("effective_status");



CREATE INDEX "idx_meta_ad_daily_adset" ON "public"."meta_ad_daily" USING "btree" ("adset_id", "date");



CREATE INDEX "idx_meta_ad_daily_campaign" ON "public"."meta_adset_daily" USING "btree" ("campaign_id", "date");



CREATE INDEX "idx_meta_ad_drafts_created" ON "public"."meta_ad_drafts" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_meta_ads_adset" ON "public"."meta_ads" USING "btree" ("adset_id");



CREATE INDEX "idx_meta_ads_campaign" ON "public"."meta_ads" USING "btree" ("campaign_id");



CREATE INDEX "idx_meta_ads_status" ON "public"."meta_ads" USING "btree" ("effective_status");



CREATE INDEX "idx_operators_user_id" ON "public"."operators" USING "btree" ("user_id");



CREATE INDEX "idx_origins_user_id" ON "public"."origins" USING "btree" ("user_id");



CREATE INDEX "idx_products_user_id" ON "public"."products" USING "btree" ("user_id");



CREATE INDEX "idx_reviews_product" ON "public"."product_reviews" USING "btree" ("product_slug");



CREATE INDEX "idx_reviews_rating" ON "public"."product_reviews" USING "btree" ("rating");



CREATE INDEX "idx_roasts_origin_id" ON "public"."roasts" USING "btree" ("origin_id");



CREATE INDEX "idx_roasts_user_id" ON "public"."roasts" USING "btree" ("user_id");



CREATE INDEX "idx_sync_log_platform_started" ON "public"."sync_log" USING "btree" ("platform", "started_at" DESC);



CREATE INDEX "idx_voc_freq" ON "public"."voc_insights" USING "btree" ("frequency" DESC);



CREATE INDEX "idx_voc_product" ON "public"."voc_insights" USING "btree" ("product_context");



CREATE INDEX "idx_voc_stage" ON "public"."voc_insights" USING "btree" ("customer_stage");



CREATE INDEX "idx_voc_type" ON "public"."voc_insights" USING "btree" ("insight_type");



CREATE INDEX "idx_woo_items_category" ON "public"."woo_order_items_enriched" USING "btree" ("product_category");



CREATE INDEX "idx_woo_items_date" ON "public"."woo_order_items_enriched" USING "btree" ("order_date");



CREATE INDEX "idx_woo_items_gclid" ON "public"."woo_order_items_enriched" USING "btree" ("gclid") WHERE ("gclid" IS NOT NULL);



CREATE INDEX "idx_woo_items_utm" ON "public"."woo_order_items_enriched" USING "btree" ("utm_source", "utm_campaign");



CREATE INDEX "idx_woo_orders_gclid" ON "public"."woo_orders" USING "btree" ("gclid") WHERE ("gclid" IS NOT NULL);



CREATE INDEX "idx_woo_products_missing_description" ON "public"."woo_products" USING "btree" ("woo_id") WHERE (("description" IS NULL) AND ("stock_status" = 'instock'::"text"));



CREATE INDEX "industry_articles_pending_idx" ON "public"."industry_articles" USING "btree" ("fetched_at") WHERE ("summarized_at" IS NULL);



CREATE INDEX "industry_articles_relevance_idx" ON "public"."industry_articles" USING "btree" ("relevance" DESC, "summarized_at" DESC) WHERE (("summarized_at" IS NOT NULL) AND ("relevance" IS NOT NULL));



CREATE INDEX "industry_articles_summarized_idx" ON "public"."industry_articles" USING "btree" ("summarized_at" DESC) WHERE ("summarized_at" IS NOT NULL);



CREATE INDEX "inventory_adjustments_sku_idx" ON "public"."inventory_adjustments" USING "btree" ("sku");



CREATE INDEX "inventory_adjustments_supplier_idx" ON "public"."inventory_adjustments" USING "btree" ("supplier");



CREATE INDEX "inventory_adjustments_unit_cost_idx" ON "public"."inventory_adjustments" USING "btree" ("sku", "created_at" DESC) WHERE ("unit_cost" IS NOT NULL);



CREATE INDEX "keyword_ideas_monthly_searches_idx" ON "public"."keyword_ideas" USING "btree" ("avg_monthly_searches" DESC);



CREATE INDEX "ledger_imports_period_idx" ON "public"."ledger_imports" USING "btree" ("period_from", "period_to");



CREATE INDEX "ledger_lines_import_idx" ON "public"."ledger_lines" USING "btree" ("import_id");



CREATE UNIQUE INDEX "marketing_contacts_email_unique" ON "public"."marketing_contacts" USING "btree" ("email");



CREATE INDEX "messaging_reminder_prefs_customer_idx" ON "public"."messaging_reminder_prefs" USING "btree" ("customer_id", "created_at" DESC);



CREATE INDEX "mflow_sell_events_date_idx" ON "public"."mflow_sell_events" USING "btree" ("transaction_date" DESC);



CREATE INDEX "mflow_sell_lines_channel_idx" ON "public"."mflow_sell_lines" USING "btree" ("channel", "transaction_date" DESC);



CREATE INDEX "mflow_sell_lines_date_idx" ON "public"."mflow_sell_lines" USING "btree" ("transaction_date" DESC) WHERE ("status_class" <> 'excluded'::"text");



CREATE INDEX "mflow_sell_lines_product_idx" ON "public"."mflow_sell_lines" USING "btree" ("cf_product_id", "transaction_date" DESC) WHERE ("cf_product_id" IS NOT NULL);



CREATE INDEX "mflow_sell_lines_woo_idx" ON "public"."mflow_sell_lines" USING "btree" ("woocommerce_order_id") WHERE ("woocommerce_order_id" IS NOT NULL);



CREATE INDEX "minuto_blog_posts_published_idx" ON "public"."minuto_blog_posts" USING "btree" ("published_at" DESC NULLS LAST);



CREATE INDEX "opening_shift_confirmations_pending_idx" ON "public"."opening_shift_confirmations" USING "btree" ("shift_date") WHERE ("status" = 'pending'::"text");



CREATE UNIQUE INDEX "opening_shift_confirmations_unique_idx" ON "public"."opening_shift_confirmations" USING "btree" ("schedule_id", "shift_date");



CREATE INDEX "packing_logs_packed_at_idx" ON "public"."packing_logs" USING "btree" ("packed_at");



CREATE INDEX "pending_orders_customer_id_idx" ON "public"."pending_orders" USING "btree" ("customer_id");



CREATE INDEX "product_sku_map_product_idx" ON "public"."product_sku_map" USING "btree" ("product_id");



CREATE UNIQUE INDEX "roasts_artisan_uuid_key" ON "public"."roasts" USING "btree" ("artisan_uuid") WHERE ("artisan_uuid" IS NOT NULL);



CREATE INDEX "seo_experiments_collecting_idx" ON "public"."seo_experiments" USING "btree" ("created_at") WHERE ("status" = 'collecting'::"text");



CREATE INDEX "seo_experiments_status_idx" ON "public"."seo_experiments" USING "btree" ("status");



CREATE INDEX "seo_learnings_active_recent_idx" ON "public"."seo_learnings" USING "btree" ("created_at" DESC) WHERE ("superseded_at" IS NULL);



CREATE INDEX "seo_learnings_evidence_score_idx" ON "public"."seo_learnings" USING "btree" ("evidence_score") WHERE ("superseded_at" IS NULL);



CREATE INDEX "seo_learnings_scope_active_idx" ON "public"."seo_learnings" USING "btree" ("scope", "created_at" DESC) WHERE ("superseded_at" IS NULL);



CREATE INDEX "seo_metrics_logged_at_idx" ON "public"."seo_metrics" USING "btree" ("logged_at" DESC);



CREATE INDEX "seo_metrics_source_idx" ON "public"."seo_metrics" USING "btree" ("source", "logged_at" DESC);



CREATE INDEX "seo_tasks_experiment_idx" ON "public"."seo_tasks" USING "btree" ("experiment_id") WHERE ("experiment_id" IS NOT NULL);



CREATE INDEX "seo_tasks_lock_expiry_idx" ON "public"."seo_tasks" USING "btree" ("locked_until") WHERE ("status" = 'processing'::"text");



CREATE INDEX "seo_tasks_parent_idx" ON "public"."seo_tasks" USING "btree" ("parent_task_id") WHERE ("parent_task_id" IS NOT NULL);



CREATE INDEX "seo_tasks_pickup_idx" ON "public"."seo_tasks" USING "btree" ("task_type", "scheduled_for") WHERE ("status" = 'pending'::"text");



CREATE INDEX "seo_tasks_run_idx" ON "public"."seo_tasks" USING "btree" ("orchestrator_run_id") WHERE ("orchestrator_run_id" IS NOT NULL);



CREATE INDEX "shop_consumption_logs_taken_at_idx" ON "public"."shop_consumption_logs" USING "btree" ("taken_at" DESC);



CREATE INDEX "statement_imports_month_idx" ON "public"."statement_imports" USING "btree" ("period_month");



CREATE INDEX "statement_lines_import_idx" ON "public"."statement_lines" USING "btree" ("import_id");



CREATE INDEX "strategic_briefs_week_idx" ON "public"."strategic_briefs" USING "btree" ("week_start" DESC);



CREATE INDEX "strategic_recommendations_brief_idx" ON "public"."strategic_recommendations" USING "btree" ("brief_id", "created_at" DESC);



CREATE INDEX "strategic_recommendations_claim_idx" ON "public"."strategic_recommendations" USING "btree" ("created_at") WHERE ("status" = 'approved'::"text");



CREATE INDEX "strategic_recommendations_loop_idx" ON "public"."strategic_recommendations" USING "btree" ("status", "created_at") WHERE ("status" = ANY (ARRAY['awaiting_critique'::"text", 'revising'::"text", 'exporting'::"text"]));



CREATE INDEX "strategic_theses_active_idx" ON "public"."strategic_theses" USING "btree" ("created_at" DESC) WHERE ("status" = 'active'::"text");



CREATE INDEX "strategist_runs_claim_idx" ON "public"."strategist_runs" USING "btree" ("updated_at") WHERE ("status" = 'thinking'::"text");



CREATE UNIQUE INDEX "strategist_runs_single_active_idx" ON "public"."strategist_runs" USING "btree" ("status") WHERE ("status" = 'thinking'::"text");



CREATE UNIQUE INDEX "strategist_signals_pitch_dedupe_uidx" ON "public"."strategist_signals" USING "btree" ("dedupe_key") WHERE ("kind" = 'innovation_pitch'::"text");



CREATE INDEX "strategist_signals_status_idx" ON "public"."strategist_signals" USING "btree" ("status", "kind");



CREATE UNIQUE INDEX "supplier_invoices_confirmed_number_key" ON "public"."supplier_invoices" USING "btree" ("supplier_tax_id", "regexp_replace"("invoice_number", '\D'::"text", ''::"text", 'g'::"text"), "doc_type") WHERE (("status" = 'confirmed'::"text") AND ("supplier_tax_id" IS NOT NULL) AND ("regexp_replace"(COALESCE("invoice_number", ''::"text"), '\D'::"text", ''::"text", 'g'::"text") <> ''::"text"));



CREATE INDEX "supplier_invoices_date_idx" ON "public"."supplier_invoices" USING "btree" ("invoice_date");



CREATE INDEX "supplier_invoices_delivery_idx" ON "public"."supplier_invoices" USING "btree" ("delivery_id");



CREATE UNIQUE INDEX "supplier_invoices_file_sha256_key" ON "public"."supplier_invoices" USING "btree" ("file_sha256");



CREATE INDEX "supplier_invoices_supplier_number_idx" ON "public"."supplier_invoices" USING "btree" ("supplier_tax_id", "invoice_number");



CREATE INDEX "supplier_invoices_undelivered_idx" ON "public"."supplier_invoices" USING "btree" ("invoice_date") WHERE (("status" = 'confirmed'::"text") AND ("delivery_id" IS NULL));



CREATE INDEX "supplier_invoices_uploaded_by_idx" ON "public"."supplier_invoices" USING "btree" ("uploaded_by");



CREATE INDEX "system_logs_errors_idx" ON "public"."system_logs" USING "btree" ("ts" DESC) WHERE ("level" = ANY (ARRAY['warn'::"text", 'error'::"text"]));



CREATE INDEX "system_logs_fn_ts_idx" ON "public"."system_logs" USING "btree" ("fn", "ts" DESC);



CREATE INDEX "system_logs_run_idx" ON "public"."system_logs" USING "btree" ("run_id", "seq");



CREATE INDEX "system_logs_runs_idx" ON "public"."system_logs" USING "btree" ("fn", "ts" DESC) WHERE ("run_status" IS NOT NULL);



CREATE INDEX "system_logs_ts_idx" ON "public"."system_logs" USING "btree" ("ts" DESC);



CREATE UNIQUE INDEX "uniq_automation_per_customer_per_order" ON "public"."email_automations" USING "btree" ("trigger_type", "customer_email", "woo_order_id");



CREATE UNIQUE INDEX "vehicle_trips_one_open" ON "public"."vehicle_trips" USING "btree" ((true)) WHERE ("ended_at" IS NULL);



CREATE INDEX "vehicle_trips_started_idx" ON "public"."vehicle_trips" USING "btree" ("started_at");



CREATE INDEX "whatsapp_messages_wa_id_created_idx" ON "public"."whatsapp_messages" USING "btree" ("wa_id", "created_at" DESC);



CREATE INDEX "woo_orders_date_idx" ON "public"."woo_orders" USING "btree" ("order_date" DESC);



CREATE OR REPLACE TRIGGER "oauth_tokens_updated_at" BEFORE UPDATE ON "public"."oauth_tokens" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at"();



CREATE OR REPLACE TRIGGER "seo_tasks_reel_render_dispatch" AFTER INSERT ON "public"."seo_tasks" FOR EACH ROW WHEN ((("new"."task_type" = 'reel_render'::"text") AND ("new"."status" = 'pending'::"text"))) EXECUTE FUNCTION "public"."reel_render_on_insert"();



CREATE OR REPLACE TRIGGER "seo_tasks_updated_at" BEFORE UPDATE ON "public"."seo_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."seo_tasks_set_updated_at"();



CREATE OR REPLACE TRIGGER "supplier_invoices_touch" BEFORE UPDATE ON "public"."supplier_invoices" FOR EACH ROW EXECUTE FUNCTION "public"."supplier_invoices_touch"();



ALTER TABLE ONLY "public"."ai_visibility_probes"
    ADD CONSTRAINT "ai_visibility_probes_query_id_fkey" FOREIGN KEY ("query_id") REFERENCES "public"."ai_visibility_queries"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."artisan_profiles"
    ADD CONSTRAINT "artisan_profiles_roast_id_fkey" FOREIGN KEY ("roast_id") REFERENCES "public"."roasts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."attendance_events"
    ADD CONSTRAINT "attendance_events_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."attendance_reminders_sent"
    ADD CONSTRAINT "attendance_reminders_sent_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."availability_submissions"
    ADD CONSTRAINT "availability_submissions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bag_allocations"
    ADD CONSTRAINT "bag_allocations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."b2b_customers"("id");



ALTER TABLE ONLY "public"."bag_allocations"
    ADD CONSTRAINT "bag_allocations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id");



ALTER TABLE ONLY "public"."campaign_events"
    ADD CONSTRAINT "campaign_events_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."contact_group_members"
    ADD CONSTRAINT "contact_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."contact_groups"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_orders"
    ADD CONSTRAINT "customer_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");



ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_merged_into_fkey" FOREIGN KEY ("merged_into") REFERENCES "public"."customers"("id");



ALTER TABLE ONLY "public"."email_automations"
    ADD CONSTRAINT "email_automations_trigger_type_fkey" FOREIGN KEY ("trigger_type") REFERENCES "public"."email_automation_templates"("trigger_type");



ALTER TABLE ONLY "public"."industry_articles"
    ADD CONSTRAINT "industry_articles_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."industry_sources"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ledger_lines"
    ADD CONSTRAINT "ledger_lines_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "public"."ledger_imports"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."messaging_reminder_prefs"
    ADD CONSTRAINT "messaging_reminder_prefs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id");



ALTER TABLE ONLY "public"."pending_orders"
    ADD CONSTRAINT "pending_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."b2b_customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."roast_components"
    ADD CONSTRAINT "roast_components_origin_id_fkey" FOREIGN KEY ("origin_id") REFERENCES "public"."origins"("id");



ALTER TABLE ONLY "public"."roast_components"
    ADD CONSTRAINT "roast_components_roast_id_fkey" FOREIGN KEY ("roast_id") REFERENCES "public"."roasts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."roast_profile_ingredients"
    ADD CONSTRAINT "roast_profile_ingredients_origin_id_fkey" FOREIGN KEY ("origin_id") REFERENCES "public"."origins"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."roast_profile_ingredients"
    ADD CONSTRAINT "roast_profile_ingredients_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."roast_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."roasts"
    ADD CONSTRAINT "roasts_origin_id_fkey" FOREIGN KEY ("origin_id") REFERENCES "public"."origins"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."roasts"
    ADD CONSTRAINT "roasts_roast_profile_id_fkey" FOREIGN KEY ("roast_profile_id") REFERENCES "public"."roast_profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."schedule_assignments"
    ADD CONSTRAINT "schedule_assignments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id");



ALTER TABLE ONLY "public"."schedule_assignments"
    ADD CONSTRAINT "schedule_assignments_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."seo_experiments"
    ADD CONSTRAINT "seo_experiments_parent_experiment_id_fkey" FOREIGN KEY ("parent_experiment_id") REFERENCES "public"."seo_experiments"("id");



ALTER TABLE ONLY "public"."seo_experiments"
    ADD CONSTRAINT "seo_experiments_recorded_learning_id_fkey" FOREIGN KEY ("recorded_learning_id") REFERENCES "public"."seo_learnings"("id");



ALTER TABLE ONLY "public"."seo_experiments"
    ADD CONSTRAINT "seo_experiments_winner_task_id_fkey" FOREIGN KEY ("winner_task_id") REFERENCES "public"."seo_tasks"("id");



ALTER TABLE ONLY "public"."seo_learnings"
    ADD CONSTRAINT "seo_learnings_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "public"."seo_learnings"("id");



ALTER TABLE ONLY "public"."seo_tasks"
    ADD CONSTRAINT "seo_tasks_experiment_id_fkey" FOREIGN KEY ("experiment_id") REFERENCES "public"."seo_experiments"("id");



ALTER TABLE ONLY "public"."seo_tasks"
    ADD CONSTRAINT "seo_tasks_parent_task_id_fkey" FOREIGN KEY ("parent_task_id") REFERENCES "public"."seo_tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."statement_lines"
    ADD CONSTRAINT "statement_lines_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "public"."statement_imports"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."strategic_briefs"
    ADD CONSTRAINT "strategic_briefs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."strategist_runs"("id");



ALTER TABLE ONLY "public"."strategic_recommendations"
    ADD CONSTRAINT "strategic_recommendations_brief_id_fkey" FOREIGN KEY ("brief_id") REFERENCES "public"."strategic_briefs"("id");



ALTER TABLE ONLY "public"."strategic_theses"
    ADD CONSTRAINT "strategic_theses_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "public"."strategic_theses"("id");



ALTER TABLE ONLY "public"."supplier_invoices"
    ADD CONSTRAINT "supplier_invoices_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "public"."invoice_deliveries"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."supplier_invoices"
    ADD CONSTRAINT "supplier_invoices_possible_duplicate_of_fkey" FOREIGN KEY ("possible_duplicate_of") REFERENCES "public"."supplier_invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vehicle_trips"
    ADD CONSTRAINT "vehicle_trips_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."waiting_customers"
    ADD CONSTRAINT "waiting_customers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE "public"."advisor_completed_actions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "advisor_completed_actions_admin_read" ON "public"."advisor_completed_actions" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."advisor_reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "advisor_reports_admin_read" ON "public"."advisor_reports" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."advisor_scores" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "advisor_scores_admin_read" ON "public"."advisor_scores" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."agent_cost_ledger" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agent_cost_ledger_admin_read" ON "public"."agent_cost_ledger" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."agent_missions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agent_missions_admin_only" ON "public"."agent_missions" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."ai_visibility_probes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_visibility_queries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."app_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "app_settings_staff" ON "public"."app_settings" TO "authenticated" USING ("public"."is_staff"()) WITH CHECK ("public"."is_staff"());



ALTER TABLE "public"."artisan_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "artisan_profiles_shared_delete" ON "public"."artisan_profiles" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "artisan_profiles_shared_insert" ON "public"."artisan_profiles" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "artisan_profiles_shared_select" ON "public"."artisan_profiles" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "artisan_profiles_shared_update" ON "public"."artisan_profiles" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



ALTER TABLE "public"."attendance_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."attendance_holidays" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."attendance_reminders_sent" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "attendance_reminders_sent_admin_read" ON "public"."attendance_reminders_sent" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."attendance_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "auth_delete" ON "public"."roast_checklist_templates" FOR DELETE TO "authenticated" USING ((("auth"."jwt"() ->> 'sub'::"text") = "user_id"));



CREATE POLICY "auth_insert" ON "public"."roast_checklist_templates" FOR INSERT TO "authenticated" WITH CHECK ((("auth"."jwt"() ->> 'sub'::"text") = "user_id"));



CREATE POLICY "auth_select" ON "public"."roast_checklist_templates" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "auth_select_own" ON "public"."user_roles" FOR SELECT TO "authenticated" USING ((("auth"."jwt"() ->> 'sub'::"text") = "user_id"));



CREATE POLICY "auth_update" ON "public"."roast_checklist_templates" FOR UPDATE TO "authenticated" USING ((("auth"."jwt"() ->> 'sub'::"text") = "user_id")) WITH CHECK ((("auth"."jwt"() ->> 'sub'::"text") = "user_id"));



ALTER TABLE "public"."availability_submissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."b2b_customers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "b2b_customers_staff" ON "public"."b2b_customers" TO "authenticated" USING ("public"."is_staff"()) WITH CHECK ("public"."is_staff"());



ALTER TABLE "public"."bag_allocations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bag_allocations_staff" ON "public"."bag_allocations" TO "authenticated" USING ("public"."is_staff"()) WITH CHECK ("public"."is_staff"());



ALTER TABLE "public"."bot_rate_limit" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."campaign_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "campaign_events_admin_read" ON "public"."campaign_events" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."campaigns" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "campaigns_admin_only" ON "public"."campaigns" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."chat_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chat_messages_admin_only" ON "public"."chat_messages" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."coffee_bot_pending_packing" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."coffee_sales_daily" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "coffee_sales_daily_admin_read" ON "public"."coffee_sales_daily" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."competitor_pages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "competitor_pages_admin_read" ON "public"."competitor_pages" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."contact_group_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_group_members_admin_only" ON "public"."contact_group_members" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."contact_groups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contact_groups_admin_only" ON "public"."contact_groups" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."cost_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cost_settings_own_row" ON "public"."cost_settings" TO "authenticated" USING ((("user_id" = ("auth"."jwt"() ->> 'sub'::"text")) AND "public"."is_staff"())) WITH CHECK ((("user_id" = ("auth"."jwt"() ->> 'sub'::"text")) AND "public"."is_staff"()));



ALTER TABLE "public"."customer_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."customer_rfm" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_rfm_admin_only" ON "public"."customer_rfm" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."email_automation_templates" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "email_automation_templates_admin_only" ON "public"."email_automation_templates" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."email_automations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "email_automations_admin_only" ON "public"."email_automations" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."employees" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "employees_delete_admin_only" ON "public"."employees" FOR DELETE TO "authenticated" USING (("public"."is_admin"() AND "public"."is_staff"()));



CREATE POLICY "employees_insert_admin_only" ON "public"."employees" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_admin"() AND "public"."is_staff"()));



CREATE POLICY "employees_select_all" ON "public"."employees" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "employees_update_admin_or_scheduler" ON "public"."employees" FOR UPDATE TO "authenticated" USING (("public"."can_manage_schedule"() AND "public"."is_staff"())) WITH CHECK (("public"."can_manage_schedule"() AND "public"."is_staff"()));



ALTER TABLE "public"."facebook_comments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."form_submissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "form_submissions_admin_only" ON "public"."form_submissions" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."ga4_pages_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."gemini_prompt_cache" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "gemini_prompt_cache_admin_read" ON "public"."gemini_prompt_cache" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."google_account_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."google_ad_drafts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."google_ad_group_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."google_ad_group_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."google_ads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "google_ads_admin_read" ON "public"."google_ads" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."google_audiences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."google_business_reviews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."google_campaign_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."google_campaigns" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "google_campaigns_admin_read" ON "public"."google_campaigns" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."google_click_mapping" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."google_conversion_actions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."google_keywords_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."google_search_console" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "google_search_console_admin_read" ON "public"."google_search_console" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."google_search_terms" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."industry_articles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."industry_sources" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."instagram_comments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."instagram_dm_threads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."instagram_dms" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inventory_adjustments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "inventory_adjustments_admin_read" ON "public"."inventory_adjustments" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."invoice_deliveries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "invoice_deliveries_read" ON "public"."invoice_deliveries" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR "public"."is_bookkeeper"()));



ALTER TABLE "public"."job_leases" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."keyword_ideas" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "keyword_ideas_admin_read" ON "public"."keyword_ideas" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."ledger_imports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ledger_imports_books" ON "public"."ledger_imports" TO "authenticated" USING (("public"."is_admin"() OR "public"."is_bookkeeper"())) WITH CHECK (("public"."is_admin"() OR "public"."is_bookkeeper"()));



ALTER TABLE "public"."ledger_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ledger_lines_books" ON "public"."ledger_lines" TO "authenticated" USING (("public"."is_admin"() OR "public"."is_bookkeeper"())) WITH CHECK (("public"."is_admin"() OR "public"."is_bookkeeper"()));



ALTER TABLE "public"."market_research" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "market_research_admin_read" ON "public"."market_research" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."marketing_contacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "marketing_contacts_admin_only" ON "public"."marketing_contacts" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."messaging_identity_blocklist" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."messaging_reminder_prefs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meta_account_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meta_ad_adsets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meta_ad_campaigns" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "meta_ad_campaigns_admin_read" ON "public"."meta_ad_campaigns" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."meta_ad_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meta_ad_drafts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meta_ads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meta_adset_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meta_daily_insights" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "meta_daily_insights_admin_read" ON "public"."meta_daily_insights" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."meta_organic_posts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "meta_organic_posts_admin_read" ON "public"."meta_organic_posts" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."meta_placement_daily" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."mflow_sell_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mflow_sell_events_admin_read" ON "public"."mflow_sell_events" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."mflow_sell_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mflow_sell_lines_admin_read" ON "public"."mflow_sell_lines" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."minuto_blog_posts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "minuto_blog_posts_admin_read" ON "public"."minuto_blog_posts" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."oauth_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "oauth_tokens_admin_only" ON "public"."oauth_tokens" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."opening_shift_confirmations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "opening_shift_confirmations_shared_delete" ON "public"."opening_shift_confirmations" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "opening_shift_confirmations_shared_insert" ON "public"."opening_shift_confirmations" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "opening_shift_confirmations_shared_select" ON "public"."opening_shift_confirmations" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "opening_shift_confirmations_shared_update" ON "public"."opening_shift_confirmations" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



ALTER TABLE "public"."operators" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ops_profile" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."origins" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."packing_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pending_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_reviews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_sku_map" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "product_sku_map_delete" ON "public"."product_sku_map" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "product_sku_map_insert" ON "public"."product_sku_map" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "product_sku_map_select" ON "public"."product_sku_map" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "product_sku_map_update" ON "public"."product_sku_map" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."roast_checklist_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."roast_components" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."roast_profile_ingredients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."roast_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."roasts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."schedule_assignments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."schedules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."seo_experiments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."seo_learnings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."seo_metrics" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "seo_metrics_admin_only" ON "public"."seo_metrics" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."seo_tasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "seo_tasks_admin_only" ON "public"."seo_tasks" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "shared_delete" ON "public"."attendance_events" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."attendance_holidays" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."attendance_settings" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."availability_submissions" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."operators" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."origins" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."packing_logs" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."pending_orders" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."products" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."roast_components" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."roast_profile_ingredients" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."roast_profiles" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."roasts" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."schedule_assignments" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."schedules" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_delete" ON "public"."waiting_customers" FOR DELETE TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."attendance_events" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."attendance_holidays" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."attendance_settings" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."availability_submissions" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."operators" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."origins" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."packing_logs" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."pending_orders" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."products" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."roast_components" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."roast_profile_ingredients" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."roast_profiles" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."roasts" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."schedule_assignments" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."schedules" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_insert" ON "public"."waiting_customers" FOR INSERT TO "authenticated" WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."attendance_events" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."attendance_holidays" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."attendance_settings" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."availability_submissions" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."operators" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."origins" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."packing_logs" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."pending_orders" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."products" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."roast_components" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."roast_profile_ingredients" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."roast_profiles" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."roasts" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."schedule_assignments" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."schedules" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_select" ON "public"."waiting_customers" FOR SELECT TO "authenticated" USING ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."attendance_events" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."attendance_holidays" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."attendance_settings" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."availability_submissions" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."operators" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."origins" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."packing_logs" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."pending_orders" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."products" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."roast_components" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."roast_profile_ingredients" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."roast_profiles" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."roasts" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."schedule_assignments" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."schedules" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



CREATE POLICY "shared_update" ON "public"."waiting_customers" FOR UPDATE TO "authenticated" USING ((true AND "public"."is_staff"())) WITH CHECK ((true AND "public"."is_staff"()));



ALTER TABLE "public"."shop_consumption_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "shop_consumption_logs_admin_read" ON "public"."shop_consumption_logs" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."statement_imports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "statement_imports_books" ON "public"."statement_imports" TO "authenticated" USING (("public"."is_admin"() OR "public"."is_bookkeeper"())) WITH CHECK (("public"."is_admin"() OR "public"."is_bookkeeper"()));



ALTER TABLE "public"."statement_lines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "statement_lines_books" ON "public"."statement_lines" TO "authenticated" USING (("public"."is_admin"() OR "public"."is_bookkeeper"())) WITH CHECK (("public"."is_admin"() OR "public"."is_bookkeeper"()));



ALTER TABLE "public"."strategic_briefs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "strategic_briefs_admin_read" ON "public"."strategic_briefs" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."strategic_recommendations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "strategic_recommendations_admin_read" ON "public"."strategic_recommendations" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



CREATE POLICY "strategic_recommendations_admin_update" ON "public"."strategic_recommendations" FOR UPDATE TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."strategic_theses" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "strategic_theses_admin_read" ON "public"."strategic_theses" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."strategist_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "strategist_runs_admin_read" ON "public"."strategist_runs" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."strategist_signals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "strategist_signals_admin_read" ON "public"."strategist_signals" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



CREATE POLICY "strategist_signals_admin_update" ON "public"."strategist_signals" FOR UPDATE TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."supplier_invoices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "supplier_invoices_select" ON "public"."supplier_invoices" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR "public"."is_bookkeeper"() OR ("public"."is_staff"() AND ("uploaded_by" = ("auth"."jwt"() ->> 'sub'::"text")))));



CREATE POLICY "supplier_invoices_update" ON "public"."supplier_invoices" FOR UPDATE TO "authenticated" USING (("public"."is_admin"() OR ("public"."is_staff"() AND ("uploaded_by" = ("auth"."jwt"() ->> 'sub'::"text")) AND ("status" = 'pending_review'::"text")))) WITH CHECK (("public"."is_admin"() OR ("public"."is_staff"() AND ("uploaded_by" = ("auth"."jwt"() ->> 'sub'::"text")))));



ALTER TABLE "public"."sync_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sync_log_admin_read" ON "public"."sync_log" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."system_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."system_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "system_logs_admin_read" ON "public"."system_logs" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_roles_admin_all" ON "public"."user_roles" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."vehicle_trips" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vehicle_trips_select_admin_only" ON "public"."vehicle_trips" FOR SELECT TO "authenticated", "anon" USING ("public"."is_admin"());



ALTER TABLE "public"."voc_insights" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."voc_mining_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."waiting_customers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."whatsapp_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."woo_order_items_enriched" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."woo_order_items_enriched_mflow_removed" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."woo_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "woo_orders_admin_only" ON "public"."woo_orders" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



ALTER TABLE "public"."woo_orders_mflow_removed" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."woo_products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "woo_products_admin_read" ON "public"."woo_products" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."acquire_job_lease"("p_name" "text", "p_holder" "text", "p_ttl_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."acquire_job_lease"("p_name" "text", "p_holder" "text", "p_ttl_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."apply_mflow_sells"("p_sells" "jsonb", "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."apply_mflow_sells"("p_sells" "jsonb", "p_note" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."apply_packed_stock_delta"("p_product_id" integer, "p_delta" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."apply_packed_stock_delta"("p_product_id" integer, "p_delta" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."apply_roasted_stock_delta"("p_source_type" "text", "p_source_id" bigint, "p_delta_kg" numeric, "p_require_sufficient" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."apply_roasted_stock_delta"("p_source_type" "text", "p_source_id" bigint, "p_delta_kg" numeric, "p_require_sufficient" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."b2b_bags_sold"("p_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."b2b_bags_sold"("p_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."b2b_bags_sold"("p_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."can_manage_schedule"() TO "anon";
GRANT ALL ON FUNCTION "public"."can_manage_schedule"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_manage_schedule"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."check_bot_rate_limit"("p_telegram_id" "text", "p_bot_name" "text", "p_limit" integer, "p_window_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."check_bot_rate_limit"("p_telegram_id" "text", "p_bot_name" "text", "p_limit" integer, "p_window_seconds" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."check_bot_rate_limit"("p_telegram_id" "text", "p_bot_name" "text", "p_limit" integer, "p_window_seconds" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_bot_rate_limit"("p_telegram_id" "text", "p_bot_name" "text", "p_limit" integer, "p_window_seconds" integer) TO "service_role";



GRANT ALL ON TABLE "public"."invoice_deliveries" TO "authenticated";
GRANT ALL ON TABLE "public"."invoice_deliveries" TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_invoice_delivery"("p_invoice_ids" "uuid"[], "p_created_by_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_invoice_delivery"("p_invoice_ids" "uuid"[], "p_created_by_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_invoice_delivery"("p_invoice_ids" "uuid"[], "p_created_by_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."cron_job_health"("p_jobname" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."cron_job_health"("p_jobname" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cron_job_health"("p_jobname" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_my_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_my_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_role"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_role_for_user"("p_user_id" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_role_for_user"("p_user_id" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_role_for_user"("p_user_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."gsc_keyword_totals"("p_since" "date", "p_until" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."gsc_keyword_totals"("p_since" "date", "p_until" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."gsc_keyword_totals"("p_since" "date", "p_until" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."increment_campaign_stat"("p_campaign_id" bigint, "p_column" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."increment_campaign_stat"("p_campaign_id" bigint, "p_column" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_bookkeeper"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_bookkeeper"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_bookkeeper"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_staff"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_staff"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_staff"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."messaging_resolve_customers"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."messaging_resolve_customers"("p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."mx_norm"("t" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."mx_norm"("t" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."mx_norm"("t" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."mx_paid_summary"("p_days" integer, "p_end" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."mx_paid_summary"("p_days" integer, "p_end" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."mx_paid_summary"("p_days" integer, "p_end" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."mx_revenue_summary"("p_days" integer, "p_end" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."mx_revenue_summary"("p_days" integer, "p_end" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."mx_revenue_summary"("p_days" integer, "p_end" "date") TO "service_role";



REVOKE ALL ON FUNCTION "public"."ops_delete_secret"("p_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ops_delete_secret"("p_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."ops_get_secrets"("p_names" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ops_get_secrets"("p_names" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."ops_list_secret_names"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ops_list_secret_names"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."ops_set_secret"("p_name" "text", "p_secret" "text", "p_description" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ops_set_secret"("p_name" "text", "p_secret" "text", "p_description" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."purge_chat_messages"("p_keep_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_chat_messages"("p_keep_days" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."purge_packing_logs"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_packing_logs"() TO "service_role";



GRANT ALL ON FUNCTION "public"."purge_system_logs"("p_keep_days" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."purge_system_logs"("p_keep_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."purge_system_logs"("p_keep_days" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."reel_render_dispatch"("p_task_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reel_render_dispatch"("p_task_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."reel_render_on_insert"() TO "anon";
GRANT ALL ON FUNCTION "public"."reel_render_on_insert"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."reel_render_on_insert"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."reel_render_sweep"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reel_render_sweep"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_job_lease"("p_name" "text", "p_holder" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_job_lease"("p_name" "text", "p_holder" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."seo_tasks_set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."seo_tasks_set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."seo_tasks_set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."store_bags_sold"("p_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."store_bags_sold"("p_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."store_bags_sold"("p_days" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."supplier_invoices_touch"() TO "anon";
GRANT ALL ON FUNCTION "public"."supplier_invoices_touch"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."supplier_invoices_touch"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."vehicle_driver_at"("local_ts" timestamp without time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."vehicle_driver_at"("local_ts" timestamp without time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vehicle_driver_at"("local_ts" timestamp without time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."vehicle_trip_add_manual"("p_employee_id" bigint, "p_started_local" timestamp without time zone, "p_ended_local" timestamp without time zone, "p_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vehicle_trip_add_manual"("p_employee_id" bigint, "p_started_local" timestamp without time zone, "p_ended_local" timestamp without time zone, "p_note" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."vehicle_trip_add_manual"("p_employee_id" bigint, "p_started_local" timestamp without time zone, "p_ended_local" timestamp without time zone, "p_note" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vehicle_trip_add_manual"("p_employee_id" bigint, "p_started_local" timestamp without time zone, "p_ended_local" timestamp without time zone, "p_note" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."vehicle_trip_delete_manual"("p_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vehicle_trip_delete_manual"("p_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."vehicle_trip_delete_manual"("p_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."vehicle_trip_delete_manual"("p_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."vehicle_trips_between"("from_day" "date", "to_day" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."vehicle_trips_between"("from_day" "date", "to_day" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."vehicle_trips_between"("from_day" "date", "to_day" "date") TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."advisor_completed_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."advisor_completed_actions" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."advisor_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."advisor_reports" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."advisor_scores" TO "authenticated";
GRANT ALL ON TABLE "public"."advisor_scores" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."agent_cost_ledger" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_cost_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."agent_missions" TO "authenticated";
GRANT ALL ON TABLE "public"."agent_missions" TO "service_role";



GRANT ALL ON TABLE "public"."ai_visibility_probes" TO "anon";
GRANT ALL ON TABLE "public"."ai_visibility_probes" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_visibility_probes" TO "service_role";



GRANT ALL ON TABLE "public"."ai_visibility_queries" TO "anon";
GRANT ALL ON TABLE "public"."ai_visibility_queries" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_visibility_queries" TO "service_role";



GRANT ALL ON TABLE "public"."app_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."app_settings" TO "service_role";



GRANT ALL ON SEQUENCE "public"."app_settings_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."app_settings_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."app_settings_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."artisan_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."artisan_profiles" TO "service_role";



GRANT ALL ON SEQUENCE "public"."artisan_profiles_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."artisan_profiles_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."artisan_profiles_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."attendance_events" TO "authenticated";
GRANT ALL ON TABLE "public"."attendance_events" TO "service_role";



GRANT ALL ON TABLE "public"."attendance_holidays" TO "authenticated";
GRANT ALL ON TABLE "public"."attendance_holidays" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."attendance_reminders_sent" TO "authenticated";
GRANT ALL ON TABLE "public"."attendance_reminders_sent" TO "service_role";



GRANT ALL ON TABLE "public"."attendance_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."attendance_settings" TO "service_role";



GRANT ALL ON TABLE "public"."availability_submissions" TO "authenticated";
GRANT ALL ON TABLE "public"."availability_submissions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."availability_submissions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."availability_submissions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."availability_submissions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."b2b_customers" TO "authenticated";
GRANT ALL ON TABLE "public"."b2b_customers" TO "service_role";



GRANT ALL ON SEQUENCE "public"."b2b_customers_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."b2b_customers_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."b2b_customers_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."bag_allocations" TO "authenticated";
GRANT ALL ON TABLE "public"."bag_allocations" TO "service_role";



GRANT ALL ON SEQUENCE "public"."bag_allocations_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."bag_allocations_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."bag_allocations_id_seq" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."coffee_sales_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."coffee_sales_daily" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."mflow_sell_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."mflow_sell_lines" TO "service_role";



GRANT ALL ON TABLE "public"."product_sku_map" TO "authenticated";
GRANT ALL ON TABLE "public"."product_sku_map" TO "service_role";



GRANT ALL ON TABLE "public"."bean_sales_daily" TO "anon";
GRANT ALL ON TABLE "public"."bean_sales_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."bean_sales_daily" TO "service_role";



GRANT ALL ON TABLE "public"."bot_rate_limit" TO "anon";
GRANT ALL ON TABLE "public"."bot_rate_limit" TO "authenticated";
GRANT ALL ON TABLE "public"."bot_rate_limit" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."campaign_events" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."campaign_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."campaign_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."campaign_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."campaigns" TO "service_role";



GRANT ALL ON SEQUENCE "public"."campaigns_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."campaigns_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."campaigns_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."chat_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."chat_messages" TO "service_role";



GRANT ALL ON TABLE "public"."coffee_bot_pending_packing" TO "anon";
GRANT ALL ON TABLE "public"."coffee_bot_pending_packing" TO "authenticated";
GRANT ALL ON TABLE "public"."coffee_bot_pending_packing" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."competitor_pages" TO "authenticated";
GRANT ALL ON TABLE "public"."competitor_pages" TO "service_role";



GRANT ALL ON SEQUENCE "public"."competitor_pages_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."competitor_pages_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."competitor_pages_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."contact_group_members" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_group_members" TO "service_role";



GRANT ALL ON SEQUENCE "public"."contact_group_members_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."contact_group_members_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."contact_group_members_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."contact_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_groups" TO "service_role";



GRANT ALL ON SEQUENCE "public"."contact_groups_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."contact_groups_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."contact_groups_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."cost_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."cost_settings" TO "service_role";



GRANT ALL ON SEQUENCE "public"."cost_settings_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."cost_settings_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."cost_settings_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."customer_orders" TO "service_role";



GRANT ALL ON TABLE "public"."customer_rfm" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_rfm" TO "service_role";



GRANT ALL ON TABLE "public"."customers" TO "service_role";



GRANT ALL ON SEQUENCE "public"."customers_seq_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."customers_seq_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."customers_seq_seq" TO "service_role";



GRANT ALL ON TABLE "public"."email_automation_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."email_automation_templates" TO "service_role";



GRANT ALL ON TABLE "public"."email_automations" TO "authenticated";
GRANT ALL ON TABLE "public"."email_automations" TO "service_role";



GRANT ALL ON TABLE "public"."employees" TO "authenticated";
GRANT ALL ON TABLE "public"."employees" TO "service_role";



GRANT ALL ON SEQUENCE "public"."employees_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."employees_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."employees_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."facebook_comments" TO "anon";
GRANT ALL ON TABLE "public"."facebook_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."facebook_comments" TO "service_role";



GRANT ALL ON TABLE "public"."form_submissions" TO "authenticated";
GRANT ALL ON TABLE "public"."form_submissions" TO "service_role";



GRANT ALL ON TABLE "public"."ga4_pages_daily" TO "anon";
GRANT ALL ON TABLE "public"."ga4_pages_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."ga4_pages_daily" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."gemini_prompt_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."gemini_prompt_cache" TO "service_role";



GRANT ALL ON TABLE "public"."google_account_settings" TO "anon";
GRANT ALL ON TABLE "public"."google_account_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."google_account_settings" TO "service_role";



GRANT ALL ON TABLE "public"."google_ad_drafts" TO "anon";
GRANT ALL ON TABLE "public"."google_ad_drafts" TO "authenticated";
GRANT ALL ON TABLE "public"."google_ad_drafts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."google_ad_drafts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."google_ad_drafts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."google_ad_drafts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."google_ad_group_daily" TO "anon";
GRANT ALL ON TABLE "public"."google_ad_group_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."google_ad_group_daily" TO "service_role";



GRANT ALL ON TABLE "public"."google_ad_group_settings" TO "anon";
GRANT ALL ON TABLE "public"."google_ad_group_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."google_ad_group_settings" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."google_ads" TO "authenticated";
GRANT ALL ON TABLE "public"."google_ads" TO "service_role";



GRANT ALL ON TABLE "public"."google_audiences" TO "anon";
GRANT ALL ON TABLE "public"."google_audiences" TO "authenticated";
GRANT ALL ON TABLE "public"."google_audiences" TO "service_role";



GRANT ALL ON TABLE "public"."google_business_reviews" TO "anon";
GRANT ALL ON TABLE "public"."google_business_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."google_business_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."google_campaign_settings" TO "anon";
GRANT ALL ON TABLE "public"."google_campaign_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."google_campaign_settings" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."google_campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."google_campaigns" TO "service_role";



GRANT ALL ON TABLE "public"."google_click_mapping" TO "anon";
GRANT ALL ON TABLE "public"."google_click_mapping" TO "authenticated";
GRANT ALL ON TABLE "public"."google_click_mapping" TO "service_role";



GRANT ALL ON TABLE "public"."google_conversion_actions" TO "anon";
GRANT ALL ON TABLE "public"."google_conversion_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."google_conversion_actions" TO "service_role";



GRANT ALL ON TABLE "public"."google_keywords_daily" TO "anon";
GRANT ALL ON TABLE "public"."google_keywords_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."google_keywords_daily" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."google_search_console" TO "authenticated";
GRANT ALL ON TABLE "public"."google_search_console" TO "service_role";



GRANT ALL ON TABLE "public"."google_search_terms" TO "anon";
GRANT ALL ON TABLE "public"."google_search_terms" TO "authenticated";
GRANT ALL ON TABLE "public"."google_search_terms" TO "service_role";



GRANT ALL ON TABLE "public"."industry_articles" TO "anon";
GRANT ALL ON TABLE "public"."industry_articles" TO "authenticated";
GRANT ALL ON TABLE "public"."industry_articles" TO "service_role";



GRANT ALL ON TABLE "public"."industry_sources" TO "anon";
GRANT ALL ON TABLE "public"."industry_sources" TO "authenticated";
GRANT ALL ON TABLE "public"."industry_sources" TO "service_role";



GRANT ALL ON TABLE "public"."instagram_comments" TO "anon";
GRANT ALL ON TABLE "public"."instagram_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."instagram_comments" TO "service_role";



GRANT ALL ON TABLE "public"."instagram_dm_threads" TO "anon";
GRANT ALL ON TABLE "public"."instagram_dm_threads" TO "authenticated";
GRANT ALL ON TABLE "public"."instagram_dm_threads" TO "service_role";



GRANT ALL ON TABLE "public"."instagram_dms" TO "anon";
GRANT ALL ON TABLE "public"."instagram_dms" TO "authenticated";
GRANT ALL ON TABLE "public"."instagram_dms" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."inventory_adjustments" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_adjustments" TO "service_role";



GRANT ALL ON SEQUENCE "public"."inventory_adjustments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."inventory_adjustments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."inventory_adjustments_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."job_leases" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."keyword_ideas" TO "authenticated";
GRANT ALL ON TABLE "public"."keyword_ideas" TO "service_role";



GRANT ALL ON TABLE "public"."ledger_imports" TO "authenticated";
GRANT ALL ON TABLE "public"."ledger_imports" TO "service_role";



GRANT ALL ON TABLE "public"."ledger_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."ledger_lines" TO "service_role";



GRANT ALL ON SEQUENCE "public"."ledger_lines_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."ledger_lines_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."ledger_lines_id_seq" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."market_research" TO "authenticated";
GRANT ALL ON TABLE "public"."market_research" TO "service_role";



GRANT ALL ON TABLE "public"."marketing_contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."marketing_contacts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."marketing_contacts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."marketing_contacts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."marketing_contacts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."messaging_identity_blocklist" TO "service_role";



GRANT ALL ON TABLE "public"."messaging_reminder_prefs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."messaging_reminder_prefs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."messaging_reminder_prefs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."messaging_reminder_prefs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."meta_account_settings" TO "anon";
GRANT ALL ON TABLE "public"."meta_account_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."meta_account_settings" TO "service_role";



GRANT ALL ON TABLE "public"."meta_ad_adsets" TO "anon";
GRANT ALL ON TABLE "public"."meta_ad_adsets" TO "authenticated";
GRANT ALL ON TABLE "public"."meta_ad_adsets" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."meta_ad_campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."meta_ad_campaigns" TO "service_role";



GRANT ALL ON TABLE "public"."meta_ad_daily" TO "anon";
GRANT ALL ON TABLE "public"."meta_ad_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."meta_ad_daily" TO "service_role";



GRANT ALL ON TABLE "public"."meta_ad_drafts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."meta_ad_drafts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."meta_ads" TO "anon";
GRANT ALL ON TABLE "public"."meta_ads" TO "authenticated";
GRANT ALL ON TABLE "public"."meta_ads" TO "service_role";



GRANT ALL ON TABLE "public"."meta_adset_daily" TO "anon";
GRANT ALL ON TABLE "public"."meta_adset_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."meta_adset_daily" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."meta_daily_insights" TO "authenticated";
GRANT ALL ON TABLE "public"."meta_daily_insights" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."meta_organic_posts" TO "authenticated";
GRANT ALL ON TABLE "public"."meta_organic_posts" TO "service_role";



GRANT ALL ON TABLE "public"."meta_placement_daily" TO "anon";
GRANT ALL ON TABLE "public"."meta_placement_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."meta_placement_daily" TO "service_role";



GRANT ALL ON TABLE "public"."mflow_revenue" TO "anon";
GRANT ALL ON TABLE "public"."mflow_revenue" TO "authenticated";
GRANT ALL ON TABLE "public"."mflow_revenue" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."mflow_sell_events" TO "authenticated";
GRANT ALL ON TABLE "public"."mflow_sell_events" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."minuto_blog_posts" TO "authenticated";
GRANT ALL ON TABLE "public"."minuto_blog_posts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."minuto_blog_posts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."minuto_blog_posts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."minuto_blog_posts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."mx_campaigns" TO "anon";
GRANT ALL ON TABLE "public"."mx_campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."mx_campaigns" TO "service_role";



GRANT ALL ON TABLE "public"."mx_paid_daily" TO "anon";
GRANT ALL ON TABLE "public"."mx_paid_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."mx_paid_daily" TO "service_role";



GRANT ALL ON TABLE "public"."mx_revenue_daily" TO "anon";
GRANT ALL ON TABLE "public"."mx_revenue_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."mx_revenue_daily" TO "service_role";



GRANT ALL ON TABLE "public"."woo_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."woo_orders" TO "service_role";



GRANT ALL ON TABLE "public"."mx_web_orders" TO "anon";
GRANT ALL ON TABLE "public"."mx_web_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."mx_web_orders" TO "service_role";



GRANT ALL ON TABLE "public"."oauth_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."oauth_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."opening_shift_confirmations" TO "authenticated";
GRANT ALL ON TABLE "public"."opening_shift_confirmations" TO "service_role";



GRANT ALL ON TABLE "public"."operators" TO "authenticated";
GRANT ALL ON TABLE "public"."operators" TO "service_role";



GRANT ALL ON SEQUENCE "public"."operators_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."operators_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."operators_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."ops_profile" TO "service_role";



GRANT ALL ON TABLE "public"."origins" TO "authenticated";
GRANT ALL ON TABLE "public"."origins" TO "service_role";



GRANT ALL ON SEQUENCE "public"."origins_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."origins_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."origins_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."packing_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."packing_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."packing_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."packing_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."packing_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."pending_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."pending_orders" TO "service_role";



GRANT ALL ON SEQUENCE "public"."pending_orders_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."pending_orders_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."pending_orders_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."product_reviews" TO "anon";
GRANT ALL ON TABLE "public"."product_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."product_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON SEQUENCE "public"."products_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."products_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."products_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."roast_checklist_templates" TO "anon";
GRANT ALL ON TABLE "public"."roast_checklist_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."roast_checklist_templates" TO "service_role";



GRANT ALL ON SEQUENCE "public"."roast_checklist_templates_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."roast_checklist_templates_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."roast_checklist_templates_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."roast_components" TO "authenticated";
GRANT ALL ON TABLE "public"."roast_components" TO "service_role";



GRANT ALL ON SEQUENCE "public"."roast_components_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."roast_components_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."roast_components_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."roast_profile_ingredients" TO "authenticated";
GRANT ALL ON TABLE "public"."roast_profile_ingredients" TO "service_role";



GRANT ALL ON SEQUENCE "public"."roast_profile_ingredients_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."roast_profile_ingredients_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."roast_profile_ingredients_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."roast_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."roast_profiles" TO "service_role";



GRANT ALL ON SEQUENCE "public"."roast_profiles_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."roast_profiles_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."roast_profiles_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."roasts" TO "authenticated";
GRANT ALL ON TABLE "public"."roasts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."roasts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."roasts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."roasts_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."schedule_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."schedule_assignments" TO "service_role";



GRANT ALL ON SEQUENCE "public"."schedule_assignments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."schedule_assignments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."schedule_assignments_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."schedules" TO "service_role";



GRANT ALL ON SEQUENCE "public"."schedules_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."schedules_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."schedules_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."seo_experiments" TO "anon";
GRANT ALL ON TABLE "public"."seo_experiments" TO "authenticated";
GRANT ALL ON TABLE "public"."seo_experiments" TO "service_role";



GRANT ALL ON TABLE "public"."seo_learnings" TO "anon";
GRANT ALL ON TABLE "public"."seo_learnings" TO "authenticated";
GRANT ALL ON TABLE "public"."seo_learnings" TO "service_role";



GRANT ALL ON TABLE "public"."seo_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."seo_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."seo_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."seo_tasks" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."shop_consumption_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."shop_consumption_logs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."shop_consumption_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."shop_consumption_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."shop_consumption_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."statement_imports" TO "authenticated";
GRANT ALL ON TABLE "public"."statement_imports" TO "service_role";



GRANT ALL ON TABLE "public"."statement_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."statement_lines" TO "service_role";



GRANT ALL ON SEQUENCE "public"."statement_lines_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."statement_lines_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."statement_lines_id_seq" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."strategic_briefs" TO "authenticated";
GRANT ALL ON TABLE "public"."strategic_briefs" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."strategic_recommendations" TO "authenticated";
GRANT ALL ON TABLE "public"."strategic_recommendations" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."strategic_theses" TO "authenticated";
GRANT ALL ON TABLE "public"."strategic_theses" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."strategist_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."strategist_runs" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."strategist_signals" TO "authenticated";
GRANT ALL ON TABLE "public"."strategist_signals" TO "service_role";



GRANT ALL ON TABLE "public"."supplier_invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."supplier_invoices" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."sync_log" TO "authenticated";
GRANT ALL ON TABLE "public"."sync_log" TO "service_role";



GRANT ALL ON TABLE "public"."system_config" TO "anon";
GRANT ALL ON TABLE "public"."system_config" TO "authenticated";
GRANT ALL ON TABLE "public"."system_config" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."system_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."system_logs" TO "service_role";



GRANT ALL ON TABLE "public"."system_log_runs" TO "anon";
GRANT ALL ON TABLE "public"."system_log_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."system_log_runs" TO "service_role";



GRANT ALL ON SEQUENCE "public"."system_logs_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."system_logs_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."system_logs_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_roles" TO "service_role";



GRANT ALL ON SEQUENCE "public"."user_roles_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."user_roles_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."user_roles_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."vehicle_trips" TO "anon";
GRANT ALL ON TABLE "public"."vehicle_trips" TO "authenticated";
GRANT ALL ON TABLE "public"."vehicle_trips" TO "service_role";



GRANT ALL ON SEQUENCE "public"."vehicle_trips_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."vehicle_trips_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."vehicle_trips_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."voc_insights" TO "anon";
GRANT ALL ON TABLE "public"."voc_insights" TO "authenticated";
GRANT ALL ON TABLE "public"."voc_insights" TO "service_role";



GRANT ALL ON TABLE "public"."voc_mining_runs" TO "anon";
GRANT ALL ON TABLE "public"."voc_mining_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."voc_mining_runs" TO "service_role";



GRANT ALL ON TABLE "public"."waiting_customers" TO "authenticated";
GRANT ALL ON TABLE "public"."waiting_customers" TO "service_role";



GRANT ALL ON SEQUENCE "public"."waiting_customers_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."waiting_customers_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."waiting_customers_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."whatsapp_messages" TO "service_role";



GRANT ALL ON SEQUENCE "public"."whatsapp_messages_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."whatsapp_messages_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."whatsapp_messages_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."woo_order_items_enriched" TO "anon";
GRANT ALL ON TABLE "public"."woo_order_items_enriched" TO "authenticated";
GRANT ALL ON TABLE "public"."woo_order_items_enriched" TO "service_role";



GRANT ALL ON TABLE "public"."woo_order_items_enriched_mflow_removed" TO "service_role";



GRANT ALL ON SEQUENCE "public"."woo_orders_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."woo_orders_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."woo_orders_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."woo_orders_mflow_removed" TO "service_role";



GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."woo_products" TO "authenticated";
GRANT ALL ON TABLE "public"."woo_products" TO "service_role";



GRANT ALL ON SEQUENCE "public"."woo_products_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."woo_products_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."woo_products_id_seq" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







