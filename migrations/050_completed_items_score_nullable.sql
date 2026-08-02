-- ============================================================================
-- Migration 050: completed_items.score DROP NOT NULL (DRAFT)
-- ============================================================================
-- DRAFT — NOT applied by the agent. APPLY VIA THE SUPABASE SQL EDITOR after review;
-- on the 008..050 reconciliation list. Independent of 049/051 (any apply order).
--
-- WHY. `score` is a property of a DIAGNOSTIC questionnaire; a check-in has no score.
-- The app currently writes a hardcoded 0 to satisfy NOT NULL — a sentinel that is also
-- a matchable band value (0 can fall inside a [score_min_range, score_max_range]). NULL
-- is the honest value, and the recurrence engine already treats a NULL score as
-- one-shot / no-guessing (matchRecurringBand returns null → not-due; rebuildMlp.ts).
--
-- SCOPE. This migration ONLY PERMITS NULL. The app change to write NULL instead of 0 for
-- kind='checkin' completions is a SEPARATE APP-REPO slice, not carried here.
-- ============================================================================

BEGIN;

ALTER TABLE completed_items ALTER COLUMN score DROP NOT NULL;

COMMIT;
