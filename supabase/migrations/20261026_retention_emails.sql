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
<body style="font-family: Arial, sans-serif; background: #f6f3ee; margin: 0; padding: 20px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
    <tr>
      <td style="background-color: #3D4A2E; background: linear-gradient(160deg, #3D4A2E 0%, #6A7D45 100%); padding: 28px 32px 20px; text-align: center; color: white;">
        <!-- The logo is dark green on transparent: a white badge keeps it readable on the green band. -->
        <div style="display: inline-block; background: #ffffff; border-radius: 10px; padding: 8px 16px; margin-bottom: 14px;">
          <img src="{{ logo_url }}" alt="Minuto Café Roastery" style="display: block; max-height: 56px; width: auto;" />
        </div>
        <h1 style="margin: 0; font-size: 26px;">איך היה הקפה? ☕</h1>
        <p style="margin: 8px 0 0; font-size: 14px; opacity: 0.9;">בית קלייה ספשלטי, רחובות</p>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px; color: #2a2a2a; line-height: 1.7;">
        <p style="margin: 0 0 16px;">היי {{ first_name }},</p>
        <p style="margin: 0 0 16px;">הפולים מההזמנה הראשונה שלך כבר אצלך כמה ימים, ורצינו לשמוע איך הם בכוס.</p>
        <p style="margin: 0 0 16px;">יצא לך טעים? משהו לא הסתדר בטחינה או בחליטה? אפשר פשוט להשיב למייל הזה, הוא מגיע ישירות אלינו בבית הקלייה ואנחנו עונים לכל הודעה.</p>
        {{ review_block_html }}
        <p style="margin: 32px 0 0; color: #6a6a6a; font-size: 14px;">תודה שבחרת בנו,<br>צוות מינוטו קפה</p>
      </td>
    </tr>
    <tr>
      <td style="background: #f6f3ee; padding: 20px 32px; text-align: center; font-size: 12px; color: #8a8a8a; line-height: 1.7;">
        <p style="margin: 0;"><strong style="color: #3D4A2E;">מינוטו קפה בע"מ</strong></p>
        <p style="margin: 0;">אחד העם 22, רחובות</p>
        <p style="margin: 0;">📞 054-4490486 · 📧 <a href="mailto:info@minuto.co.il" style="color: #6A7D45;">info@minuto.co.il</a></p>
        <p style="margin: 8px 0 0;"><a href="https://www.minuto.co.il" style="color: #6A7D45;">minuto.co.il</a> · <a href="https://www.instagram.com/minuto_coffee/" style="color: #6A7D45;">@minuto_coffee</a></p>
        <p style="margin: 12px 0 0; padding-top: 12px; border-top: 1px solid #e0d8c8; font-size: 11px;">
          קיבלת את המייל הזה כי הזמנת ממינוטו לראשונה.
          <a href="{{ unsubscribe_url }}" style="color: #8a8a8a; text-decoration: underline;">להסרה מרשימת הדיוור</a>
        </p>
      </td>
    </tr>
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
<body style="font-family: Arial, sans-serif; background: #f6f3ee; margin: 0; padding: 20px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
    <tr>
      <td style="background-color: #3D4A2E; background: linear-gradient(160deg, #3D4A2E 0%, #6A7D45 100%); padding: 28px 32px 20px; text-align: center; color: white;">
        <!-- The logo is dark green on transparent: a white badge keeps it readable on the green band. -->
        <div style="display: inline-block; background: #ffffff; border-radius: 10px; padding: 8px 16px; margin-bottom: 14px;">
          <img src="{{ logo_url }}" alt="Minuto Café Roastery" style="display: block; max-height: 56px; width: auto;" />
        </div>
        <h1 style="margin: 0; font-size: 26px;">הפולים מתקרבים לסוף? ☕</h1>
        <p style="margin: 8px 0 0; font-size: 14px; opacity: 0.9;">בית קלייה ספשלטי, רחובות</p>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px; color: #2a2a2a; line-height: 1.7;">
        <p style="margin: 0 0 16px;">היי {{ first_name }},</p>
        <p style="margin: 0 0 16px;">לפי הקצב שבו הזמנת עד עכשיו, השקית האחרונה כנראה מתקרבת לסוף. כדאי להזמין כמה ימים מראש, כדי שהפולים הבאים יגיעו טריים מהקלייה לפני שהקודמים נגמרים.</p>
        <p style="margin: 28px 0; text-align: center;">
          <a href="{{ shop_url }}" style="display: inline-block; background: #3D4A2E; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 16px;">להזמנה באתר</a>
        </p>
        <p style="margin: 0 0 16px; color: #4a4a4a;">כבר הזמנת? אפשר להתעלם מהמייל הזה.</p>
        <p style="margin: 32px 0 0; color: #6a6a6a; font-size: 14px;">צוות מינוטו קפה</p>
      </td>
    </tr>
    <tr>
      <td style="background: #f6f3ee; padding: 20px 32px; text-align: center; font-size: 12px; color: #8a8a8a; line-height: 1.7;">
        <p style="margin: 0;"><strong style="color: #3D4A2E;">מינוטו קפה בע"מ</strong></p>
        <p style="margin: 0;">אחד העם 22, רחובות</p>
        <p style="margin: 0;">📞 054-4490486 · 📧 <a href="mailto:info@minuto.co.il" style="color: #6A7D45;">info@minuto.co.il</a></p>
        <p style="margin: 8px 0 0;"><a href="https://www.minuto.co.il" style="color: #6A7D45;">minuto.co.il</a> · <a href="https://www.instagram.com/minuto_coffee/" style="color: #6A7D45;">@minuto_coffee</a></p>
        <p style="margin: 12px 0 0; padding-top: 12px; border-top: 1px solid #e0d8c8; font-size: 11px;">
          קיבלת את המייל הזה כי אישרת לקבל ממינוטו עדכונים ותזכורות.
          <a href="{{ stop_reminders_url }}" style="color: #8a8a8a; text-decoration: underline;">להפסקת תזכורות ההזמנה</a>
          · <a href="{{ unsubscribe_url }}" style="color: #8a8a8a; text-decoration: underline;">להסרה מכל המיילים השיווקיים</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>$$,
  updated_at         = now()
WHERE t.trigger_type = 'refill_reminder'
  AND NOT EXISTS (SELECT 1 FROM email_automations a WHERE a.trigger_type = 'refill_reminder');
