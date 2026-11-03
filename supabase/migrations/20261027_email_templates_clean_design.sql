-- Automation emails: the clean house design approved on 2026-10-25.
--
-- Rewrites body_html_template for the four older automation templates
-- (first_purchase, abandoned_cart_1, abandoned_cart_2, first_purchase_invite)
-- in the layout of coffee_checkin / refill_reminder (20261026_retention_emails):
-- #F7F7F7 page, white 560px card, centered logo over a hairline, right-aligned
-- #3C4A2C headline, one solid #3C4A2C button, quiet centered footer. No
-- gradients, emoji, rounded or dashed boxes.
--
-- Touches body_html_template ONLY. enabled, subjects, delays and settings are
-- left exactly as they are. Every {{ variable }} each template used is kept.
--
-- Guarded: a row is rewritten only while its body is still the exact text this
-- was written against (md5 below). If someone edited a template after that,
-- the final check aborts the whole migration instead of overwriting the edit.
-- Re-running after a successful apply is a no-op.

-- first_purchase
UPDATE email_automation_templates SET body_html_template = $$<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>תודה ממינוטו</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0; padding:0; background:#F7F7F7; font-family:'Heebo', Arial, Helvetica, sans-serif; color:#333333;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F7F7F7;">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px; background:#FFFFFF;">
    <tr><td align="center" style="padding:28px 32px 22px; border-bottom:1px solid #E6E6E6;">
      <a href="https://www.minuto.co.il"><img src="{{ logo_url }}" alt="Minuto Café Roastery" width="132" style="display:block; width:132px; max-width:132px; height:auto; border:0;"></a>
    </td></tr>
    <tr><td style="padding:36px 40px 8px; text-align:right;">
      <h1 style="margin:0 0 20px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:26px; line-height:1.3; font-weight:700; color:#3C4A2C; text-align:right;">תודה {{ first_name }}</h1>
      <p style="margin:0 0 16px; font-size:16px; line-height:1.75; color:#333333;">היי {{ first_name }},</p>
      <p style="margin:0 0 16px; font-size:16px; line-height:1.75; color:#333333;">תודה שהזמנת ממינוטו, ותודה שהצטרפת לרשימת הדיוור שלנו. במינוטו אנחנו קולים פולים טריים בכל שבוע ברחובות, ובוחרים את הציוד שאנחנו מוכרים בקפידה כדי לשרת אותם.</p>
      <p style="margin:0; font-size:16px; line-height:1.75; color:#333333;">כתודה על ההצטרפות לרשימת הדיוור, הכנו לך קופון 10% הנחה על פולי קפה ספשלטי, להזמנה הבאה:</p>
    </td></tr>
    <tr><td style="padding:20px 40px 4px; text-align:right;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid #E6E6E6; border-bottom:1px solid #E6E6E6;">
        <tr><td style="padding:18px 0; text-align:right; font-family:'Heebo', Arial, Helvetica, sans-serif;">
          <p style="margin:0 0 6px; font-size:14px; line-height:1.6; color:#555555;">10% הנחה על פולי קפה ספשלטי</p>
          <p style="margin:0 0 6px; font-size:24px; line-height:1.3; font-weight:700; letter-spacing:2px; color:#3C4A2C;">{{ coupon_code }}</p>
          <p style="margin:0; font-size:13px; line-height:1.6; color:#666666;">תקף ל-{{ coupon_expiry_days }} ימים, שימוש חד-פעמי</p>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:20px 40px 8px; text-align:right;">
      <p style="margin:0 0 16px; font-size:16px; line-height:1.75; color:#333333;">כדי להפעיל את ההנחה: יש להזין את הקוד בעמוד התשלום בהזמנת פולים הבאה. הקוד תקף רק עם כתובת המייל הזו.</p>
      <p style="margin:0 0 8px; font-size:16px; line-height:1.75; color:#333333;">כמה דברים שכדאי לדעת:</p>
      <ul style="margin:0; padding:0 20px 0 0; font-size:16px; line-height:1.75; color:#333333;">
        <li style="margin:0 0 8px;">תאריך הקלייה מודפס על כל שקית פולים.</li>
        <li style="margin:0 0 8px;">השילוב של מכונה איכותית עם פולים טריים הוא מה שעושה את כל ההבדל.</li>
        <li style="margin:0 0 8px;">שאלות? אפשר להשיב למייל הזה, אני קורא ועונה אישית.</li>
      </ul>
    </td></tr>
    <tr><td style="padding:8px 40px 36px; text-align:right; font-size:16px; line-height:1.75;">
      <p style="margin:28px 0 0; color:#333333;">שיהיה בכיף,<br>מינוטו קפה</p>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
    <tr><td align="center" style="padding:24px 32px 8px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:13px; line-height:1.8; color:#555555;">
      מינוטו קפה בע״מ · בית קלייה ספשלטי · אחד העם 22, רחובות<br>
      <a href="tel:+972544490486" style="color:#555555;">054-4490486</a> · <a href="mailto:info@minuto.co.il" style="color:#555555;">info@minuto.co.il</a> · <a href="https://www.minuto.co.il" style="color:#555555;">minuto.co.il</a> · <a href="https://www.instagram.com/minuto_coffee/" style="color:#555555;">Instagram</a>
    </td></tr>
    <tr><td align="center" style="padding:4px 32px 24px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:12px; line-height:1.8; color:#666666;">
      קיבלת את המייל הזה כי קנית ממינוטו לראשונה. <a href="{{ unsubscribe_url }}" style="color:#666666;">להסרה מרשימת הדיוור</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>$$
WHERE trigger_type = 'first_purchase'
  AND md5(body_html_template) = 'c26dd5039f42c045bdf27885d4b19ae5';

-- abandoned_cart_1
UPDATE email_automation_templates SET body_html_template = $$<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>תזכורת השלמת הזמנה, מינוטו</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0; padding:0; background:#F7F7F7; font-family:'Heebo', Arial, Helvetica, sans-serif; color:#333333;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F7F7F7;">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px; background:#FFFFFF;">
    <tr><td align="center" style="padding:28px 32px 22px; border-bottom:1px solid #E6E6E6;">
      <a href="https://www.minuto.co.il"><img src="{{ logo_url }}" alt="Minuto Café Roastery" width="132" style="display:block; width:132px; max-width:132px; height:auto; border:0;"></a>
    </td></tr>
    <tr><td style="padding:36px 40px 8px; text-align:right;">
      <h1 style="margin:0 0 20px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:26px; line-height:1.3; font-weight:700; color:#3C4A2C; text-align:right;">ההזמנה לא הושלמה</h1>
      <p style="margin:0 0 16px; font-size:16px; line-height:1.75; color:#333333;">היי {{ first_name }},</p>
      <p style="margin:0 0 16px; font-size:16px; line-height:1.75; color:#333333;">ראינו שהתחיל אצלנו תהליך הזמנה ולא הושלם. אם זאת היתה תקלה טכנית או שינוי דעת ברגע האחרון, הכל בסדר. בלי לחץ.</p>
      <p style="margin:0; font-size:16px; line-height:1.75; color:#333333;">אם בא להמשיך מאיפה שעצרנו, הקישור למטה. הקלייה והמשלוח כרגיל, יום-יומיים מהקלייה ישר אליכם.</p>
    </td></tr>
    <tr><td style="padding:8px 40px 4px; text-align:right;">
      {{ cart_items_html }}
    </td></tr>
    <tr><td align="right" style="padding:12px 40px 20px; text-align:right;">
      <a href="https://www.minuto.co.il/cart/" style="display:inline-block; background:#3C4A2C; color:#FFFFFF; text-decoration:none; font-size:16px; font-weight:700; padding:14px 40px; border-radius:4px;">לחזרה לעגלה</a>
    </td></tr>
    <tr><td style="padding:8px 40px 8px; text-align:right;">
      <p style="margin:0 0 8px; font-size:16px; line-height:1.75; color:#333333;">קצת מידע שכדאי לדעת:</p>
      <ul style="margin:0; padding:0 20px 0 0; font-size:16px; line-height:1.75; color:#333333;">
        <li style="margin:0 0 8px;">הקלייה טרייה. הפולים שיוצאים אליכם נקלו באותו השבוע.</li>
        <li style="margin:0 0 8px;">משלוח רגיל מגיע תוך יום-יומיים מהקלייה.</li>
        <li style="margin:0 0 8px;">יש שאלה לפני שמזמינים? אפשר להשיב למייל הזה ואענה אישית.</li>
      </ul>
    </td></tr>
    <tr><td style="padding:8px 40px 36px; text-align:right; font-size:16px; line-height:1.75;">
      <p style="margin:28px 0 0; color:#333333;">שיהיה בכיף,<br>מינוטו קפה</p>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
    <tr><td align="center" style="padding:24px 32px 8px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:13px; line-height:1.8; color:#555555;">
      מינוטו קפה בע״מ · בית קלייה ספשלטי · אחד העם 22, רחובות<br>
      <a href="tel:+972544490486" style="color:#555555;">054-4490486</a> · <a href="mailto:info@minuto.co.il" style="color:#555555;">info@minuto.co.il</a> · <a href="https://www.minuto.co.il" style="color:#555555;">minuto.co.il</a> · <a href="https://www.instagram.com/minuto_coffee/" style="color:#555555;">Instagram</a>
    </td></tr>
    <tr><td align="center" style="padding:4px 32px 24px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:12px; line-height:1.8; color:#666666;">
      קיבלת את המייל הזה כי התחילה הזמנה באתר מינוטו ולא הושלמה. <a href="{{ unsubscribe_url }}" style="color:#666666;">להסרה מתזכורות עתידיות</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>$$
WHERE trigger_type = 'abandoned_cart_1'
  AND md5(body_html_template) = 'e04e321b523ee87bcecaa1a5e03a479f';

-- abandoned_cart_2
UPDATE email_automation_templates SET body_html_template = $$<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>תזכורת השלמת הזמנה, מינוטו</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0; padding:0; background:#F7F7F7; font-family:'Heebo', Arial, Helvetica, sans-serif; color:#333333;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F7F7F7;">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px; background:#FFFFFF;">
    <tr><td align="center" style="padding:28px 32px 22px; border-bottom:1px solid #E6E6E6;">
      <a href="https://www.minuto.co.il"><img src="{{ logo_url }}" alt="Minuto Café Roastery" width="132" style="display:block; width:132px; max-width:132px; height:auto; border:0;"></a>
    </td></tr>
    <tr><td style="padding:36px 40px 8px; text-align:right;">
      <h1 style="margin:0 0 20px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:26px; line-height:1.3; font-weight:700; color:#3C4A2C; text-align:right;">העגלה עדיין שמורה</h1>
      <p style="margin:0 0 16px; font-size:16px; line-height:1.75; color:#333333;">היי {{ first_name }},</p>
      <p style="margin:0 0 16px; font-size:16px; line-height:1.75; color:#333333;">לפני כמה ימים התחילה אצלנו הזמנה ועדיין לא הושלמה. רק להזכיר בעדינות שהיא שמורה.</p>
      <p style="margin:0; font-size:16px; line-height:1.75; color:#333333;">אם זאת היתה החלטה מודעת לוותר, לגמרי בסדר. אם זה היה ענייני זמן או תקלה, הקישור למטה ימשיך מאיפה שעצרנו.</p>
    </td></tr>
    <tr><td style="padding:8px 40px 4px; text-align:right;">
      {{ cart_items_html }}
    </td></tr>
    <tr><td align="right" style="padding:12px 40px 20px; text-align:right;">
      <a href="https://www.minuto.co.il/cart/" style="display:inline-block; background:#3C4A2C; color:#FFFFFF; text-decoration:none; font-size:16px; font-weight:700; padding:14px 40px; border-radius:4px;">לחזרה לעגלה</a>
    </td></tr>
    <tr><td style="padding:8px 40px 36px; text-align:right; font-size:16px; line-height:1.75;">
      <p style="margin:28px 0 0; color:#333333;">שיהיה בכיף,<br>מינוטו קפה</p>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
    <tr><td align="center" style="padding:24px 32px 8px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:13px; line-height:1.8; color:#555555;">
      מינוטו קפה בע״מ · בית קלייה ספשלטי · אחד העם 22, רחובות<br>
      <a href="tel:+972544490486" style="color:#555555;">054-4490486</a> · <a href="mailto:info@minuto.co.il" style="color:#555555;">info@minuto.co.il</a> · <a href="https://www.minuto.co.il" style="color:#555555;">minuto.co.il</a> · <a href="https://www.instagram.com/minuto_coffee/" style="color:#555555;">Instagram</a>
    </td></tr>
    <tr><td align="center" style="padding:4px 32px 24px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:12px; line-height:1.8; color:#666666;">
      קיבלת את המייל הזה כי התחילה הזמנה באתר מינוטו ולא הושלמה. זאת התזכורת האחרונה. <a href="{{ unsubscribe_url }}" style="color:#666666;">להסרה מתזכורות עתידיות</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>$$
WHERE trigger_type = 'abandoned_cart_2'
  AND md5(body_html_template) = '8727df3edd2cd76915c57b61798746cb';

-- first_purchase_invite
UPDATE email_automation_templates SET body_html_template = $$<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>10% הנחה על ההזמנה הבאה, מינוטו</title>
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0; padding:0; background:#F7F7F7; font-family:'Heebo', Arial, Helvetica, sans-serif; color:#333333;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F7F7F7;">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px; background:#FFFFFF;">
    <tr><td align="center" style="padding:28px 32px 22px; border-bottom:1px solid #E6E6E6;">
      <a href="https://www.minuto.co.il"><img src="{{ logo_url }}" alt="Minuto Café Roastery" width="132" style="display:block; width:132px; max-width:132px; height:auto; border:0;"></a>
    </td></tr>
    <tr><td style="padding:36px 40px 8px; text-align:right;">
      <h1 style="margin:0 0 20px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:26px; line-height:1.3; font-weight:700; color:#3C4A2C; text-align:right;">תודה על ההזמנה הראשונה</h1>
      <p style="margin:0 0 16px; font-size:16px; line-height:1.75; color:#333333;">היי {{ first_name }},</p>
      <p style="margin:0 0 16px; font-size:16px; line-height:1.75; color:#333333;">תודה שהזמנת ממינוטו. הפולים בדרך אליך, ואנחנו מקווים שיהיה לך טעים.</p>
      <p style="margin:0; font-size:16px; line-height:1.75; color:#333333;">רצינו לשתף איתך משהו: יש לנו רשימת דיוור שבה אנחנו שולחים פעם בכמה שבועות עדכונים על פולים חדשים מבית הקלייה, מאמרים על קפה ספשלטי וטיפים להכנת קפה ביתי. בלי ספאם, רק תוכן שיעניין אותך.</p>
    </td></tr>
    <tr><td style="padding:20px 40px 4px; text-align:right;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid #E6E6E6;">
        <tr><td style="padding:18px 0 0; text-align:right; font-family:'Heebo', Arial, Helvetica, sans-serif;">
          <p style="margin:0 0 4px; font-size:18px; line-height:1.5; font-weight:700; color:#3C4A2C;">הצטרפ/י עכשיו וקבל/י 10% הנחה על ההזמנה הבאה</p>
          <p style="margin:0; font-size:13px; line-height:1.6; color:#666666;">פולי קפה ספשלטי בלבד · שימוש חד-פעמי</p>
        </td></tr>
      </table>
    </td></tr>
    <tr><td align="right" style="padding:12px 40px 20px; text-align:right;">
      <a href="https://www.minuto.co.il/subscribe.html?email={{ email_encoded }}&src=invite_email" style="display:inline-block; background:#3C4A2C; color:#FFFFFF; text-decoration:none; font-size:16px; font-weight:700; padding:14px 40px; border-radius:4px;">להצטרפות לרשימת הדיוור</a>
    </td></tr>
    <tr><td style="padding:8px 40px 8px; text-align:right;">
      <p style="margin:0 0 8px; font-size:16px; line-height:1.75; color:#333333;">איך זה עובד:</p>
      <ol style="margin:0; padding:0 20px 0 0; font-size:16px; line-height:1.75; color:#333333;">
        <li style="margin:0 0 8px;">לוחצים על הכפתור למעלה ומשלימים פרטים בטופס ההצטרפות.</li>
        <li style="margin:0 0 8px;">מקבלים למייל קוד 10% הנחה על פולי קפה ספשלטי.</li>
        <li style="margin:0 0 8px;">משתמשים בקוד בעמוד התשלום בהזמנה הבאה.</li>
      </ol>
      <p style="margin:16px 0 0; font-size:16px; line-height:1.75; color:#333333;">לא רוצה להירשם? אין בעיה, לא נשלח עוד מיילים. ההזמנה הזו לא תחזור.</p>
    </td></tr>
    <tr><td style="padding:8px 40px 36px; text-align:right; font-size:16px; line-height:1.75;">
      <p style="margin:28px 0 0; color:#333333;">שיהיה בכיף,<br>מינוטו קפה</p>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
    <tr><td align="center" style="padding:24px 32px 8px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:13px; line-height:1.8; color:#555555;">
      מינוטו קפה בע״מ · בית קלייה ספשלטי · אחד העם 22, רחובות<br>
      <a href="tel:+972544490486" style="color:#555555;">054-4490486</a> · <a href="mailto:info@minuto.co.il" style="color:#555555;">info@minuto.co.il</a> · <a href="https://www.minuto.co.il" style="color:#555555;">minuto.co.il</a> · <a href="https://www.instagram.com/minuto_coffee/" style="color:#555555;">Instagram</a>
    </td></tr>
    <tr><td align="center" style="padding:4px 32px 24px; font-family:'Heebo', Arial, Helvetica, sans-serif; font-size:12px; line-height:1.8; color:#666666;">
      קיבלת את המייל הזה כי הזמנת ממינוטו לראשונה. זוהי הזמנה חד-פעמית להצטרפות לרשימת הדיוור, לא יישלחו אליך מיילים שיווקיים נוספים אלא אם תבחר/י להצטרף. <a href="{{ unsubscribe_url }}" style="color:#666666;">הסרה</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>$$
WHERE trigger_type = 'first_purchase_invite'
  AND md5(body_html_template) = 'cda4d4d7a353f2ce16545e55dbbf39a0';

DO $$
DECLARE stale text;
BEGIN
  SELECT string_agg(t.trigger_type, ', ') INTO stale
  FROM email_automation_templates t
  JOIN (VALUES
    ('first_purchase', 'a3c3129c81683aebe88f70bb735d5a28'),
    ('abandoned_cart_1', '91ed3a3098376580f53d9aae4d96ca7a'),
    ('abandoned_cart_2', '65decb55bcd2c980d55076dc45dac7ac'),
    ('first_purchase_invite', '9bfe44af7c8ecf10d4ffd167927d728f')
  ) AS v(trigger_type, new_md5) ON v.trigger_type = t.trigger_type
  WHERE md5(t.body_html_template) <> v.new_md5;
  IF stale IS NOT NULL THEN
    RAISE EXCEPTION 'templates edited since this migration was written, not overwritten: %', stale;
  END IF;
END $$;
