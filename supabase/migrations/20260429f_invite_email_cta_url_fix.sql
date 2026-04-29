-- Fix the first_purchase_invite email's subscribe CTA URL.
--
-- When this trigger was originally seeded, the CTA pointed to
--    /?subscribe=newsletter&email={{ email_encoded }}
-- which assumed a homepage-level URL handler that never got built.
-- The current homepage (still on Flashy) ignores the query string,
-- so the customer would land at the homepage with no auto-fill, no
-- guidance to subscribe, and would have to find the Flashy newsletter
-- form themselves — which submits to Flashy, not our forms-submit
-- endpoint. End result: 10% coupon never reaches them.
--
-- Fix: point at a dedicated /subscribe.html landing page that:
--   • reads ?email=… and prefills the form
--   • POSTs to api.minuto.co.il/forms-submit (our pipeline)
--   • redirects to /subscribed.html which tells them the coupon
--     is on the way.
--
-- subscribe.html and subscribed.html are uploaded to web root via
-- FTP (same pattern as forms-test.html). Dev can later replace with
-- a proper WordPress page that inherits site chrome — the URL is
-- the same either way.
--
-- Idempotent (REPLACE no-ops if already applied).

UPDATE email_automation_templates
SET
  body_html_template = REPLACE(
    body_html_template,
    'https://www.minuto.co.il/?subscribe=newsletter&email={{ email_encoded }}',
    'https://www.minuto.co.il/subscribe.html?email={{ email_encoded }}'
  ),
  updated_at = NOW()
WHERE trigger_type = 'first_purchase_invite';
