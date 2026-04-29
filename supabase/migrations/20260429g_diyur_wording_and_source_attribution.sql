-- Two changes to email_automation_templates, bundled because they touch
-- the same rows and we want one atomic deploy:
--
--   1. Wording: "רשימת תפוצה" → "רשימת דיוור" (and "התפוצה" → "הדיוור").
--      Owner preference — דיוור is the term used in the privacy policy
--      and reads as more deliberate / less spammy in Hebrew. Applied
--      to both first_purchase (live) and first_purchase_invite (newly
--      enabled).
--
--   2. Source attribution: the first_purchase_invite email's CTA URL
--      gains `&src=invite_email`. The /subscribe.html landing page
--      reads that param and forwards it to forms-submit, which writes
--      it to marketing_contacts.source. Lets us answer "how many of
--      the invite emails actually converted into subscribers?" without
--      tagging-by-time-window heuristics. Same /subscribe.html page
--      can be linked from instagram / homepage / QR code with different
--      ?src= values for clean per-channel attribution.
--
-- All REPLACE-based UPDATEs are idempotent — running twice no-ops.

-- 1a. first_purchase template wording
UPDATE email_automation_templates
SET
  body_html_template = REPLACE(
    REPLACE(body_html_template, 'רשימת התפוצה', 'רשימת הדיוור'),
    'רשימת תפוצה', 'רשימת דיוור'
  ),
  subject_template = REPLACE(
    REPLACE(subject_template, 'רשימת התפוצה', 'רשימת הדיוור'),
    'רשימת תפוצה', 'רשימת דיוור'
  ),
  display_name = REPLACE(
    REPLACE(display_name, 'רשימת התפוצה', 'רשימת הדיוור'),
    'רשימת תפוצה', 'רשימת דיוור'
  ),
  updated_at = NOW()
WHERE trigger_type = 'first_purchase';

-- 1b. first_purchase_invite template wording
UPDATE email_automation_templates
SET
  body_html_template = REPLACE(
    REPLACE(body_html_template, 'רשימת התפוצה', 'רשימת הדיוור'),
    'רשימת תפוצה', 'רשימת דיוור'
  ),
  subject_template = REPLACE(
    REPLACE(subject_template, 'רשימת התפוצה', 'רשימת הדיוור'),
    'רשימת תפוצה', 'רשימת דיוור'
  ),
  display_name = REPLACE(
    REPLACE(display_name, 'רשימת התפוצה', 'רשימת הדיוור'),
    'רשימת תפוצה', 'רשימת דיוור'
  ),
  updated_at = NOW()
WHERE trigger_type = 'first_purchase_invite';

-- 2. Add src=invite_email attribution param to first_purchase_invite CTA
UPDATE email_automation_templates
SET
  body_html_template = REPLACE(
    body_html_template,
    'https://www.minuto.co.il/subscribe.html?email={{ email_encoded }}',
    'https://www.minuto.co.il/subscribe.html?email={{ email_encoded }}&src=invite_email'
  ),
  updated_at = NOW()
WHERE trigger_type = 'first_purchase_invite';
