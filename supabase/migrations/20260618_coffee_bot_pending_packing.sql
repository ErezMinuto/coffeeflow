-- =============================================================================
-- Coffee-bot tap-to-select packing flow: short-lived pending state.
--
-- The packing flow is now two steps to eliminate name-matching mistakes:
--   1. Employee taps a product from an inline keyboard (/pack).
--   2. Bot remembers WHICH product they tapped (one row here, keyed by
--      telegram_id) and asks for the bag count. The employee replies with a
--      plain number, which the bot pairs with the remembered product.
--
-- One pending selection per telegram_id (upsert on tap). Rows are honored only
-- for a few minutes (the bot checks created_at) and deleted once the packing is
-- recorded, so a stale number typed later is never misattributed to an old tap.
--
-- Applied directly to prod via the management API — CLI migrations are drifted.
-- Idempotent so re-running is safe. Additive only.
-- =============================================================================

CREATE TABLE IF NOT EXISTS coffee_bot_pending_packing (
  telegram_id  TEXT        NOT NULL PRIMARY KEY,
  chat_id      TEXT        NOT NULL,
  product_id   INTEGER     NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coffee_bot_pending_packing_created_idx
  ON coffee_bot_pending_packing (created_at);

ALTER TABLE coffee_bot_pending_packing ENABLE ROW LEVEL SECURITY;

-- RLS enabled with no anon/authenticated policies → only the service role (used
-- by coffee-bot) can read or write. anon/authenticated clients cannot touch it.
DROP POLICY IF EXISTS "service_only_select" ON coffee_bot_pending_packing;
DROP POLICY IF EXISTS "service_only_insert" ON coffee_bot_pending_packing;
DROP POLICY IF EXISTS "service_only_update" ON coffee_bot_pending_packing;
DROP POLICY IF EXISTS "service_only_delete" ON coffee_bot_pending_packing;

GRANT SELECT, INSERT, UPDATE, DELETE ON coffee_bot_pending_packing TO service_role;
