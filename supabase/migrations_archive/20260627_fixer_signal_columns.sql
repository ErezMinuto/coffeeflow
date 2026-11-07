-- Minuto Fixer Agent — strategist_signals columns for the PR-gated fixer.
--
-- The strategist brain emits bug_report rows into strategist_signals and stops
-- (it REPORTS, never self-fixes prod). The fixer agent closes that gap: it claims
-- an *approved* bug_report, writes a code fix on a branch, and opens a GitHub PR —
-- never deploying. It runs in GitHub Actions (needs git/gh/fs), not an edge fn.
--
-- This migration is ADDITIVE and applied to prod MANUALLY via the SQL editor
-- (`supabase db push` is UNSAFE here — untracked remote history). It adds the two
-- columns the fixer writes back and extends the status lifecycle with one terminal
-- state for the "this isn't a code bug I can fix" case.
--
-- Lifecycle (existing values unchanged; only 'needs_human' is new):
--   open ──approve(dashboard)──▶ approved ──fixer claims──▶ building
--   building ──PR opened──▶ shipped (+pr_url)
--   building ──agent bailed / not code-fixable──▶ needs_human (+fixer_note)

ALTER TABLE strategist_signals ADD COLUMN IF NOT EXISTS pr_url     TEXT;
ALTER TABLE strategist_signals ADD COLUMN IF NOT EXISTS fixer_note TEXT;

-- Extend the status CHECK with 'needs_human'. The constraint name follows the
-- Postgres default (<table>_<column>_check); drop-and-readd is the only way to
-- widen an enum-style CHECK. Re-add with the FULL set so this is idempotent-safe
-- to read.
ALTER TABLE strategist_signals DROP CONSTRAINT IF EXISTS strategist_signals_status_check;
ALTER TABLE strategist_signals ADD  CONSTRAINT strategist_signals_status_check
  CHECK (status IN ('open', 'approved', 'building', 'shipped', 'declined', 'needs_human'));

-- PostgREST caches the schema; reload so the new columns/values are queryable.
NOTIFY pgrst, 'reload schema';
