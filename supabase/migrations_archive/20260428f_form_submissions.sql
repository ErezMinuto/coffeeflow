-- Forms migration (Flashy → Resend/CoffeeFlow): need a place to log every
-- form submission for audit + customer-service follow-up. Newsletter +
-- callback signups also write to marketing_contacts (the existing list),
-- but the contact form doesn't (its consent is for "making contact" only,
-- not marketing). All three need a single audit log.
--
-- Why a separate table from marketing_contacts:
--   • marketing_contacts is keyed on email + has opt-in semantics
--     (already used by generate-campaign and rfm-sync for bulk sends)
--   • form_submissions is the raw audit log — every submission, every
--     field, even if the email later unsubscribes from marketing
--   • the message field is a free-text customer service inquiry, not
--     suitable for a contacts table
--
-- Stays compact: only the fields the three forms actually collect.

CREATE TABLE IF NOT EXISTS form_submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_type       TEXT NOT NULL,                   -- 'newsletter' | 'contact' | 'callback'
  email           TEXT NOT NULL,
  name            TEXT,
  phone           TEXT,
  message         TEXT,                            -- contact + callback only
  consent_given   BOOLEAN NOT NULL DEFAULT false,
  ip_address      TEXT,                            -- best-effort, for spam triage
  user_agent      TEXT,                            -- best-effort
  status          TEXT NOT NULL DEFAULT 'received', -- 'received' | 'processed' | 'failed'
  forward_sent    BOOLEAN NOT NULL DEFAULT false,  -- for contact/callback: was the message forwarded to info@?
  ack_sent        BOOLEAN NOT NULL DEFAULT false,  -- was the customer acknowledgment sent?
  added_to_list   BOOLEAN NOT NULL DEFAULT false,  -- was the email added to marketing_contacts?
  error_msg       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for "show me this customer's submissions" lookups in the dashboard
CREATE INDEX IF NOT EXISTS idx_form_submissions_email
  ON form_submissions (LOWER(TRIM(email)), created_at DESC);

-- Index for "show all recent submissions" in the dashboard inbox view
CREATE INDEX IF NOT EXISTS idx_form_submissions_recent
  ON form_submissions (form_type, created_at DESC);

-- RLS — same pattern as the other internal tables (allow all for anon
-- and authenticated, this is a single-tenant admin app behind Clerk).
ALTER TABLE form_submissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow all" ON form_submissions;
CREATE POLICY "allow all" ON form_submissions
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

COMMENT ON TABLE form_submissions IS
  'Audit log of every form submission from minuto.co.il. Newsletter and callback forms also write to marketing_contacts; contact form does not (its consent is contact-only). The form_type column distinguishes flows.';
