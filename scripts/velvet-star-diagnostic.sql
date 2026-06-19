-- Velvet Star bag_hero render diagnostic.
-- Goal: settle whether the failure is a broken bag reference (image_url) or
-- the model failing to reproduce a fetched label. Run against PROD.

-- ── A. Does the product resolve, and is its image_url present + plausible? ──
-- This is the exact lookup visual-test does (ILIKE on woo_products.name,
-- requiring a non-null image_url). If this returns 0 rows, the render fails
-- fast on "no name match with a non-null image_url" → the root cause is the
-- product row (missing/empty image_url), NOT the model.
SELECT woo_id, name, image_url, stock_status
FROM woo_products
WHERE name ILIKE '%Velvet Star%'
ORDER BY woo_id;

-- ── B. The two failing tasks — status, attempts, error, and the per-attempt
--       QA critiques (the "bag: OK/MISS" equivalent lives in result_data). ──
-- qa_attempts[].critique.issues will say "label gibberish" etc.; the rendered
-- image_url per attempt lets you eyeball whether a real bag or a fabricated
-- one came back.
SELECT
  id,
  task_type,
  status,
  attempts,
  max_attempts,
  left(error_msg, 300)                                   AS error_msg,
  brief_data->>'render_mode'                             AS render_mode,
  brief_data->>'product_name'                            AS product_name,
  brief_data->>'destination'                             AS destination,
  jsonb_array_length(COALESCE(result_data->'qa_attempts','[]'::jsonb)) AS qa_attempt_count,
  result_data->'qa_attempts'                             AS qa_attempts,
  result_data->>'review_required'                        AS review_required,
  created_at,
  updated_at
FROM seo_tasks
WHERE id::text LIKE 'f9661168%'
   OR id::text LIKE '6432a36c%';

-- ── C. Flatten the QA critiques into one row per attempt (easier to read) ──
SELECT
  t.id,
  (att->>'attempt')::int                AS attempt,
  att->>'render_mode'                   AS render_mode,
  att->'critique'->>'passes'            AS passes,
  att->'critique'->'missing'            AS missing,
  att->'critique'->'issues'             AS issues,
  att->'critique'->>'suggested_adjustment' AS suggested_adjustment,
  att->>'image_url'                     AS rendered_image_url
FROM seo_tasks t
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.result_data->'qa_attempts','[]'::jsonb)) AS att
WHERE t.id::text LIKE 'f9661168%'
   OR t.id::text LIKE '6432a36c%'
ORDER BY t.id, attempt;

-- Interpretation:
--   • Query A returns 0 rows, or image_url NULL/blank  → broken reference.
--     Fix the woo_products.image_url; the new fail-fast (PR #129) then makes
--     this surface as a clear 502 instead of a hallucinated bag.
--   • Query A returns a good URL that loads in a browser, AND query C shows
--     issues like "gibberish/illegible label"            → the model can't
--     reproduce that label. The stricter QA (PR #129) correctly routes it to
--     review instead of shipping; no auto-fix — it needs a human-picked image.
