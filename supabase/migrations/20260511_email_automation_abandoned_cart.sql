-- Abandoned-cart reminder — third trigger family after first_purchase + refill_reminder.
--
-- Two-email sequence per abandoned cart:
--   abandoned_cart_1  — day 1 after pending order: gentle "did you forget?"
--   abandoned_cart_2  — day 4 after pending order: low-pressure follow-up,
--                       gated on cart_1 having actually sent
--
-- Both stop if the customer completes the order at any point — the
-- recovery check in findAbandonedCartCandidates excludes customers with
-- a completed/processing order on/after the pending order's date.
--
-- Why two trigger types instead of one trigger with a sequence column:
--   The existing uniq_automation_per_customer_per_order index keys on
--   (trigger_type, customer_email, woo_order_id) and is shared by
--   first_purchase + refill_reminder. Changing it for cart sequencing
--   would ripple. Splitting cart into two trigger types reuses the
--   existing index as-is: one row per (trigger, email, order_id), so
--   each cart can receive up to two rows (cart_1, cart_2) — exactly
--   the cap we want.
--
-- Consent gate (owner choice, 2026-05-11): NO opted-in filter on either
-- email. The customer explicitly handed us their email at checkout to
-- complete a purchase, so recovery is the industry-standard exception
-- to the marketing-consent rule used by first_purchase / refill_reminder.
--
-- Data source: WooCommerce REST API live, NOT woo_orders. The orders
-- sync deliberately fetches only completed+processing (woo-orders-sync
-- line 181 — "owner's preference: only sync paid orders"), so pending
-- carts never land in our DB. Querying WC directly preserves the
-- "woo_orders = paid orders only" invariant.
--
-- Cadence (chosen for coffee specifically — perishable, weekly-buy):
--   cart_1: delay_days=1, max_lookback_days=4 (1-day delay + 3-day catch-up)
--   cart_2: delay_days=4, max_lookback_days=8 (4-day delay + 4-day catch-up)
-- The 3-day gap between #1 and #2 gives the customer breathing room.
--
-- Operator caveat: WooCommerce auto-cancels pending orders after
-- `hold_stock_minutes` (WP admin → WooCommerce → Settings → Products →
-- Inventory). If that's set low, pending orders flip to 'cancelled'
-- before delay_days passes and these triggers catch nothing. Raise
-- the hold timeout to ≥ 9 days to cover both emails' lookback window
-- OR widen the scheduler to also fetch cancelled-without-payment.
--
-- Idempotent.

-- ────────────────────────────────────────────────────────────────────────
-- Email #1 — day 1 reminder, gentle
-- ────────────────────────────────────────────────────────────────────────
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
  'abandoned_cart_1',
  'תזכורת השלמת הזמנה — מייל 1 (יום 1)',
  false,  -- owner enables after dry-run + test-send approval
  1,
  4,
  '☕ הזמנה התחילה אבל לא הושלמה',
  $$<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><title>תזכורת השלמת הזמנה — מינוטו</title></head>
<body style="font-family: Arial, sans-serif; background: #f6f3ee; margin: 0; padding: 20px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
    <tr>
      <td style="background: linear-gradient(160deg, #3D4A2E 0%, #6A7D45 100%); padding: 28px 32px 20px; text-align: center; color: white;">
        <img src="{{ logo_url }}" alt="Minuto Cafe" style="max-height: 64px; width: auto; margin-bottom: 12px;" />
        <h1 style="margin: 0; font-size: 24px;">ההזמנה לא הושלמה</h1>
        <p style="margin: 8px 0 0; font-size: 14px; opacity: 0.9;">בית קלייה ספשלטי, רחובות</p>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px; color: #2a2a2a; line-height: 1.7;">
        <p style="margin: 0 0 16px;">היי {{ first_name }},</p>
        <p style="margin: 0 0 16px;">ראינו שהתחיל אצלנו תהליך הזמנה ולא הושלם. אם זאת היתה תקלה טכנית או שינוי דעת ברגע האחרון, הכל בסדר. בלי לחץ.</p>
        <p style="margin: 0 0 24px;">אם בא להמשיך מאיפה שעצרנו, הקישור למטה. הקלייה והמשלוח כרגיל, יום-יומיים מהקלייה ישר אליכם.</p>

        <div style="text-align: center; margin: 24px 0;">
          <a href="https://www.minuto.co.il/cart/" style="display: inline-block; background: #6A7D45; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
            לחזרה לעגלה →
          </a>
        </div>

        <p style="margin: 24px 0 16px;">קצת מידע שכדאי לדעת:</p>
        <ul style="margin: 0 0 16px; padding-right: 20px; color: #4a4a4a;">
          <li style="margin-bottom: 8px;">הקלייה טרייה. הפולים שיוצאים אליכם נקלו באותו השבוע.</li>
          <li style="margin-bottom: 8px;">משלוח רגיל מגיע תוך יום-יומיים מהקלייה.</li>
          <li style="margin-bottom: 8px;">יש שאלה לפני שמזמינים? אפשר להשיב למייל הזה ואענה אישית.</li>
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
          קיבלת את המייל הזה כי התחילה הזמנה באתר מינוטו ולא הושלמה.
          <a href="{{ unsubscribe_url }}" style="color: #8a8a8a; text-decoration: underline;">להסרה מתזכורות עתידיות</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>$$,
  NULL,
  60,
  ARRAY[]::TEXT[]
)
ON CONFLICT (trigger_type) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────
-- Email #2 — day 4 follow-up, low pressure, gated on cart_1 having sent
-- ────────────────────────────────────────────────────────────────────────
-- The "gated on cart_1 having sent" check lives in the scheduler
-- (findAbandonedCartCandidates) rather than in SQL, so it's documented
-- alongside the rest of the trigger logic. The check is: cart_2 only
-- fires for orders where email_automations has a row with
-- (trigger_type='abandoned_cart_1', status='sent', same woo_order_id).
-- This prevents cart_2 from firing alone if cart_1 was disabled or
-- failed for some reason — sending "still thinking?" without a prior
-- "did you forget?" reads as rude.

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
  'abandoned_cart_2',
  'תזכורת השלמת הזמנה — מייל 2 (יום 4)',
  false,
  4,
  8,
  '☕ הקפה עדיין שמור, אם מתאים לחזור',
  $$<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><title>תזכורת השלמת הזמנה — מינוטו</title></head>
<body style="font-family: Arial, sans-serif; background: #f6f3ee; margin: 0; padding: 20px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
    <tr>
      <td style="background: linear-gradient(160deg, #3D4A2E 0%, #6A7D45 100%); padding: 28px 32px 20px; text-align: center; color: white;">
        <img src="{{ logo_url }}" alt="Minuto Cafe" style="max-height: 64px; width: auto; margin-bottom: 12px;" />
        <h1 style="margin: 0; font-size: 24px;">העגלה עדיין שמורה</h1>
        <p style="margin: 8px 0 0; font-size: 14px; opacity: 0.9;">בית קלייה ספשלטי, רחובות</p>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px; color: #2a2a2a; line-height: 1.7;">
        <p style="margin: 0 0 16px;">היי {{ first_name }},</p>
        <p style="margin: 0 0 16px;">לפני כמה ימים התחילה אצלנו הזמנה ועדיין לא הושלמה. רק להזכיר בעדינות שהיא שמורה.</p>
        <p style="margin: 0 0 24px;">אם זאת היתה החלטה מודעת לוותר, לגמרי בסדר. אם זה היה ענייני זמן או תקלה, הקישור למטה ימשיך מאיפה שעצרנו.</p>

        <div style="text-align: center; margin: 24px 0;">
          <a href="https://www.minuto.co.il/cart/" style="display: inline-block; background: #6A7D45; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
            לחזרה לעגלה →
          </a>
        </div>

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
          קיבלת את המייל הזה כי התחילה הזמנה באתר מינוטו ולא הושלמה. זאת התזכורת האחרונה.
          <a href="{{ unsubscribe_url }}" style="color: #8a8a8a; text-decoration: underline;">להסרה מתזכורות עתידיות</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>$$,
  NULL,
  60,
  ARRAY[]::TEXT[]
)
ON CONFLICT (trigger_type) DO NOTHING;
