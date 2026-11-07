-- Owner: "remove all the bot text plus long dashes". Em dashes ("—") and
-- "marketing voice" phrasing make the email read like AI output. Rewriting
-- in a more personal voice — Erez writing to a real customer, not a brand
-- writing to a segment.
--
-- Specific changes:
--   - Every "—" replaced with a period, comma, or sentence break
--   - "מותאם אישית עבורך" removed (translationese / bot tell)
--   - "אנחנו כבר במלאכה" → "אני קולה את הפולים בימים הקרובים" (first
--     person, concrete)
--   - "אענה אישית" → "אני קורא ועונה אישית"
--   - Tightened the bullet list, removed the "<strong>:" template markers
--
-- Idempotent UPDATE on the seed row.

UPDATE email_automation_templates
SET
  body_html_template = $$<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><title>תודה ממינוטו</title></head>
<body style="font-family: Arial, sans-serif; background: #f6f3ee; margin: 0; padding: 20px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden;">
    <tr>
      <td style="background: linear-gradient(160deg, #3D4A2E 0%, #6A7D45 100%); padding: 28px 32px 20px; text-align: center; color: white;">
        <img src="{{ logo_url }}" alt="Minuto Cafe" style="max-height: 64px; width: auto; margin-bottom: 12px;" />
        <h1 style="margin: 0; font-size: 26px;">תודה {{ first_name }} ☕</h1>
        <p style="margin: 8px 0 0; font-size: 14px; opacity: 0.9;">קלייה טרייה, ישר אליך</p>
      </td>
    </tr>
    <tr>
      <td style="padding: 32px; color: #2a2a2a; line-height: 1.7;">
        <p style="margin: 0 0 16px;">היי {{ first_name }},</p>
        <p style="margin: 0 0 16px;">תודה שהזמנת ממינוטו. אני קולה את הפולים שלך בימים הקרובים, והם יוצאים אליך טריים.</p>
        <p style="margin: 0 0 24px;">הכנתי לך קופון 10% להזמנה הבאה:</p>

        <div style="background: #f6f3ee; border: 2px dashed #6A7D45; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
          <p style="margin: 0 0 8px; font-size: 14px; color: #6A7D45; font-weight: bold;">10% הנחה להזמנה הבאה</p>
          <p style="margin: 0 0 12px; font-family: 'Courier New', monospace; font-size: 22px; font-weight: bold; color: #3D4A2E; letter-spacing: 2px;">{{ coupon_code }}</p>
          <p style="margin: 0; font-size: 12px; color: #6a6a6a;">תקף ל-{{ coupon_expiry_days }} ימים, שימוש חד-פעמי</p>
        </div>

        <p style="margin: 0 0 24px;">הקופון מקושר לכתובת המייל הזו, אז אין צורך לזכור אותו. ההנחה תוחל אוטומטית כשתחזור.</p>

        <p style="margin: 0 0 12px;">כמה דברים שכדאי לדעת:</p>
        <ul style="margin: 0 0 16px; padding-right: 20px; color: #4a4a4a;">
          <li style="margin-bottom: 8px;">תאריך הקלייה מודפס על השקית. הפולים בשיא בין 2 ל-7 ימים אחרי הקלייה.</li>
          <li style="margin-bottom: 8px;">אריזות 330 גרם זו לא קמצנות. צרכן ביתי שותה 2 עד 4 כוסות ביום, וזה בדיוק מה שמסיימים לפני שהפולים מאבדים מהאיכות.</li>
          <li style="margin-bottom: 8px;">שאלות? תענה למייל הזה, אני קורא ועונה אישית.</li>
        </ul>

        <p style="margin: 32px 0 0; color: #6a6a6a; font-size: 14px;">תיהנה,<br>ארז אלבז<br>מינוטו קפה</p>
      </td>
    </tr>
    <tr>
      <td style="background: #f6f3ee; padding: 20px 32px; text-align: center; font-size: 12px; color: #8a8a8a; line-height: 1.7;">
        <p style="margin: 0;"><strong style="color: #3D4A2E;">מינוטו קפה בע"מ</strong></p>
        <p style="margin: 0;">אחד העם 22, רחובות</p>
        <p style="margin: 0;">📞 054-4490486 · 📧 <a href="mailto:info@minuto.co.il" style="color: #6A7D45;">info@minuto.co.il</a></p>
        <p style="margin: 8px 0 0;"><a href="https://www.minuto.co.il" style="color: #6A7D45;">minuto.co.il</a> · <a href="https://www.instagram.com/minuto_coffee/" style="color: #6A7D45;">@minuto_coffee</a></p>
        <p style="margin: 12px 0 0; padding-top: 12px; border-top: 1px solid #e0d8c8; font-size: 11px;">
          קיבלת את המייל הזה כי קנית ממינוטו לראשונה.
          <a href="{{ unsubscribe_url }}" style="color: #8a8a8a; text-decoration: underline;">להסרה מרשימת התפוצה</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>$$,
  updated_at = NOW()
WHERE trigger_type = 'first_purchase';
