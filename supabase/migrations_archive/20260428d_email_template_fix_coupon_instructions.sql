-- Owner-caught copy bug: the welcome email said the coupon would
-- "automatically apply" when the customer returns. WooCommerce doesn't
-- auto-apply coupons — the customer has to manually enter the code at
-- checkout. The email's promise didn't match reality.
--
-- Surgical replace: only the misleading paragraph changes; rest of the
-- body stays as set by 20260428b (generic copy) + 20260428c (gender-
-- inclusive wording).
--
-- Future: Option B from the conversation — implement actual auto-apply
-- via WordPress URL handler (?apply_coupon=XXX) and a clickable button
-- in the email. Requires PHP work in the WC theme and is queued for the
-- dev team.

UPDATE email_automation_templates
SET
  body_html_template = REPLACE(
    body_html_template,
    'הקופון מקושר לכתובת המייל הזו, אז אין צורך לזכור אותו. ההנחה תוחל אוטומטית בהזמנה הבאה של פולים.',
    'כדי להפעיל את ההנחה: להזין את הקוד בעמוד התשלום בהזמנת פולים הבאה. הקוד תקף רק עם כתובת המייל הזו.'
  ),
  updated_at = NOW()
WHERE trigger_type = 'first_purchase';
