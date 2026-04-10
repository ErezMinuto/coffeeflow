-- =============================================================================
-- Add UNIQUE constraint on marketing_contacts.email
--
-- The original 20260330_marketing_tables.sql created a UNIQUE (user_id, email)
-- constraint, but at some point it was dropped in production (reason lost to
-- history). With no unique constraint matching the sync's onConflict target,
-- every Resend sync silently failed: `ON CONFLICT (user_id, email)` raises
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" and the whole upsert aborts with synced=0. Contacts added in
-- Resend (like erez@minuto.co.il) never appeared locally, and duplicates crept
-- in whenever different user_id values were passed because nothing enforced
-- uniqueness.
--
-- Per CLAUDE.md marketing_contacts is an org-wide shared table, so email is
-- the correct uniqueness key — not (user_id, email). The edge function's
-- sync-resend-contacts action has been updated to use onConflict: "email".
--
-- This migration was applied directly to production via the management API
-- before being checked in, so it's wrapped in IF NOT EXISTS to be idempotent.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.marketing_contacts'::regclass
      AND conname  = 'marketing_contacts_email_key'
  ) THEN
    ALTER TABLE marketing_contacts
      ADD CONSTRAINT marketing_contacts_email_key UNIQUE (email);
  END IF;
END $$;
