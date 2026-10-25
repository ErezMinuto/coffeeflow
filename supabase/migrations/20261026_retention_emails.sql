-- Retention emails (owner's rules, 2026-10-25). Both start DISABLED; the
-- scheduler's dry run lists who would get what before anything is enabled.
--
--   coffee_checkin   1 paid web order that included beans → one "how was your coffee?" email,
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
  'איך היה הקפה, {{ first_name }}?',
  $$<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>איך היה הקפה?</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0; padding:0; background:#F7F7F7; font-family:'Heebo', Arial, Helvetica, sans-serif; color:#333333;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F7F7F7;">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px; background:#FFFFFF;">
    <tr><td align="center" style="padding:28px 32px 22px; border-bottom:1px solid #E6E6E6;">
      <a href="https://www.minuto.co.il"><img src="https://minuto.co.il/content/uploads/2025/03/Frame-14.png" alt="Minuto Café Roastery" width="132" style="display:block; width:132px; max-width:132px; height:auto; border:0;"></a>
    </td></tr>
    {{ product_block_html }}
    <tr><td style="padding:36px 40px 8px; text-align:right;">
      <h1 style="margin:0 0 20px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:26px; line-height:1.3; font-weight:700; color:#3C4A2C; text-align:center;">איך היה הקפה?</h1>
      <p style="margin:0 0 16px; font-size:16px; line-height:1.75; color:#333333;">היי {{ first_name }},</p>
      <p style="margin:0 0 16px; font-size:16px; line-height:1.75; color:#333333;">הפולים מההזמנה הראשונה שלך כבר אצלך כמה ימים, ורצינו לשמוע איך הם בכוס.</p>
      <p style="margin:0; font-size:16px; line-height:1.75; color:#333333;">יצא לך טעים? משהו לא הסתדר בטחינה או בחליטה? אפשר פשוט להשיב למייל הזה. הוא מגיע ישירות אלינו בבית הקלייה, ואנחנו עונים לכל הודעה.</p>
    </td></tr>
    {{ review_block_html }}
    <tr><td style="padding:8px 40px 36px; text-align:right; font-size:16px; line-height:1.75;">
      
      <p style="margin:28px 0 0; color:#333333;">תודה שבחרת בנו,<br>צוות מינוטו</p>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
    <tr><td align="center" style="padding:24px 32px 8px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:12px; line-height:1.8; color:#7F7F7F;">
      מינוטו קפה בע״מ · בית קלייה ספשלטי · אחד העם 22, רחובות<br>
      <a href="mailto:info@minuto.co.il" style="color:#7F7F7F;">info@minuto.co.il</a> · <a href="https://www.minuto.co.il" style="color:#7F7F7F;">minuto.co.il</a> · <a href="https://www.instagram.com/minuto_coffee/" style="color:#7F7F7F;">Instagram</a>
    </td></tr>
    <tr><td align="center" style="padding:4px 32px 24px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:11px; line-height:1.8; color:#9A9A9A;">
      קיבלת את המייל הזה כי הזמנת ממינוטו לראשונה. <a href="{{ unsubscribe_url }}" style="color:#9A9A9A;">להסרה מרשימת הדיוור</a>
    </td></tr>
  </table>
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
  subject_template   = 'פרסומת: {{ first_name }}, הגיע הזמן לשקית חדשה?',
  settings           = jsonb_build_object(
                         'min_orders', 3, 'cadence_factor', 0.85,
                         'min_cadence_days', 7, 'max_cadence_days', 120, 'grace_days', 7),
  body_html_template = $$<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>תזכורת הזמנה חוזרת</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0; padding:0; background:#F7F7F7; font-family:'Heebo', Arial, Helvetica, sans-serif; color:#333333;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F7F7F7;">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px; background:#FFFFFF;">
    <tr><td align="center" style="padding:28px 32px 22px; border-bottom:1px solid #E6E6E6;">
      <a href="https://www.minuto.co.il"><img src="https://minuto.co.il/content/uploads/2025/03/Frame-14.png" alt="Minuto Café Roastery" width="132" style="display:block; width:132px; max-width:132px; height:auto; border:0;"></a>
    </td></tr>
    {{ product_block_html }}
    <tr><td style="padding:36px 40px 8px; text-align:right;">
      <h1 style="margin:0 0 20px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:26px; line-height:1.3; font-weight:700; color:#3C4A2C; text-align:center;">הגיע הזמן לשקית חדשה?</h1>
      <p style="margin:0 0 16px; font-size:16px; line-height:1.75; color:#333333;">היי {{ first_name }},</p>
      <p style="margin:0; font-size:16px; line-height:1.75; color:#333333;">לפי הקצב שבו הזמנת עד עכשיו, השקית האחרונה כנראה מתקרבת לסוף. כדאי להזמין כמה ימים מראש, כדי שהפולים הבאים יגיעו טריים מהקלייה לפני שהקודמים נגמרים.</p>
    </td></tr>
    <tr><td align="center" style="padding:12px 40px 20px;">
      <a href="{{ shop_url }}" style="display:inline-block; background:#3C4A2C; color:#FFFFFF; text-decoration:none; font-size:16px; font-weight:700; padding:14px 40px; border-radius:4px;">להזמנה חוזרת</a>
    </td></tr>
    <tr><td style="padding:8px 40px 36px; text-align:right; font-size:16px; line-height:1.75;">
      <p style="margin:0; font-size:14px; line-height:1.75; color:#7F7F7F;">כבר הזמנת? אפשר להתעלם מהמייל הזה.</p>
      <p style="margin:28px 0 0; color:#333333;">צוות מינוטו</p>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
    <tr><td align="center" style="padding:24px 32px 8px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:12px; line-height:1.8; color:#7F7F7F;">
      מינוטו קפה בע״מ · בית קלייה ספשלטי · אחד העם 22, רחובות<br>
      <a href="mailto:info@minuto.co.il" style="color:#7F7F7F;">info@minuto.co.il</a> · <a href="https://www.minuto.co.il" style="color:#7F7F7F;">minuto.co.il</a> · <a href="https://www.instagram.com/minuto_coffee/" style="color:#7F7F7F;">Instagram</a>
    </td></tr>
    <tr><td align="center" style="padding:4px 32px 24px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:11px; line-height:1.8; color:#9A9A9A;">
      קיבלת את המייל הזה כי אישרת לקבל ממינוטו עדכונים ותזכורות.<br><a href="{{ stop_reminders_url }}" style="color:#9A9A9A;">להפסקת תזכורות ההזמנה</a> · <a href="{{ unsubscribe_url }}" style="color:#9A9A9A;">להסרה מכל המיילים השיווקיים</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>$$,
  updated_at         = now()
WHERE t.trigger_type = 'refill_reminder'
  AND NOT EXISTS (SELECT 1 FROM email_automations a WHERE a.trigger_type = 'refill_reminder');
