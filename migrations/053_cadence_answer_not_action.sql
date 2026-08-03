-- ============================================================================
-- Migration 053: check-in cadence moves from the ACTION to the ANSWER (APPLIED)
-- ============================================================================
-- APPLIED via the Supabase SQL editor (2026-08-03), ahead of being filed — this file is
-- the reconciliation record. On the 008..053 reconciliation list. IDEMPOTENT: ADD COLUMN
-- IF NOT EXISTS / DROP CONSTRAINT IF EXISTS then ADD / DROP COLUMN IF EXISTS, so a re-run
-- is a safe no-op (live already matches the end state — verified by column probe:
-- questionnaire_answers.repeat_after_days EXISTS, questionnaire_answer_actions.repeat_after_days ABSENT).
--
-- WHY. Different check-in answers want different repeat intervals (gradation is wanted),
-- so cadence stays PER-ANSWER. But repeat_after_days lived on questionnaire_answer_actions,
-- where action_type is NOT NULL over three values (add_track/add_tag/record_milestone) — so
-- a "Not yet" answer with NO consequence could carry no action row and therefore no
-- interval, which is exactly the answer that most needs a cadence. Resolution:
--   an ANSWER carries CADENCE (repeat_after_days on questionnaire_answers);
--   an ACTION carries CONSEQUENCE (questionnaire_answer_actions, no cadence).
--
-- NO DATA MIGRATION. Nothing read questionnaire_answer_actions.repeat_after_days (the
-- recurrence engine reads questionnaire_response bands, not the action row), and the
-- column is already absent live — the DROP is a no-op. No values to carry over.
--
-- SCOPE. Schema move only. Teaching the rebuild to READ questionnaire_answers.repeat_after_days
-- for per-answer check-in recurrence is the still-unbuilt check-in recurrence slice — not here.
-- ============================================================================

BEGIN;

-- Cadence lands on the ANSWER.
ALTER TABLE questionnaire_answers ADD COLUMN IF NOT EXISTS repeat_after_days integer;

-- CHECK transcribed verbatim from the confirmed live definition:
ALTER TABLE questionnaire_answers DROP CONSTRAINT IF EXISTS qa_repeat_positive;
ALTER TABLE questionnaire_answers ADD CONSTRAINT qa_repeat_positive
  CHECK (repeat_after_days IS NULL OR repeat_after_days > 0);

-- Cadence leaves the ACTION.
ALTER TABLE questionnaire_answer_actions DROP COLUMN IF EXISTS repeat_after_days;

COMMIT;
