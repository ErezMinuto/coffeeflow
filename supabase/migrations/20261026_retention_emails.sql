-- Retention emails (owner's rules, 2026-10-25). Both start DISABLED; the
-- scheduler's dry run lists who would get what before anything is enabled.
--
--   coffee_checkin   1 paid web order → one "how was your coffee?" email,
--                    9–14 days after the order was completed (= handed to
--                    Cargo / ready at the café), once per customer ever.
--                    The Google review link is shown only when
--                    settings.review_link_enabled = true (reviews on the
--                    Business Profile are paused as of 2026-10-25).
--   refill_reminder  rewritten (never sent before): 3+ paid web orders →
--                    reorder reminder at median gap × 0.85 after the last
--                    bean order, one per cycle, marketing consent only,
--                    one-click "stop reminders" link.
--
-- Also:
--   messaging_reminder_prefs  append-only stop/resume log per customer
--                             (latest row wins; nothing is ever deleted).
--   customer_orders           + checkout marketing-consent columns, filled by
--                             woo-orders-sync from the checkout checkbox meta.
--   email_automation_templates.settings  per-trigger knobs (jsonb).
--
-- Idempotent. Additive except the refill_reminder template UPDATE, which only
-- touches a row that is disabled and has never sent (guarded below).

-- ────────────────────────────────────────────────────────────────────────
-- 1. Per-trigger settings
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE email_automation_templates
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}';

-- ────────────────────────────────────────────────────────────────────────
-- 2. Checkout consent on customer_orders
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE customer_orders
  ADD COLUMN IF NOT EXISTS marketing_consent      boolean,      -- NULL = no checkbox on that order (before the snippet)
  ADD COLUMN IF NOT EXISTS consent_text_version   text,
  ADD COLUMN IF NOT EXISTS consent_at             timestamptz;

-- ────────────────────────────────────────────────────────────────────────
-- 3. Stop / resume reminders (append-only)
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messaging_reminder_prefs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES customers(id),
  action       text NOT NULL CHECK (action IN ('stop', 'resume')),
  source       text NOT NULL CHECK (source IN ('email_link', 'one_click', 'dashboard')),
  actor        text,                               -- dashboard user email; NULL for the customer's own click
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS messaging_reminder_prefs_customer_idx
  ON messaging_reminder_prefs (customer_id, created_at DESC);

ALTER TABLE messaging_reminder_prefs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON messaging_reminder_prefs FROM anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────
-- 4. coffee_checkin template
-- ────────────────────────────────────────────────────────────────────────
INSERT INTO email_automation_templates (
  trigger_type, display_name, enabled, delay_days, max_lookback_days,
  subject_template, body_html_template, coupon_percent, coupon_expiry_days, settings
) VALUES (
  'coffee_checkin',
  'איך היה הקפה? (הזמנה ראשונה)',
  false,
  9,    -- days after the order was completed
  14,   -- last day still sent; the 9–14 window stops a first enable from mailing the whole history
  'איך הקפה שלך, {{ first_name }}?',
  $$<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>איך היה הקפה?</title></head>
<body style="margin:0; padding:20px; background:#f6f3ee; font-family:Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:12px; overflow:hidden;">
    <tr><td style="padding:28px 32px 0; text-align:center;">
      <img src="{{ logo_url }}" alt="מינוטו" width="120" style="display:inline-block; max-width:120px; height:auto;">
    </td></tr>
    <tr><td style="padding:24px 32px 8px; color:#2a2a2a; line-height:1.7; font-size:16px;">
      <p style="margin:0 0 16px;">היי {{ first_name }},</p>
      <p style="margin:0 0 16px;">הפולים מההזמנה הראשונה שלך כבר אצלך כמה ימים, ורצינו לשמוע איך הם בכוס.</p>
      <p style="margin:0 0 16px;">יצא לך טעים? משהו לא הסתדר בטחינה או בחליטה? אפשר פשוט להשיב למייל הזה, הוא מגיע ישירות אלינו בבית הקלייה ואנחנו עונים לכל הודעה.</p>
      {{ review_block_html }}
      <p style="margin:24px 0 0; color:#4a4a4a;">תודה שבחרת בנו,<br>צוות מינוטו קפה, בית קלייה ספיישלטי</p>
    </td></tr>
    <tr><td style="background:#f6f3ee; padding:16px 32px; text-align:center; font-size:12px; color:#8a8a8a; line-height:1.6;">
      <p style="margin:0 0 4px;">מינוטו קפה בע״מ · אחד העם 22, רחובות · <a href="mailto:info@minuto.co.il" style="color:#6A7D45;">info@minuto.co.il</a></p>
      <p style="margin:0;">לא רוצה לקבל מאיתנו מיילים? <a href="{{ unsubscribe_url }}" style="color:#6A7D45;">להסרה</a></p>
    </td></tr>
  </table>
</body>
</html>$$,
  NULL,  -- never a coupon: no reward for reviews (Google policy)
  60,
  jsonb_build_object(
    'review_url', 'https://g.page/r/Ccp6rPQ-ykYMEAI/review',
    'review_link_enabled', false   -- reviews paused on the Business Profile; flip when lifted
  )
)
ON CONFLICT (trigger_type) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────
-- 5. refill_reminder — new rules + copy. Only while it has never sent.
-- ────────────────────────────────────────────────────────────────────────
UPDATE email_automation_templates t SET
  display_name       = 'תזכורת הזמנה חוזרת (3 הזמנות ומעלה)',
  enabled            = false,
  coupon_percent     = NULL,
  subject_template   = 'פרסומת: {{ first_name }}, הפולים שלך כנראה מתקרבים לסוף',
  settings           = jsonb_build_object(
                         'min_orders', 3, 'cadence_factor', 0.85,
                         'min_cadence_days', 7, 'max_cadence_days', 120, 'grace_days', 7),
  body_html_template = $$<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>תזכורת הזמנה חוזרת</title></head>
<body style="margin:0; padding:20px; background:#f6f3ee; font-family:Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:12px; overflow:hidden;">
    <tr><td style="padding:28px 32px 0; text-align:center;">
      <img src="{{ logo_url }}" alt="מינוטו" width="120" style="display:inline-block; max-width:120px; height:auto;">
    </td></tr>
    <tr><td style="padding:24px 32px 8px; color:#2a2a2a; line-height:1.7; font-size:16px;">
      <p style="margin:0 0 16px;">היי {{ first_name }},</p>
      <p style="margin:0 0 16px;">לפי הקצב שבו הזמנת עד עכשיו, השקית האחרונה כנראה מתקרבת לסוף. כדאי להזמין כמה ימים מראש, כדי שהפולים הבאים יגיעו טריים מהקלייה לפני שהקודמים נגמרים.</p>
      <p style="margin:24px 0; text-align:center;">
        <a href="{{ shop_url }}" style="display:inline-block; background:#3D4A2E; color:#ffffff; text-decoration:none; padding:12px 28px; border-radius:8px; font-weight:bold;">להזמנה באתר</a>
      </p>
      <p style="margin:0 0 16px; color:#4a4a4a;">כבר הזמנת? אפשר להתעלם מהמייל הזה.</p>
      <p style="margin:24px 0 0; color:#4a4a4a;">צוות מינוטו קפה, בית קלייה ספיישלטי</p>
    </td></tr>
    <tr><td style="background:#f6f3ee; padding:16px 32px; text-align:center; font-size:12px; color:#8a8a8a; line-height:1.6;">
      <p style="margin:0 0 4px;">מינוטו קפה בע״מ · אחד העם 22, רחובות · <a href="mailto:info@minuto.co.il" style="color:#6A7D45;">info@minuto.co.il</a></p>
      <p style="margin:0 0 4px;"><a href="{{ stop_reminders_url }}" style="color:#6A7D45;">להפסקת תזכורות ההזמנה</a></p>
      <p style="margin:0;">להסרה מכל המיילים השיווקיים: <a href="{{ unsubscribe_url }}" style="color:#6A7D45;">להסרה מרשימת התפוצה</a></p>
    </td></tr>
  </table>
</body>
</html>$$,
  updated_at         = now()
WHERE t.trigger_type = 'refill_reminder'
  AND NOT EXISTS (SELECT 1 FROM email_automations a WHERE a.trigger_type = 'refill_reminder');
