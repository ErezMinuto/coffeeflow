-- Owner: "Remove ארז אלבז and leave only minuto". Email signoff was a
-- two-line block "שיהיה בכיף, / ארז אלבז / מינוטו קפה" — owner wants to
-- drop the personal name so the brand stands alone. This makes the
-- email consistent if/when other team members write replies and avoids
-- a personal-vs-brand mismatch.
--
-- Surgical REPLACE on the body_html_template, only touches the signoff.
-- Idempotent: re-runnable safely.

UPDATE email_automation_templates
SET
  body_html_template = REPLACE(
    body_html_template,
    'שיהיה בכיף,<br>ארז אלבז<br>מינוטו קפה',
    'שיהיה בכיף,<br>מינוטו קפה'
  ),
  updated_at = NOW()
WHERE trigger_type = 'first_purchase';
