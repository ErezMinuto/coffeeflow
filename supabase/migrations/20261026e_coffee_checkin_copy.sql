-- coffee_checkin copy: "יצא לך טעים?" reads as slang in a customer email.
-- Owner chose the replacement on 2026-10-26. Text-only change to the template
-- body; the template stays as it is (disabled). Idempotent.

UPDATE email_automation_templates
SET body_html_template = replace(
      body_html_template,
      'יצא לך טעים? משהו לא הסתדר בטחינה או בחליטה?',
      'הטעם מדויק? או שמשהו עוד לא מסתדר בטחינה או בחליטה?')
WHERE trigger_type = 'coffee_checkin'
  AND body_html_template LIKE '%יצא לך טעים?%';
