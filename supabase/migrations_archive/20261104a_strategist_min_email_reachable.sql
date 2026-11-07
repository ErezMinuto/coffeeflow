-- Strategist: minimum email audience.
--
-- conclude_brief refuses an email_campaign recommendation whose target segment
-- has fewer opted-in (reachable) customers than this (_shared/segment_facts.ts).
-- The code defaults to 200 when the key is missing, so this only makes the
-- threshold visible and editable in ops_profile.
--
-- Additive + idempotent: adds the key only if it is not already set, never
-- touches the other switches.

UPDATE public.ops_profile
SET value = value || '{"min_email_reachable": 200}'::jsonb
WHERE key = 'strategist_loop'
  AND NOT (value ? 'min_email_reachable');
