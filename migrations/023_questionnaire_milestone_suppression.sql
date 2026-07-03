-- ============================================================================
-- Migration 023: questionnaire -> milestone mapping (slice 3 SUPPRESS)
-- ============================================================================
-- Adds the ONE canonical questionnaire<->milestone link. Its EXISTENCE is the
-- suppressibility permission (the structural safety rule, not a toggle):
--   * MAPPED (milestone_id NOT NULL): the questionnaire's answer is equivalent to
--     a recorded fact, so it is REDUNDANT for a user whose child already has that
--     milestone in child_milestones. Such a user's MLP excludes it at build time
--     (derived per-user, fresh each rebuild — NO suppression state table).
--   * UNMAPPED (milestone_id NULL): unsuppressible BY CONSTRUCTION. There is no
--     mapping row to consult, so no code path can suppress it. All clinical/safety
--     screens (e.g. "Postpartum Depression Screening") map to NOTHING — there is
--     no developmental milestone for depression — so they stay NULL and can never
--     be inference-suppressed. A mistaken mapping is caught at the mapping step by
--     review, not a silent runtime toggle, and could only ever suppress once the
--     mapped fact exists (a category error for a clinical screen).
--
-- One link, two directions: a FUTURE answer-level `record_milestone` writer (on
-- questionnaire completion, source='questionnaire') READS this same column rather
-- than adding a parallel questionnaire<->milestone linkage. Do NOT create a second
-- mapping. That write path is DEFERRED (it is answer-dependent and safety-sensitive
-- — a "no, not yet" answer must not record the milestone); this slice is READ-only
-- suppression over facts classify already writes.
--
-- No new table -> no RLS sweep entry. database.types.ts needs regen after apply
-- (adds questionnaire.milestone_id); rebuildMlp uses the untyped bridge meanwhile.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..023 reconciliation list.
-- ============================================================================

BEGIN;

ALTER TABLE questionnaire
  ADD COLUMN IF NOT EXISTS milestone_id uuid REFERENCES milestones(id);

COMMENT ON COLUMN questionnaire.milestone_id IS
  'Canonical questionnaire->milestone link (slice 3). Non-null = suppressible: '
  'redundant once the child has this milestone fact (excluded from the MLP at '
  'build time). Null = unsuppressible by construction (clinical/safety screens). '
  'A future answer-level record_milestone writer reads this same column.';

COMMIT;
