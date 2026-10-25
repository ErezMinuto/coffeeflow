-- Customer messaging, step 2: one customer per person, across guest checkouts
-- and duplicate accounts, with the per-order facts messaging needs.
--
--   customer_orders  one row per WEB order, every status, full history.
--                    Written by woo-orders-sync (customer pass). Holds phone
--                    and first name, so it is service-role only. woo_orders is
--                    untouched and stays "paid orders only".
--   customers        one row per person. Matched on normalized phone (E.164)
--                    OR email OR Woo account id; a match on more than one
--                    existing customer merges them (merged_into, never deleted).
--   messaging_identity_blocklist
--                    phones / emails that must never join customers together
--                    (the café's own number typed in by staff, shared inboxes).
--
-- messaging_resolve_customers() attaches unresolved orders to customers. It
-- runs at the end of every woo-orders-sync customer pass; it is safe to re-run.
--
-- Step 3 adds review_asked_at / referral_offered_at / reorder fields to
-- customers. When it does, the merge branch below must carry those over
-- (earliest timestamp wins), or a merged customer could be asked twice.
--
-- Idempotent.

-- ────────────────────────────────────────────────────────────────────────
-- 1. customers
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq               bigint GENERATED ALWAYS AS IDENTITY, -- creation order; the lowest survives a merge
  phone_e164        text,                         -- preferred mobile: the latest order's
  phones            text[] NOT NULL DEFAULT '{}', -- every normalized phone seen
  emails            text[] NOT NULL DEFAULT '{}', -- every normalized email seen
  woo_customer_ids  int[]  NOT NULL DEFAULT '{}', -- Woo account ids (guests have none)
  first_name        text,
  merged_into       uuid REFERENCES customers(id),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customers_phones_gin  ON customers USING gin (phones);
CREATE INDEX IF NOT EXISTS customers_emails_gin  ON customers USING gin (emails);
CREATE INDEX IF NOT EXISTS customers_wooids_gin  ON customers USING gin (woo_customer_ids);
CREATE INDEX IF NOT EXISTS customers_live_idx    ON customers (id) WHERE merged_into IS NULL;

-- ────────────────────────────────────────────────────────────────────────
-- 2. customer_orders
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_orders (
  woo_order_id        int PRIMARY KEY,
  customer_id         uuid REFERENCES customers(id),
  resolve_skipped     boolean NOT NULL DEFAULT false, -- no usable identity; not retried
  status              text NOT NULL,                  -- every Woo status, incl. cancelled/refunded
  created_via         text,                           -- checkout | subscription | admin …
  date_created        timestamptz NOT NULL,
  date_paid           timestamptz,
  date_completed      timestamptz,                    -- = handed to Cargo / ready at the café
  date_modified       timestamptz,                    -- incremental sync watermark
  woo_customer_id     int,                            -- NULL = guest checkout
  email_norm          text,
  phone_raw           text,
  phone_e164          text,
  phone_is_mobile     boolean NOT NULL DEFAULT false,
  first_name          text,
  delivery_method     text NOT NULL CHECK (delivery_method IN ('ship', 'pickup', 'none')),
  shipping_method_id  text,
  cargo_shipment_id   text,                           -- Cargo's status in Woo is frozen; id only
  has_beans           boolean NOT NULL DEFAULT false,
  bean_grams          int,                            -- NULL = a bean line of unknown size
  lines               jsonb NOT NULL DEFAULT '[]',    -- [{product_id, variation_id, name, quantity, category, is_bean, grams_each}]
  synced_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_orders_customer_idx   ON customer_orders (customer_id, date_created);
CREATE INDEX IF NOT EXISTS customer_orders_modified_idx   ON customer_orders (date_modified DESC);
CREATE INDEX IF NOT EXISTS customer_orders_unresolved_idx ON customer_orders (woo_order_id)
  WHERE customer_id IS NULL AND NOT resolve_skipped;

-- ────────────────────────────────────────────────────────────────────────
-- 3. Identity blocklist
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messaging_identity_blocklist (
  kind        text NOT NULL CHECK (kind IN ('phone', 'email')),
  value       text NOT NULL,   -- E.164 phone or lower-case email
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, value)
);

INSERT INTO messaging_identity_blocklist (kind, value, reason) VALUES
  ('phone', '+972544490486', 'Minuto café WhatsApp Business number — staff enter it on manual orders')
ON CONFLICT DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────
-- 4. Resolver
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.messaging_resolve_customers(p_limit int DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
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

-- ────────────────────────────────────────────────────────────────────────
-- 5. Access: service role only (phones + names; the anon key ships in the
--    dashboard bundle). RLS on with no policies, grants revoked.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE customers                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_orders              ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_identity_blocklist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON customers, customer_orders, messaging_identity_blocklist FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.messaging_resolve_customers(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.messaging_resolve_customers(int) TO service_role;
