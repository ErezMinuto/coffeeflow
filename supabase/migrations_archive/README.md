# Archived migrations (2026-03-30 → 2026-11-05)

These 172 files are history, not the schema. They were replaced on 2026-11-07 by
`supabase/migrations/00000000000000_baseline.sql`, a dump of prod itself.

Why they stopped being the source of truth:

- Most were applied by hand or one at a time through `apply-migration.yml`, so
  prod's `supabase_migrations.schema_migrations` knew only 11 of them.
- Core objects (`employees`, `user_roles`, `is_admin`, `get_role_for_user`) were
  created in prod and never committed, so replaying these files onto an empty
  database fails.

Keep them for `git log`/blame context: why a column exists, when a policy
changed. Do not apply them anywhere, and do not add new files here.

New schema changes go in `supabase/migrations/` as usual, after the baseline.
