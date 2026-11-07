-- =============================================================================
-- Contact groups: reusable named subsets of marketing_contacts for test sends
-- and audience segmentation.
--
-- Two tables:
--   contact_groups           — a named group, optionally flagged as the default
--                              test group(s) for pre-flight sends
--   contact_group_members    — email membership. We store email (not FK to
--                              marketing_contacts.id) so groups can include
--                              addresses that aren't in the contacts table yet
--                              (e.g. a coworker's personal Gmail for testing).
--
-- Policies follow the existing shared-table pattern: universal access through
-- the anon key for any logged-in session. Per-user admin restriction can be
-- layered on later if needed.
-- =============================================================================

CREATE TABLE IF NOT EXISTS contact_groups (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT      NOT NULL,
  description    TEXT,
  is_test_group  BOOLEAN   NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_groups_is_test_group_idx
  ON contact_groups (is_test_group)
  WHERE is_test_group = true;

CREATE TABLE IF NOT EXISTS contact_group_members (
  id           BIGSERIAL PRIMARY KEY,
  group_id     BIGINT NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  email        TEXT   NOT NULL,
  name         TEXT,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, email)
);

CREATE INDEX IF NOT EXISTS contact_group_members_group_id_idx
  ON contact_group_members (group_id);

ALTER TABLE contact_groups         ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_group_members  ENABLE ROW LEVEL SECURITY;

-- Shared policies — same pattern as marketing_contacts, campaigns, etc.
DO $$ DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['contact_groups', 'contact_group_members']) LOOP
    EXECUTE format('
      DROP POLICY IF EXISTS "shared_select" ON %I;
      DROP POLICY IF EXISTS "shared_insert" ON %I;
      DROP POLICY IF EXISTS "shared_update" ON %I;
      DROP POLICY IF EXISTS "shared_delete" ON %I;

      CREATE POLICY "shared_select" ON %I
        FOR SELECT TO anon, authenticated USING (true);

      CREATE POLICY "shared_insert" ON %I
        FOR INSERT TO anon, authenticated WITH CHECK (true);

      CREATE POLICY "shared_update" ON %I
        FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

      CREATE POLICY "shared_delete" ON %I
        FOR DELETE TO anon, authenticated USING (true);
    ', t, t, t, t, t, t, t, t);
  END LOOP;
END $$;

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_groups         TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_group_members  TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE contact_groups_id_seq          TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE contact_group_members_id_seq   TO anon, authenticated;
