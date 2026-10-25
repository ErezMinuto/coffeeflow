-- Remove MFlow-created orders from woo_orders + woo_order_items_enriched.
--
-- DO NOT APPLY without Erez's approval: it changes historical revenue,
-- attribution, RFM and first-purchase numbers that read these tables.
--
-- What they are: orders MFlow (POS / B2B / phone sales) creates in Woo over
-- the REST API (created_via = rest-api, meta order_source = mflow). They are
-- not web checkouts. woo-orders-sync let them in because its MFlow filter
-- looked only at _wc_order_attribution_source_type; the sync now also checks
-- created_via + order_source, so no new ones arrive.
--
-- The ids were measured 2026-10-25 by fetching every stored woo_order_id from
-- the Woo REST API and keeping created_via = rest-api (all of which carry
-- order_source = mflow). Deliberately NOT included: orders with only
-- traking_type = "Advanced Purchase Tracking (APT)". That is PixelYourSite's
-- server-side purchase marker and sits on real web subscription renewals and
-- card-paid checkouts.
--
-- Knock-on effects:
--   * mx_web_orders is driven by mflow_revenue (channel = ecosite) and LEFT
--     JOINs woo_orders. MFlow books most of these orders as ecosite, so they
--     stay in the view, now with missing_woo_row = true and no attribution.
--   * rfm-sync only upserts customer_rfm; rows for customers whose only orders
--     were these keep their old scores until removed separately.
--
-- Reversible: the removed rows are copied to *_mflow_removed first.

BEGIN;

CREATE TABLE IF NOT EXISTS woo_orders_mflow_removed
  (LIKE woo_orders INCLUDING DEFAULTS);
CREATE TABLE IF NOT EXISTS woo_order_items_enriched_mflow_removed
  (LIKE woo_order_items_enriched INCLUDING DEFAULTS);
ALTER TABLE woo_orders_mflow_removed               ENABLE ROW LEVEL SECURITY;
ALTER TABLE woo_order_items_enriched_mflow_removed ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON woo_orders_mflow_removed, woo_order_items_enriched_mflow_removed
  FROM anon, authenticated;

CREATE TEMP TABLE mflow_ids (id bigint PRIMARY KEY) ON COMMIT DROP;
INSERT INTO mflow_ids (id) SELECT unnest(ARRAY[
  79518, 79522, 79546, 79585, 79586, 79587, 79595, 79602, 79613, 79632,
  79658, 79659, 79660, 79663, 79666, 79669, 79671, 79704, 79708, 79710,
  79714, 79717, 79732, 79739, 79768, 79774, 79775, 79778, 79779, 79784,
  79801, 79847, 79862, 79863, 79872, 79875, 79895, 79926, 79944, 79958,
  79966, 79986, 79998, 80000, 80002, 80026, 80031, 80038, 80050, 80063,
  80068, 80093, 80095, 80097, 80100, 80102, 80104, 80116, 80140, 80141,
  80161, 80165, 80179, 80184, 80203, 80219, 80225, 80226, 80265, 80269,
  80270, 80272, 80273, 80298, 80299, 80324, 80328, 80346, 80373, 80400,
  80426, 80431, 80508, 80534, 80615, 80634, 80635, 80651, 80697, 80703,
  80705, 80706, 80707, 80708, 80716, 80718, 80720, 80757, 80844, 80846,
  80878, 81039, 81258, 81480, 81481, 81488, 81489, 81545, 81546, 81590,
  81780, 81880, 81901, 81903, 81906, 82039, 82050, 82069, 82096, 82108,
  82122, 82129, 82154, 82163, 82167, 82186, 82219, 82250, 82251, 82253,
  82262, 82270, 82322, 82331, 82333, 82335, 82336, 82337, 82338, 82339,
  82353, 82354, 82355, 82356, 82359, 82378, 82388, 82389, 82406, 82410,
  82444, 82446, 82467, 82473, 82478, 82533, 82584, 82591, 82606, 82610,
  82611, 82621, 82626, 82676, 82689, 82718, 82747, 82752, 82801, 82814,
  82836, 82846, 82857, 82869, 82870, 82887, 82903
]::bigint[]);

INSERT INTO woo_orders_mflow_removed
  SELECT w.* FROM woo_orders w JOIN mflow_ids m ON m.id = w.woo_order_id;
INSERT INTO woo_order_items_enriched_mflow_removed
  SELECT i.* FROM woo_order_items_enriched i JOIN mflow_ids m ON m.id = i.order_id;

DELETE FROM woo_order_items_enriched i USING mflow_ids m WHERE m.id = i.order_id;
DELETE FROM woo_orders w               USING mflow_ids m WHERE m.id = w.woo_order_id;

COMMIT;
