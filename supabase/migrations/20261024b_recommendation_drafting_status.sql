-- =============================================================================
-- strategic_recommendations: add the 'drafting' status.
--
-- strategist-executor now claims a recommendation by moving it approved →
-- drafting (instead of only locking an 'approved' row). Only 'approved' rows are
-- ever claimed, so a recommendation whose 'drafted' update failed can no longer
-- be drafted a second time after its lock expires. A row stuck in 'drafting'
-- past its lock is swept to 'failed' by the executor with a note that a draft
-- may already exist.
--
-- Must be applied BEFORE the strategist-executor deploy that writes 'drafting'.
-- Idempotent and additive (widens the CHECK only).
-- =============================================================================

ALTER TABLE strategic_recommendations
  DROP CONSTRAINT IF EXISTS strategic_recommendations_status_check;
ALTER TABLE strategic_recommendations
  ADD CONSTRAINT strategic_recommendations_status_check
  CHECK (status IN ('proposed', 'approved', 'drafting', 'drafted', 'dismissed', 'failed'));
