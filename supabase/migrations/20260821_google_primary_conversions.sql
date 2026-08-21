-- Separate PRIMARY conversions from all_conversions in google_campaigns.
--
-- google-sync picks `allConv > 0 ? allConv : primaryConv`, i.e. it PREFERS
-- all_conversions. In Google Ads:
--   conversions      = Primary conversion actions only — the real goal
--   all_conversions  = every action including Secondary ones (page views,
--                      add-to-cart, phone clicks, directions…)
--
-- Measured over the last 30 days: Google reports 794 conversions against 124
-- real web orders — about 6.4x inflated — which turns a genuine CPA of roughly
-- ₪18 into a reported ₪2-3.
--
-- Worse, it is internally inconsistent: the AD-level and KEYWORD-level syncs
-- read metrics.conversions (primary). So the same account answers differently
-- depending which level you look at, and comparing them looks like a dramatic
-- change when nothing changed at all. That exact confusion produced a false
-- "CPA collapsed" alarm on the Meta side.
--
-- Legacy columns are left ALONE so historical rows stay comparable with each
-- other; the honest figures go in new columns and the agent is pointed at them.
ALTER TABLE google_campaigns ADD COLUMN IF NOT EXISTS primary_conversions      NUMERIC(12,2);
ALTER TABLE google_campaigns ADD COLUMN IF NOT EXISTS primary_conversion_value NUMERIC(12,2);

COMMENT ON COLUMN google_campaigns.conversions IS
  'LEGACY, INFLATED: prefers all_conversions, which counts Secondary actions (page views, add-to-cart, phone clicks) alongside real ones. Kept for historical continuity — use primary_conversions for any cost-per-acquisition decision.';
COMMENT ON COLUMN google_campaigns.primary_conversions IS
  'metrics.conversions — PRIMARY conversion actions only. The denominator for CPA, and the same metric the ad-level and keyword-level syncs already use.';
