-- Whole-bean bags were filed as grinders.
--
-- Woo appends the chosen variation to an order line's name, and the whole-bean
-- option reads "לא לטחון, יש לי מטחנה" ("don't grind, I have a grinder").
-- categorizeProduct() matched /מטחנ/ on it, so every whole-bean bag became
-- category=grinder, is_bean=false. Effects in prod (2026-10-26):
--   • woo_order_items_enriched: ₪195K of 2026 bean revenue reported as grinders
--     (real grinders ₪40K) → the strategist brain saw a grinder business.
--   • customer_orders: 1,237 orders, 997 of them has_beans=false although they
--     were bean orders → coffee_checkin / refill_reminder would skip them.
--
-- The code fix (woo-orders-sync/customer_orders.ts) strips that phrase before
-- matching. This backfill applies the same rule to stored rows: only lines that
-- are category=grinder, carry the phrase, and classify as coffee once it is
-- removed. is_bean and grams_each follow isBeanLine() and the name branch of
-- parseGrams(); a size that lives only on the Woo attribute stays NULL (the
-- sync's own fallback), which makes that order's bean_grams NULL as in code.
--
-- ORDER: deploy woo-orders-sync first. The old code re-upserts recently
-- modified orders on its daily run and would put the wrong values back.
--
-- Idempotent: a second run finds nothing to change. UPDATE only, no deletes.

-- 1. customer_orders.lines + has_beans + bean_grams
WITH affected AS (
  SELECT o.woo_order_id, o.lines
  FROM customer_orders o
  WHERE o.lines::text ~ 'יש\s*לי\s*מטחנה'
),
el AS (
  SELECT a.woo_order_id, e.ord, e.l,
         regexp_replace(lower(e.l->>'name'), 'יש\s*לי\s*מטחנה', '', 'g') AS stripped,
         regexp_replace(e.l->>'name', '[״"׳'']', '', 'g') AS gtext
  FROM affected a, jsonb_array_elements(a.lines) WITH ORDINALITY e(l, ord)
),
fixed AS (
  SELECT woo_order_id, ord,
    CASE
      WHEN l->>'category' = 'grinder'
       AND (l->>'name') ~ 'יש\s*לי\s*מטחנה'
       AND stripped !~* 'mahlk[oö]nig|mazzer|eureka|fiorenzato|baratza|comandante|1zpresso|timemore|wilfa|מטחנ|grinder'
       AND stripped !~* 'la\s*marzocco|\mecm\M|profitec|\mrocket\M|\mlelit\M|gaggia|rancilio|nuova\s*simonelli|slayer|linea|מכונת אספרסו|מכונת קפה|espresso\s*machine'
       AND stripped ~* '\mbeans?\M|\mblend\M|single\s*origin|\mespresso\M|yirgacheffe|sidamo|guji|ethiopia|kenya|colombia|brazil|costa\s*rica|panama|guatemala|פול|בלנד|ספשלטי|אתיופיה|קולומביה|ברזיל|קניה|גואטמלה|קפה טרי|פולי קפה'
      THEN l || jsonb_build_object(
        'category', 'coffee',
        'is_bean', (l->>'name') !~* 'קפסול|capsul|נספרסו|nespresso|\mrdt\M|קערית|ספל|כוס|glass|\mcup\M|דריפ|dripper',
        'grams_each', CASE WHEN (l->>'name') ~* 'קפסול|capsul|נספרסו|nespresso|\mrdt\M|קערית|ספל|כוס|glass|\mcup\M|דריפ|dripper' THEN NULL ELSE (
          SELECT CASE WHEN g BETWEEN 50 AND 10000 THEN g END FROM (SELECT COALESCE(
            round(replace(substring(gtext from '(\d+(?:[.,]\d+)?)\s*-?\s*(?:קג|קילו|kg)(?![a-z])'), ',', '.')::numeric * 1000),
            substring(gtext from '(\d{2,4})\s*-?\s*(?:גרם|גר|g|gr)(?![a-z])')::numeric
          ) AS g) x) END)
      ELSE l
    END AS l
  FROM el
),
rebuilt AS (
  SELECT woo_order_id,
         jsonb_agg(l ORDER BY ord) AS lines,
         bool_or((l->>'is_bean')::boolean) AS has_beans,
         CASE WHEN bool_and((l->>'grams_each') IS NOT NULL) FILTER (WHERE (l->>'is_bean')::boolean)
              THEN sum((l->>'grams_each')::numeric * (l->>'quantity')::numeric) FILTER (WHERE (l->>'is_bean')::boolean)
         END AS bean_grams
  FROM fixed GROUP BY woo_order_id
)
UPDATE customer_orders o
SET lines      = r.lines,
    has_beans  = r.has_beans,
    bean_grams = r.bean_grams
FROM rebuilt r
WHERE o.woo_order_id = r.woo_order_id
  AND (o.lines, o.has_beans, o.bean_grams) IS DISTINCT FROM (r.lines, r.has_beans, r.bean_grams::integer);

-- 2. woo_order_items_enriched.product_category
UPDATE woo_order_items_enriched
SET product_category = 'coffee'
WHERE product_category = 'grinder'
  AND product_name ~ 'יש\s*לי\s*מטחנה'
  AND regexp_replace(lower(product_name), 'יש\s*לי\s*מטחנה', '', 'g') !~* 'mahlk[oö]nig|mazzer|eureka|fiorenzato|baratza|comandante|1zpresso|timemore|wilfa|מטחנ|grinder'
  AND regexp_replace(lower(product_name), 'יש\s*לי\s*מטחנה', '', 'g') !~* 'la\s*marzocco|\mecm\M|profitec|\mrocket\M|\mlelit\M|gaggia|rancilio|nuova\s*simonelli|slayer|linea|מכונת אספרסו|מכונת קפה|espresso\s*machine'
  AND regexp_replace(lower(product_name), 'יש\s*לי\s*מטחנה', '', 'g') ~* '\mbeans?\M|\mblend\M|single\s*origin|\mespresso\M|yirgacheffe|sidamo|guji|ethiopia|kenya|colombia|brazil|costa\s*rica|panama|guatemala|פול|בלנד|ספשלטי|אתיופיה|קולומביה|ברזיל|קניה|גואטמלה|קפה טרי|פולי קפה';
