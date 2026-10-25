-- coffee_checkin: bring prod to the approved design.
--
-- 20261026_retention_emails.sql was applied twice (13:29 and 14:05 on
-- 2026-10-25). Its coffee_checkin INSERT is ON CONFLICT DO NOTHING, so the
-- second run kept the first, rejected design. This updates the template to
-- the approved one (same body as the current 20261026 file).
--
-- Guarded like the refill_reminder update: touches the row only while
-- coffee_checkin has never sent, so it can never overwrite copy that
-- customers have already received or that the owner edited after go-live.
-- Settings, enabled and delays are left as they are. Idempotent.

UPDATE email_automation_templates t SET
  display_name       = 'איך היה הקפה? (הזמנה ראשונה)',
  subject_template   = 'איך היה הקפה, {{ first_name }}?',
  body_html_template = $$<!DOCTYPE html>
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
      <h1 style="margin:0 0 20px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:26px; line-height:1.3; font-weight:700; color:#3C4A2C; text-align:right;">איך היה הקפה?</h1>
      <p style="margin:0 0 16px; font-size:16px; line-height:1.75; color:#333333;">היי {{ first_name }},</p>
      <p style="margin:0 0 16px; font-size:16px; line-height:1.75; color:#333333;">הפולים מההזמנה הראשונה שלך כבר אצלך כמה ימים, ורצינו לשמוע איך הם בכוס.</p>
      <p style="margin:0; font-size:16px; line-height:1.75; color:#333333;">יצא לך טעים? משהו לא הסתדר בטחינה או בחליטה? <strong style="color:#3C4A2C;">אפשר פשוט להשיב למייל הזה.</strong> הוא מגיע ישירות אלינו בבית הקלייה, ואנחנו עונים לכל הודעה.</p>
    </td></tr>
    {{ review_block_html }}
    <tr><td style="padding:8px 40px 36px; text-align:right; font-size:16px; line-height:1.75;">
      
      <p style="margin:28px 0 0; color:#333333;">תודה שבחרת בנו,<br>צוות מינוטו</p>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
    <tr><td align="center" style="padding:24px 32px 8px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:13px; line-height:1.8; color:#555555;">
      מינוטו קפה בע״מ · בית קלייה ספשלטי · אחד העם 22, רחובות<br>
      <a href="mailto:info@minuto.co.il" style="color:#555555;">info@minuto.co.il</a> · <a href="https://www.minuto.co.il" style="color:#555555;">minuto.co.il</a> · <a href="https://www.instagram.com/minuto_coffee/" style="color:#555555;">Instagram</a>
    </td></tr>
    <tr><td align="center" style="padding:4px 32px 24px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:12px; line-height:1.8; color:#666666;">
      קיבלת את המייל הזה כי הזמנת ממינוטו לראשונה. <a href="{{ unsubscribe_url }}" style="color:#666666;">להסרה מרשימת הדיוור</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>$$,
  updated_at         = now()
WHERE t.trigger_type = 'coffee_checkin'
  AND NOT EXISTS (SELECT 1 FROM email_automations a WHERE a.trigger_type = 'coffee_checkin');
