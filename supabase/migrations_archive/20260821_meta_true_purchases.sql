-- Separate TRUE PURCHASES from funnel events in the Meta ad tables.
--
-- WHY: meta-sync's `conversions` column sums every funnel step — purchase,
-- add_to_cart, initiate_checkout, add_payment_info, and ALL offsite_conversion.*
-- pixel events. One shopper who carts, checks out, adds payment and buys is
-- counted four times or more. Measured over 2026-06-01..08-19 the column read
-- 3,309 "conversions" against 276 real web orders — inflated roughly 12x.
--
-- That number feeds the paid agent's decision rules, which are written in the
-- language of cost-per-PURCHASE: "CPA < 15 -> scale 50%", "CPA > 70 -> kill".
-- Fed a CPA that is ~12x too low, the kill rule is mathematically unreachable
-- and the agent can only ever answer "scale". Its judgement was never tested.
--
-- DESIGN: `conversions` is left ALONE so historical rows stay comparable with
-- each other. New columns carry the honest figures, and the agent is pointed at
-- `purchases`. Mixing the two is what produced the false "CPA fell from 1.28 to
-- 120" alarm — one week read from the inflated column, the next from live
-- purchase data.
ALTER TABLE meta_ad_campaigns ADD COLUMN IF NOT EXISTS purchases         INT;
ALTER TABLE meta_ad_campaigns ADD COLUMN IF NOT EXISTS purchase_value    NUMERIC(12,2);
-- Every action_type Meta returned, verbatim: {action_type: count}. Keeps the
-- funnel visible without overloading one column, and means a future question
-- about carts or checkouts needs no re-sync.
ALTER TABLE meta_ad_campaigns ADD COLUMN IF NOT EXISTS actions_breakdown JSONB;

ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS purchases         INT;
ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS purchase_value    NUMERIC(12,2);
ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS actions_breakdown JSONB;

COMMENT ON COLUMN meta_ad_campaigns.conversions IS
  'LEGACY, INFLATED: sums purchase + add_to_cart + initiate_checkout + add_payment_info + all offsite_conversion.*. One shopper counts several times. Kept for historical continuity only — use `purchases` for any cost-per-acquisition decision.';
COMMENT ON COLUMN meta_ad_campaigns.purchases IS
  'True purchases only: action_type purchase / offsite_conversion.fb_pixel_purchase / onsite_conversion.purchase. This is the denominator for CPA.';
