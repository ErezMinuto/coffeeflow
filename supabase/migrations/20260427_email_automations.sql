-- Email automation infrastructure: trigger-based, per-customer email flows.
-- Owned by CoffeeFlow (not Flashy) so we keep full control of the data
-- and the trigger logic. Phase 1 supports a single trigger ('first_purchase')
-- with a unique-per-customer 10% off coupon, but the schema is generic
-- enough to add more triggers later (refill reminder, abandoned cart, etc.)
-- without another migration.

-- ────────────────────────────────────────────────────────────────────────
-- 1. Trigger templates — one row per automation type
-- ────────────────────────────────────────────────────────────────────────
-- Editable from the dashboard so the owner can iterate copy without
-- redeploying. `enabled` is the kill switch — flip to false and the
-- scheduler stops sending without code changes.

CREATE TABLE IF NOT EXISTS email_automation_templates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_type       TEXT UNIQUE NOT NULL,           -- 'first_purchase' (more later)
  display_name       TEXT NOT NULL,
  enabled            BOOLEAN NOT NULL DEFAULT false, -- start disabled — enable in UI when ready
  delay_days         INT NOT NULL DEFAULT 3,         -- days after trigger event
  -- max_lookback_days bounds the "how far back to consider" window. Set
  -- low (e.g. 3) to prevent enabling-the-trigger-for-the-first-time from
  -- mass-blasting the entire historical backlog — only orders within
  -- (now - max_lookback_days) AND (now - delay_days) qualify.
  -- Note: requires max_lookback_days >= delay_days, else no orders ever
  -- qualify (the windows don't overlap).
  max_lookback_days  INT NOT NULL DEFAULT 3,
  subject_template   TEXT NOT NULL,
  body_html_template TEXT NOT NULL,
  coupon_percent     INT,                            -- 10 = 10% off
  coupon_expiry_days INT NOT NULL DEFAULT 60,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the first_purchase template — Hebrew, references {{ coupon_code }}
-- which the scheduler swaps in per customer. Owner can override via UI.
INSERT INTO email_automation_templates (
  trigger_type, display_name, enabled, delay_days, max_lookback_days,
  subject_template, body_html_template, coupon_percent, coupon_expiry_days
) VALUES (
  'first_purchase',
  'מייל ברוך הבא — קונה ראשונה',
  false,  -- owner enables explicitly
  3,
  -- max_lookback_days = 3 means "only catch first-time orders placed
  -- in the last 3 days". Combined with delay_days=3, the eligibility
  -- window narrows to orders that just crossed the 3-day mark — no
  -- backlog blast on first enable. If cron is unreliable, bump this
  -- to 7 for a 4-day catch-up window.
  3,
  '☕ תודה שהזמנת מאיתנו — והנה 10% להזמנה הבאה',
  $$<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><title>תודה ממינוטו</title></head>
<body style="font-family: Arial, sans-serif; background: #f6f3ee; margin: 0; padding: 20px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
    <tr>
      <td style="background: linear-gradient(160deg, #3D4A2E 0%, #6A7D45 100%); padding: 32px; text-align: center; color: white;">
        <h1 style="margin: 0; font-size: 28px;">תודה {{ first_name }} ☕</h1>
        <p style="margin: 8px 0 0; font-size: 14px; opacity: 0.9;">קלייה טרייה, ישר אליך</p>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px; color: #2a2a2a; line-height: 1.6;">
        <p style="margin: 0 0 16px;">היי {{ first_name }},</p>
        <p style="margin: 0 0 16px;">תודה שהצטרפת לקהילת מינוטו ברכישה הראשונה שלך. אנחנו כבר במלאכה — הפולים שלך נקלים בימים קרובים, נארזים, ויוצאים לדרך.</p>
        <p style="margin: 0 0 24px;">בינתיים, רצינו להגיד תודה כמו שצריך:</p>

        <div style="background: #f6f3ee; border: 2px dashed #6A7D45; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
          <p style="margin: 0 0 8px; font-size: 14px; color: #6A7D45; font-weight: bold;">10% הנחה להזמנה הבאה שלך</p>
          <p style="margin: 0 0 12px; font-family: 'Courier New', monospace; font-size: 22px; font-weight: bold; color: #3D4A2E; letter-spacing: 2px;">{{ coupon_code }}</p>
          <p style="margin: 0; font-size: 12px; color: #6a6a6a;">תקף ל-{{ coupon_expiry_days }} ימים · שימוש חד-פעמי · מותאם אישית עבורך</p>
        </div>

        <p style="margin: 0 0 16px;">הקופון שלך מקושר לכתובת המייל הזו, אז אין צורך לזכור אותו — ההנחה תוחל אוטומטית כשתחזור לקנות.</p>

        <p style="margin: 24px 0 16px;">כמה דברים שכדאי לדעת:</p>
        <ul style="margin: 0 0 16px; padding-right: 20px; color: #4a4a4a;">
          <li style="margin-bottom: 8px;"><strong>טריות לפני הכל</strong> — תאריך הקלייה מודפס על השקית. שווה להתחיל לטעום 2-7 ימים אחרי הקלייה.</li>
          <li style="margin-bottom: 8px;"><strong>אריזות 330 גרם</strong> — בחירה מודעת. צרכן ביתי שותה 2-4 כוסות ביום, וזו כמות שמסיים לפני שהפולים מאבדים מהאיכות.</li>
          <li style="margin-bottom: 8px;"><strong>שאלות?</strong> תכתוב לי בחזרה למייל הזה. אענה אישית.</li>
        </ul>

        <p style="margin: 32px 0 0; color: #6a6a6a; font-size: 14px;">תיהנה מהקפה,<br>ארז אלבז<br>מינוטו קפה</p>
      </td>
    </tr>
    <tr>
      <td style="background: #f6f3ee; padding: 16px 32px; text-align: center; font-size: 12px; color: #8a8a8a;">
        <p style="margin: 0 0 4px;">מינוטו קפה בע"מ · אחד העם 22, רחובות</p>
        <p style="margin: 0;"><a href="https://www.minuto.co.il" style="color: #6A7D45;">minuto.co.il</a> · <a href="mailto:info@minuto.co.il" style="color: #6A7D45;">info@minuto.co.il</a></p>
      </td>
    </tr>
  </table>
</body>
</html>$$,
  10,
  60
)
ON CONFLICT (trigger_type) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────
-- 2. email_automations — one row per (trigger × customer × order)
-- ────────────────────────────────────────────────────────────────────────
-- Tracks every automated email through its full lifecycle. UNIQUE
-- constraint on (trigger_type, customer_email) prevents double-sending
-- the same trigger to the same customer ever — even if the cron fires
-- twice or the order data is reloaded.

CREATE TABLE IF NOT EXISTS email_automations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_type      TEXT NOT NULL REFERENCES email_automation_templates(trigger_type),
  customer_email    TEXT NOT NULL,
  customer_name     TEXT,                                  -- billing.first_name for personalization
  woo_order_id      INT REFERENCES woo_orders(woo_order_id),
  coupon_code       TEXT,                                  -- generated WC coupon
  status            TEXT NOT NULL,                          -- 'pending' | 'sent' | 'failed' | 'skipped'
  resend_email_id   TEXT,                                  -- Resend message id for tracking opens/clicks
  scheduled_for     TIMESTAMPTZ NOT NULL,                  -- when the cron should pick it up
  sent_at           TIMESTAMPTZ,
  error_msg         TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotency: one welcome email per customer per trigger, ever.
  UNIQUE(trigger_type, customer_email)
);

-- Index for the scheduler's "find pending due" query
CREATE INDEX IF NOT EXISTS idx_email_automations_pending
  ON email_automations (status, scheduled_for)
  WHERE status = 'pending';

-- Index for "show me sent history per trigger" in the dashboard
CREATE INDEX IF NOT EXISTS idx_email_automations_trigger_sent
  ON email_automations (trigger_type, sent_at DESC NULLS LAST);
