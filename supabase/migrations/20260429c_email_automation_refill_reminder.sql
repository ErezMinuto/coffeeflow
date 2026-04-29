-- Refill reminder automation — second trigger after first_purchase.
--
-- Rationale: specialty coffee is a recurring-consumption product. A
-- customer who bought 330g and drinks 2-4 cups/day finishes the bag
-- in 14-21 days. Sending a "running low?" reminder near the end of
-- their bag is the single highest-leverage repeat-purchase nudge a
-- specialty roaster can ship.
--
-- Smart cadence (not just "N days for everyone"):
--   • First-time coffee customer: remind 21 days after their first
--     coffee order (default; tunable via delay_days).
--   • Returning customer (2+ coffee orders): compute their personal
--     average interval between coffee orders, remind at that cadence.
--     Caps at min/max sanity bounds (skip cadence < 7 or > 90 days)
--     handled in the edge function.
--
-- Per-cycle dedup: a customer can receive multiple refill reminders
-- over their lifetime, one per coffee-order cycle. The unique key
-- changes from (trigger_type, customer_email) — fine for the once-
-- ever first_purchase trigger — to (trigger_type, customer_email,
-- woo_order_id) so each refill reminder is tied to the specific order
-- it's nudging the customer to refill.
--
-- Idempotent.

-- ────────────────────────────────────────────────────────────────────────
-- 1. Per-cycle uniqueness on email_automations
-- ────────────────────────────────────────────────────────────────────────
-- Old constraint blocked any second row for (trigger, email) — too
-- restrictive for a recurring trigger. New constraint allows multiple
-- rows per (trigger, email) as long as woo_order_id differs.
--
-- Safe for first_purchase: each first-time customer has exactly one
-- woo_order_id (the single order that put them on the candidate list),
-- so the new constraint enforces the same one-row-per-customer
-- behavior for that trigger as before.

ALTER TABLE email_automations
  DROP CONSTRAINT IF EXISTS email_automations_trigger_type_customer_email_key;

-- Use a partial unique index instead of a column constraint so NULL
-- woo_order_id values are still treated as distinct (Postgres default).
-- Practically: every real automation has a non-NULL woo_order_id, so
-- this behaves like a normal unique constraint on the three columns.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_automation_per_customer_per_order
  ON email_automations (trigger_type, customer_email, woo_order_id);

-- ────────────────────────────────────────────────────────────────────────
-- 2. Seed refill_reminder template
-- ────────────────────────────────────────────────────────────────────────
-- enabled=false at seed time — owner flips it on after a dry run shows
-- the candidate set looks reasonable.
--
-- coupon_percent=NULL by default: refill customers are already buying;
-- a discount is leakage. Owner can set it later via the dashboard
-- editor if they want to layer in a small incentive.

INSERT INTO email_automation_templates (
  trigger_type,
  display_name,
  enabled,
  delay_days,
  max_lookback_days,
  subject_template,
  body_html_template,
  coupon_percent,
  coupon_expiry_days,
  coupon_product_category_slugs
) VALUES (
  'refill_reminder',
  'תזכורת חידוש — קונה חוזר',
  false,
  21,  -- first-timer default; returning customers use their own avg cadence
  35,  -- delay + 14 day catch-up window
  '☕ הפולים שלך כנראה אוזלים — חידוש?',
  $$<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><title>חידוש פולים — מינוטו</title></head>
<body style="font-family: Arial, sans-serif; background: #f6f3ee; margin: 0; padding: 20px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
    <tr>
      <td style="background: linear-gradient(160deg, #3D4A2E 0%, #6A7D45 100%); padding: 28px 32px 20px; text-align: center; color: white;">
        <img src="{{ logo_url }}" alt="Minuto Cafe" style="max-height: 64px; width: auto; margin-bottom: 12px;" />
        <h1 style="margin: 0; font-size: 24px;">חידוש?</h1>
        <p style="margin: 8px 0 0; font-size: 14px; opacity: 0.9;">בית קלייה ספשלטי, רחובות</p>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px; color: #2a2a2a; line-height: 1.7;">
        <p style="margin: 0 0 16px;">היי {{ first_name }},</p>
        <p style="margin: 0 0 16px;">לפי קצב הצריכה הרגיל, הפולים שהזמנת בפעם האחרונה אמורים להיות ממש לקראת הסוף. לפני שהבוקר הבא יהיה בלי קפה אמיתי — אולי הזמנה חדשה?</p>
        <p style="margin: 0 0 24px;">אני קולה כל בוקר ברחובות ושולח את הפולים תוך יום-יומיים מהקלייה.</p>

        <div style="text-align: center; margin: 24px 0;">
          <a href="https://www.minuto.co.il/product-category/פולי-קפה-טרי-מינוטו-specialty-coffee/" style="display: inline-block; background: #6A7D45; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
            לעמוד הפולים →
          </a>
        </div>

        <p style="margin: 24px 0 16px;">כמה דברים שכדאי לדעת:</p>
        <ul style="margin: 0 0 16px; padding-right: 20px; color: #4a4a4a;">
          <li style="margin-bottom: 8px;">אפשר לחזור על אותם פולים שאהבת, או לנסות משהו חדש מבית הקלייה.</li>
          <li style="margin-bottom: 8px;">משלוח מגיע תוך יום-יומיים. הפולים תמיד טריים — נקלים בבוקר, יוצאים אליך.</li>
          <li style="margin-bottom: 8px;">שאלות? אפשר להשיב למייל הזה, אני קורא ועונה אישית.</li>
        </ul>

        <p style="margin: 32px 0 0; color: #6a6a6a; font-size: 14px;">שיהיה בכיף,<br>מינוטו קפה</p>
      </td>
    </tr>
    <tr>
      <td style="background: #f6f3ee; padding: 20px 32px; text-align: center; font-size: 12px; color: #8a8a8a; line-height: 1.7;">
        <p style="margin: 0;"><strong style="color: #3D4A2E;">מינוטו קפה בע"מ</strong></p>
        <p style="margin: 0;">אחד העם 22, רחובות</p>
        <p style="margin: 0;">📞 054-4490486 · 📧 <a href="mailto:info@minuto.co.il" style="color: #6A7D45;">info@minuto.co.il</a></p>
        <p style="margin: 8px 0 0;"><a href="https://www.minuto.co.il" style="color: #6A7D45;">minuto.co.il</a> · <a href="https://www.instagram.com/minuto_coffee/" style="color: #6A7D45;">@minuto_coffee</a></p>
        <p style="margin: 12px 0 0; padding-top: 12px; border-top: 1px solid #e0d8c8; font-size: 11px;">
          קיבלת את המייל הזה כי הזמנת ממינוטו בעבר.
          <a href="{{ unsubscribe_url }}" style="color: #8a8a8a; text-decoration: underline;">להסרה מתזכורות חידוש</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>$$,
  NULL,  -- no coupon by default (owner can set via editor later)
  60,
  ARRAY['פולי-קפה-טרי-מינוטו-specialty-coffee']  -- if coupon added later, restricted to coffee
)
ON CONFLICT (trigger_type) DO NOTHING;
