-- ============================================================================
-- Artisan → CoffeeFlow roasting log integration
-- ============================================================================
--
-- Artisan (artisan-scope.org) is the roasting software used at the roastery.
-- Its Autosave writes a JSON profile after every roast; a watcher uploads that
-- file to the `artisan-import` edge function, which lands the roast curve's
-- key temperatures on the matching row in `roasts`.
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
COMMENT ON COLUMN roasts.artisan_uuid IS 'Artisan roastUUID of the attached profile; NULL = no Artisan data';

-- One Artisan profile can only ever be attached to one roast.
CREATE UNIQUE INDEX IF NOT EXISTS roasts_artisan_uuid_key
  ON roasts (artisan_uuid) WHERE artisan_uuid IS NOT NULL;


-- ── 2. Bean-name aliases ────────────────────────────────────────────────────
-- The roaster types the bean name into Artisan by hand, so it will not always
-- equal the CoffeeFlow name. The attach action writes the typed spelling here
-- ("זכור את השם הזה"), so the mapping teaches itself — no admin screen needed.

ALTER TABLE origins        ADD COLUMN IF NOT EXISTS artisan_name TEXT;
ALTER TABLE roast_profiles ADD COLUMN IF NOT EXISTS artisan_name TEXT;

COMMENT ON COLUMN origins.artisan_name        IS 'Bean name as typed in Artisan, for import matching';
COMMENT ON COLUMN roast_profiles.artisan_name IS 'Bean name as typed in Artisan, for import matching';


-- ── 3. artisan_profiles — every import, matched or staged ───────────────────
-- roast_id IS NULL means "staged": the file arrived but no roast row matched
-- it yet. That is the NORMAL case, because the roaster logs the roast in
-- CoffeeFlow after roasting, while the file lands the moment OFF is pressed.
--
-- An import NEVER creates a roast row — that would move green/roasted stock.

CREATE TABLE IF NOT EXISTS artisan_profiles (
  id             BIGSERIAL PRIMARY KEY,

  artisan_uuid   TEXT NOT NULL UNIQUE,          -- Artisan roastUUID; re-upload updates in place
  roast_id       BIGINT REFERENCES roasts(id) ON DELETE SET NULL,

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

  source         TEXT NOT NULL DEFAULT 'watcher',  -- 'watcher' | 'manual'
  filename       TEXT,

  -- Org-wide table, never filtered by user. Present only so that an insert
  -- through useSupabaseData (which always stamps user_id) cannot fail.
  user_id        TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attached_at    TIMESTAMPTZ
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

-- The staging list — the only query the Roasting page runs hot.
CREATE INDEX IF NOT EXISTS artisan_profiles_staged_idx
  ON artisan_profiles (roasted_at DESC) WHERE roast_id IS NULL;

CREATE INDEX IF NOT EXISTS artisan_profiles_roast_id_idx
  ON artisan_profiles (roast_id) WHERE roast_id IS NOT NULL;

COMMENT ON TABLE artisan_profiles IS
  'One row per Artisan roast profile imported from the roastery. roast_id NULL = staged, waiting to be attached to a roast. Curve arrays (timex/temp1/temp2) are stripped before storage to keep the row small.';
COMMENT ON COLUMN artisan_profiles.meta IS
  'Artisan profile body with timex/temp1/temp2/extratemp* removed — keeps rows ~3KB instead of ~50KB.';
