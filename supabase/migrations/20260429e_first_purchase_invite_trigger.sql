-- Third automation trigger: first_purchase_invite — sends a single
-- email to first-time customers who did NOT opt into the marketing
-- list, inviting them to subscribe (with a 10% coupon as the carrot).
--
-- Why this exists separately from first_purchase:
--   • first_purchase fires for opted-in customers (welcome + coupon)
--   • first_purchase_invite fires for NON-opted-in customers
--     (invitation to subscribe; coupon comes after they actually
--     subscribe, via the newsletter-welcome flow in forms-submit)
--
-- Legal basis (per the privacy policy update on 2026-04-29):
-- one-time post-purchase invitation is allowed under Israeli soft
-- opt-in for existing customers, with clear unsubscribe in every
-- email. The privacy policy section 2א explicitly discloses this
-- practice.
--
-- enabled=false at seed time. Owner runs dry-run, reviews the copy,
-- then flips on when ready.
--
-- Idempotent.

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
  'first_purchase_invite',
  'הזמנה לרשימת התפוצה — קונה חדש שלא הצטרף',
  false,
  2,   -- same delay as first_purchase: 2 days post-order
  3,   -- same lookback as first_purchase
  '☕ ההזמנה הראשונה שלך — איך לקבל 10% הנחה על הבאה?',
  $$<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><title>10% הנחה על ההזמנה הבאה — מינוטו</title></head>
<body style="font-family: Arial, sans-serif; background: #f6f3ee; margin: 0; padding: 20px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
    <tr>
      <td style="background: linear-gradient(160deg, #3D4A2E 0%, #6A7D45 100%); padding: 28px 32px 20px; text-align: center; color: white;">
        <img src="{{ logo_url }}" alt="Minuto Cafe" style="max-height: 64px; width: auto; margin-bottom: 12px;" />
        <h1 style="margin: 0; font-size: 24px;">תודה על ההזמנה הראשונה ☕</h1>
        <p style="margin: 8px 0 0; font-size: 14px; opacity: 0.9;">בית קלייה ספשלטי, רחובות</p>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px; color: #2a2a2a; line-height: 1.7;">
        <p style="margin: 0 0 16px;">היי {{ first_name }},</p>
        <p style="margin: 0 0 16px;">תודה שהזמנת ממינוטו. הפולים בדרך אליך, ואנחנו מקווים שתיהנה מהם.</p>
        <p style="margin: 0 0 24px;">רצינו לשתף איתך משהו: יש לנו רשימת תפוצה שבה אנחנו שולחים פעם בכמה שבועות עדכונים על פולים חדשים מבית הקלייה, מאמרים על קפה ספשלטי וטיפים להכנת קפה ביתי. בלי ספאם, רק תוכן שיעניין אותך.</p>

        <div style="background: #f6f3ee; border: 2px dashed #6A7D45; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
          <p style="margin: 0 0 8px; font-size: 16px; color: #3D4A2E; font-weight: bold;">הצטרפ/י עכשיו וקבל/י 10% הנחה על ההזמנה הבאה</p>
          <p style="margin: 0 0 16px; font-size: 13px; color: #6a6a6a;">פולי קפה ספשלטי בלבד · שימוש חד-פעמי</p>
          <a href="https://www.minuto.co.il/?subscribe=newsletter&email={{ email_encoded }}" style="display: inline-block; background: #6A7D45; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
            להצטרפות לרשימת התפוצה →
          </a>
        </div>

        <p style="margin: 24px 0 16px;">איך זה עובד:</p>
        <ol style="margin: 0 0 16px; padding-right: 20px; color: #4a4a4a;">
          <li style="margin-bottom: 8px;">לוחצים על הכפתור למעלה ומשלימים פרטים בטופס ההצטרפות.</li>
          <li style="margin-bottom: 8px;">מקבלים למייל קוד 10% הנחה על פולי קפה ספשלטי.</li>
          <li style="margin-bottom: 8px;">משתמשים בקוד בעמוד התשלום בהזמנה הבאה.</li>
        </ol>

        <p style="margin: 16px 0 0;">לא רוצה להירשם? אין בעיה — לא נשלח עוד מיילים. ההזמנה הזו לא תחזור.</p>

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
          קיבלת את המייל הזה כי הזמנת ממינוטו לראשונה. זוהי הזמנה חד-פעמית
          להצטרפות לרשימת התפוצה — לא תקבל מיילים שיווקיים נוספים אלא אם
          תבחר/י להצטרף.
          <a href="{{ unsubscribe_url }}" style="color: #8a8a8a; text-decoration: underline;">הסרה</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>$$,
  NULL,  -- no coupon for the invite itself; coupon comes via newsletter welcome after they subscribe
  60,
  ARRAY['פולי-קפה-טרי-מינוטו-specialty-coffee']
)
ON CONFLICT (trigger_type) DO NOTHING;
