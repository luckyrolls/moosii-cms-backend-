-- ============================================================================
-- Migration 051: at most one record_milestone action per answer (DRAFT)
-- ============================================================================
-- DRAFT — NOT applied by the agent. APPLY VIA THE SUPABASE SQL EDITOR after review;
-- on the 008..051 reconciliation list. Independent of 049/050 (any apply order).
--
-- WHY. A table-wide UNIQUE(answer_id, action_type) would wrongly forbid one answer
-- granting two tracks (add_track ×2) or two tags (add_tag ×2) — both legitimate. But one
-- answer asserting two DIFFERENT milestones is incoherent (a milestone fact is monotonic
-- and singular per answer). A PARTIAL unique index scoped to record_milestone enforces
-- "≤1 milestone assertion per answer" without touching add_track / add_tag fan-out.
--
-- EXISTING ROWS. Expected to violate: ZERO. No record_milestone writer exists yet (the
-- action is authorable but inert), so no such rows are produced today.
-- ============================================================================

BEGIN;

CREATE UNIQUE INDEX qaa_one_milestone_per_answer
  ON questionnaire_answer_actions (answer_id)
  WHERE action_type = 'record_milestone';

COMMIT;
