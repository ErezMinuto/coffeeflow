-- Reframe the first_purchase email body to explicitly connect the
-- coupon to mailing-list membership. Owner caught: "it doesnt say
-- anything about register to the mailing list in order to get 10%".
-- The previous body thanked them for ordering and offered 10%, but
-- never made the link clear:
--
--   you're getting this discount BECAUSE you joined our mailing list
--
-- This matters for two reasons:
--   1. Sets correct expectations — recipient understands their list
--      membership has tangible value, makes them less likely to
--      unsubscribe.
--   2. Reinforces the conversion play — anyone who SHARES this email
--      with a friend who hasn't signed up yet learns the offer is
--      "subscribe + first purchase = 10%". Word-of-mouth signup driver.
--
-- Two changes:
--   • Opening line acknowledges both purchase + list membership
--   • Coupon intro line frames the discount as a thank-you for joining
--
-- Idempotent UPDATE on the seeded row.

UPDATE email_automation_templates
SET
  body_html_template = REPLACE(
    REPLACE(
      body_html_template,
      'תודה שהזמנת ממינוטו. במינוטו אנחנו קולים פולים טריים בכל בוקר ברחובות, ובוחרים את הציוד שאנחנו מוכרים בקפידה כדי לשרת אותם.',
      'תודה שהזמנת ממינוטו, ותודה שהצטרפת לרשימת התפוצה שלנו. במינוטו אנחנו קולים פולים טריים בכל בוקר ברחובות, ובוחרים את הציוד שאנחנו מוכרים בקפידה כדי לשרת אותם.'
    ),
    'קופון הבא להזמנה הבאה שלך, על פולי קפה ספשלטי:',
    'כתודה על ההצטרפות לרשימת התפוצה — הכנו לך קופון 10% הנחה על פולי קפה ספשלטי, להזמנה הבאה:'
  ),
  updated_at = NOW()
WHERE trigger_type = 'first_purchase';
