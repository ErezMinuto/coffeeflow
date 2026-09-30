-- ============================================================================
-- Artisan → CoffeeFlow roasting log integration
-- ============================================================================
--
-- Artisan (artisan-scope.org) is the roasting software used at the roastery.
-- The roaster records a roast in CoffeeFlow as usual, then uploads Artisan's
-- roast file (.alog or .json) onto that record; the `artisan-import` edge
-- function reads it and lands the roast curve's key temperatures on the row.
--
-- The two numbers that motivated this:
--   charge_et  — טמפ' הטענה  (environmental/drum probe when the beans go in)
--   drop_bt    — טמפ' סיום   (bean probe at drop)
-- All four charge/drop readings are stored so neither probe is ever lost.
--
-- Conventions followed here (see 20260709_opening_shift_confirmations.sql and
-- 20260627_strategist_recommendations.sql):
--   * ENABLE ROW LEVEL SECURITY immediately after CREATE TABLE, before the
--     indexes, so the SQL-editor RLS linter doesn't block a multi-statement run
--   * org-wide shared RLS (anon + authenticated, USING(true)) — these are
--     shared business tables, never per-user
--   * additive only; safe to re-run
-- ============================================================================


-- ── 1. roasts: the readings, denormalised ───────────────────────────────────
-- The app reads tables flat via useSupabaseData (no joins), so these live on
-- the roast row itself rather than being joined from artisan_profiles.
-- Always stored in CELSIUS — the importer converts when Artisan is in °F.

ALTER TABLE roasts ADD COLUMN IF NOT EXISTS charge_et    NUMERIC;
ALTER TABLE roasts ADD COLUMN IF NOT EXISTS charge_bt    NUMERIC;
ALTER TABLE roasts ADD COLUMN IF NOT EXISTS drop_et      NUMERIC;
ALTER TABLE roasts ADD COLUMN IF NOT EXISTS drop_bt      NUMERIC;
ALTER TABLE roasts ADD COLUMN IF NOT EXISTS artisan_uuid TEXT;

COMMENT ON COLUMN roasts.charge_et    IS 'Artisan CHARGE_ET — טמפ'' הטענה, °C';
COMMENT ON COLUMN roasts.charge_bt    IS 'Artisan CHARGE_BT — bean temp at charge, °C';
COMMENT ON COLUMN roasts.drop_et      IS 'Artisan DROP_ET — env temp at drop, °C';
COMMENT ON COLUMN roasts.drop_bt      IS 'Artisan DROP_BT — טמפ'' סיום, °C';
COMMENT ON COLUMN roasts.artisan_uuid IS 'Artisan roastUUID of the uploaded file; NULL = no Artisan file on this roast';

-- One Artisan profile can only ever be attached to one roast.
CREATE UNIQUE INDEX IF NOT EXISTS roasts_artisan_uuid_key
  ON roasts (artisan_uuid) WHERE artisan_uuid IS NOT NULL;


-- ── 2. artisan_profiles — the uploaded file, one per roast ─────────────────
-- The roaster records the roast as usual, then uploads the Artisan file onto
-- that record, so the link is always explicit — nothing is ever inferred.
--
-- An import only ever adds readings. It never creates a roast and never
-- rewrites weights, origin or date: those would move real stock.

CREATE TABLE IF NOT EXISTS artisan_profiles (
  id             BIGSERIAL PRIMARY KEY,

  -- One file per roast: re-uploading replaces it. UNIQUE on artisan_uuid stops
  -- the same Artisan file being attached to two different roasts by mistake.
  roast_id       BIGINT NOT NULL UNIQUE REFERENCES roasts(id) ON DELETE CASCADE,
  artisan_uuid   TEXT   NOT NULL UNIQUE,

  roasted_at     TIMESTAMPTZ NOT NULL,          -- from Artisan roastepoch (charge time)
  beans          TEXT,                          -- bean name as typed in Artisan
  title          TEXT,
  batch_label    TEXT,                          -- roastbatchprefix || roastbatchnr, when set
  operator       TEXT,

  green_kg       NUMERIC,                       -- weight[0], converted to kg
  roasted_kg     NUMERIC,                       -- weight[1], converted to kg

  charge_et      NUMERIC,                       -- all °C
  charge_bt      NUMERIC,
  drop_et        NUMERIC,
  drop_bt        NUMERIC,
  total_time_sec NUMERIC,

  computed       JSONB,                         -- Artisan's whole `computed` block
  meta           JSONB,                         -- profile body MINUS the curve arrays

  filename       TEXT,                          -- as uploaded, for the record

  -- Org-wide table, never filtered by user. Present only so that an insert
  -- through useSupabaseData (which always stamps user_id) cannot fail.
  user_id        TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE artisan_profiles ENABLE ROW LEVEL SECURITY;

-- Dropped first so the whole migration can be replayed on another environment.
DROP POLICY IF EXISTS "artisan_profiles_shared_select" ON artisan_profiles;
CREATE POLICY "artisan_profiles_shared_select" ON artisan_profiles
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "artisan_profiles_shared_insert" ON artisan_profiles;
CREATE POLICY "artisan_profiles_shared_insert" ON artisan_profiles
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "artisan_profiles_shared_update" ON artisan_profiles;
CREATE POLICY "artisan_profiles_shared_update" ON artisan_profiles
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "artisan_profiles_shared_delete" ON artisan_profiles;
CREATE POLICY "artisan_profiles_shared_delete" ON artisan_profiles
  FOR DELETE TO anon, authenticated USING (true);

-- roast_id and artisan_uuid are already indexed by their UNIQUE constraints.

COMMENT ON TABLE artisan_profiles IS
  'The Artisan roast file uploaded onto a roast record — one per roast, replaced on re-upload. Curve arrays (timex/temp1/temp2) are stripped before storage to keep the row small.';
COMMENT ON COLUMN artisan_profiles.meta IS
  'Artisan profile body with timex/temp1/temp2/extratemp* removed — keeps rows ~3KB instead of ~50KB.';
