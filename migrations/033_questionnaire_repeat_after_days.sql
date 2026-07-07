-- ============================================================================
-- Migration 033: questionnaire_response.repeat_after_days — score-band recurrence
-- ============================================================================
-- Today a questionnaire is one-shot: once a user has a completed_items row for it,
-- the MLP rebuild excludes it forever (rebuildMlp.ts → generateFullMLP "already
-- completed" filter). Recurrence makes that exclusion a "not yet DUE" check instead
-- of "answered at all".
--
-- The interval is PER SCORE-BAND. questionnaire_response already holds the score
-- bands (score_min_range..score_max_range) that route tracks/tags; this adds the
-- recurrence interval to the same band. The band that MATCHED the user's latest
-- answer score determines when the questionnaire is due again:
--   repeat_after_days = N  → due again N days after that answer's created_at
--   repeat_after_days NULL → this band does NOT recur (one-shot; today's behavior)
--
-- The rebuild reads the LATEST completed_items row per (user, questionnaire), finds
-- the band(s) its score falls in with a non-null interval (shortest wins), and
-- re-includes the questionnaire once now() - created_at >= interval. A band is
-- matched purely on score range + a non-null interval — INDEPENDENT of `add`, so a
-- band may exist solely to define cadence without routing anything.
--
-- Nullable, NO backfill: every existing row stays NULL, so all current
-- questionnaires remain one-shot and the MLP is byte-identical until an interval is
-- set. The CHECK forbids <= 0 (0 would make the questionnaire perpetually due,
-- re-surfacing on every rebuild); NULL stays allowed.
--
-- Flag: regenerate database.types.ts after apply (adds
-- questionnaire_response.repeat_after_days). The rebuild reads it via the existing
-- `supabase as any` bridge, so tsc is green without the regen; the regen is a confirm.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..033 reconciliation list.
-- ============================================================================

BEGIN;

ALTER TABLE questionnaire_response
  ADD COLUMN IF NOT EXISTS repeat_after_days integer;

ALTER TABLE questionnaire_response
  DROP CONSTRAINT IF EXISTS questionnaire_response_repeat_after_days_positive;
ALTER TABLE questionnaire_response
  ADD CONSTRAINT questionnaire_response_repeat_after_days_positive
  CHECK (repeat_after_days IS NULL OR repeat_after_days > 0);

COMMENT ON COLUMN questionnaire_response.repeat_after_days IS
  'Score-band recurrence interval (days). The band whose [score_min_range, '
  'score_max_range] matched the user''s latest answer sets when the questionnaire '
  'is due again: due once now() - latest completed_items.created_at >= this many '
  'days. NULL = this band does not recur (one-shot). Matched on score range + '
  'non-null interval, independent of `add`. Must be > 0. Migration 033.';

COMMIT;
