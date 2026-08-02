-- ============================================================================
-- ============================================================================
-- ██  ALREADY APPLIED — DO NOT RUN  ██
-- ============================================================================
-- ============================================================================
--
-- THIS FILE IS A REBUILD RECORD, NOT A RUNNABLE MIGRATION. DO NOT PASTE IT INTO
-- THE SUPABASE SQL EDITOR. DO NOT RUN IT AGAINST ANY LIVE DATABASE.
--
--   * It was applied MANUALLY via the Supabase SQL editor and never went through
--     any migration tool — so it is absent from supabase_migrations.schema_migrations
--     and was, until this file, absent from migrations/ entirely.
--   * Running it against the live DB will ERROR or DUPLICATE OBJECTS: it contains a
--     catalog WIPE (DELETE) plus CREATE TABLE / ADD COLUMN statements for objects
--     that ALREADY EXIST in production.
--   * It exists ONLY so migrations/ reflects the real schema history — the change
--     is live but had no repo record. This is the rebuild-walk record of it.
--
-- LOGICAL APPLY POSITION: AFTER 047, BEFORE 048. Migration 048 (the check-in routing
-- arm) READS the tables this change creates (questionnaire_answer_actions,
-- questionnaire_user_answers rebuilt against the atom tables), so in any fresh-DB
-- rebuild walk this must be applied before 048. Filed as 047a so filename sort order
-- == apply order without renumbering 048.
--
-- ============================================================================
-- FIDELITY NOTE — READ BEFORE TRUSTING ANY LINE BELOW
-- ============================================================================
-- The CONSTRAINTS, CHECKS, and VIEW BODIES here are all TRANSCRIBED from confirmed live
-- text: `qaa_payload_matches_type` + the questionnaire_answer_actions constraint list,
-- the `questionnaire_kind_valid` CHECK (§2), all six questionnaire_user_answers
-- constraints (§3), the two view bodies (§7), and the no-trigger finding (§5). What
-- remains RECONSTRUCTED is only the DDL STATEMENT FORM (whether prod used drop/recreate
-- vs alter-in-place; the exact wipe/cascade phrasing) and a few column-DEFAULT
-- expressions — the resulting live schema SHAPE is fully confirmed. Reconstructed lines
-- are marked `-- RECONSTRUCTED`; they are an honest best-effort at HOW it ran, not a byte
-- record. The §7 view gap and all three earlier FLAG-FOR-MARK items are now CLOSED.
-- ============================================================================


-- ============================================================================
-- §1. Wipe the questionnaire catalog
-- ============================================================================
-- RECONSTRUCTED. A full catalog delete preceded the schema change (the atom tables
-- were rebuilt from empty; this session's probes found the catalog empty). The exact
-- statement and the exact cascade are NOT captured — the delete relied on the live
-- ON DELETE FK behavior of everything referencing questionnaire (questionnaire_response,
-- questionnaire_questions → questionnaire_answers, completed_items, etc.). Whether it
-- was a single `DELETE FROM questionnaire` cascading, or an explicit child-first delete,
-- is unknown. Shown as the cascading form:
DELETE FROM questionnaire;   -- RECONSTRUCTED (cascade via live FKs; exact form uncaptured)


-- ============================================================================
-- §2. questionnaire.is_score_based → questionnaire.kind
-- ============================================================================
-- RECONSTRUCTED statements; the COLUMN OUTCOMES are confirmed from the live schema
-- (types show `kind` present, `is_score_based` absent) and from the change description
-- (NOT NULL, default 'diagnostic').
ALTER TABLE questionnaire DROP COLUMN is_score_based;                        -- RECONSTRUCTED (statement form; column removal confirmed live)
ALTER TABLE questionnaire ADD COLUMN kind text NOT NULL DEFAULT 'diagnostic'; -- RECONSTRUCTED (statement form; column confirmed live)
-- kind value constraint — TRANSCRIBED from live (confirmed structural; the two-value
-- vocabulary that migration 049's routing filter and generation both rely on):
ALTER TABLE questionnaire
  ADD CONSTRAINT questionnaire_kind_valid
  CHECK ((kind = ANY (ARRAY['diagnostic'::text, 'checkin'::text])));


-- ============================================================================
-- §3. Rebuild questionnaire_user_answers against the ATOM tables
-- ============================================================================
-- The change re-pointed this table's FKs at the atom tables (answer_id →
-- questionnaire_answers.id, question_id → questionnaire_questions.question_id). Column set
-- AND all six constraints are now CONFIRMED from live; only the STATEMENT FORM (shown as
-- DROP + CREATE — prod may have done ALTER-in-place) and the id/created_at default
-- EXPRESSIONS remain reconstructed.
DROP TABLE IF EXISTS questionnaire_user_answers;   -- RECONSTRUCTED (statement form uncaptured)
CREATE TABLE questionnaire_user_answers (          -- RECONSTRUCTED (statement form; shape below confirmed)
  id              uuid NOT NULL DEFAULT gen_random_uuid(),   -- default expr RECONSTRUCTED; PK below is confirmed
  user_id         uuid NOT NULL,
  questionnaire_id uuid NOT NULL,
  question_id     uuid NOT NULL,
  answer_id       uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),        -- default expr RECONSTRUCTED
  -- Constraints — ALL SIX confirmed from live (targets, ON DELETE actions, and the UNIQUE):
  CONSTRAINT questionnaire_user_answers_pkey PRIMARY KEY (id),
  CONSTRAINT questionnaire_user_answers_answer_id_fkey
    FOREIGN KEY (answer_id) REFERENCES questionnaire_answers (id) ON DELETE CASCADE,
  CONSTRAINT questionnaire_user_answers_question_id_fkey
    FOREIGN KEY (question_id) REFERENCES questionnaire_questions (question_id) ON DELETE CASCADE,
  CONSTRAINT questionnaire_user_answers_questionnaire_id_fkey
    FOREIGN KEY (questionnaire_id) REFERENCES questionnaire (id) ON DELETE CASCADE,
  CONSTRAINT questionnaire_user_answers_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES "user" (id) ON DELETE CASCADE,
  -- DELIBERATE — do NOT "fix" this by dropping created_at. Including created_at makes the
  -- key a near-no-op (two answers to the same question differ by microseconds, so BOTH
  -- insert), and that is exactly the point: a recurring check-in must ACCUMULATE answer
  -- history, and qua.created_at is the `action_at` the check-in routing arm orders by
  -- (DISTINCT ON ... action_at DESC = latest-answer-wins). Drop created_at from this key
  -- and recurring check-ins can no longer re-answer — recurrence breaks.
  UNIQUE (user_id, questionnaire_id, question_id, created_at)   -- columns confirmed; constraint NAME auto-generated (not captured)
);


-- ============================================================================
-- §4. questionnaire_questions.milestone_id
-- ============================================================================
-- RECONSTRUCTED statement; column presence confirmed from live types
-- (questionnaire_questions.milestone_id, nullable, FK → milestones). ON DELETE unknown.
ALTER TABLE questionnaire_questions ADD COLUMN milestone_id uuid;   -- RECONSTRUCTED
ALTER TABLE questionnaire_questions
  ADD CONSTRAINT questionnaire_questions_milestone_id_fkey
  FOREIGN KEY (milestone_id) REFERENCES milestones (id);           -- RECONSTRUCTED (ON DELETE unknown)


-- ============================================================================
-- §5. CREATE questionnaire_answer_actions
-- ============================================================================
-- The qaa_payload_matches_type CHECK below (and the enumerated constraint list) is
-- TRANSCRIBED VERBATIM from the confirmed live constraint text — do not reformat it.
-- The surrounding CREATE TABLE scaffolding (column order, the exact way each constraint
-- is spelled/inlined) is RECONSTRUCTED to produce those confirmed constraints; the
-- COLUMNS and CONSTRAINTS themselves are confirmed, the DDL phrasing is not a byte record.
CREATE TABLE questionnaire_answer_actions (
  -- Columns — full list confirmed: id, answer_id, action_type, track_id, tag_id,
  -- milestone_id, repeat_after_days, created_at, updated_at.
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),      -- confirmed (PK, default gen_random_uuid())
  answer_id         uuid NOT NULL,                                   -- confirmed (FK below)
  action_type       text NOT NULL,                                  -- confirmed (CHECK below)
  track_id          uuid,                                           -- confirmed (FK below)
  tag_id            uuid,                                           -- confirmed (FK below)
  milestone_id      uuid,                                           -- confirmed (FK below)
  repeat_after_days integer,                                        -- confirmed (CHECK below); RECONSTRUCTED type=integer
  created_at        timestamptz NOT NULL DEFAULT now(),             -- confirmed
  updated_at        timestamptz NOT NULL DEFAULT now(),             -- confirmed

  -- action_type vocabulary — confirmed live CHECK:
  CONSTRAINT questionnaire_answer_actions_action_type_check
    CHECK (action_type = ANY (ARRAY['add_track'::text, 'add_tag'::text, 'record_milestone'::text])),

  -- repeat_after_days — confirmed live CHECK (NULL allowed, else strictly positive):
  CONSTRAINT questionnaire_answer_actions_repeat_after_days_check
    CHECK (repeat_after_days IS NULL OR repeat_after_days > 0),

  -- ┌────────────────────────────────────────────────────────────────────────┐
  -- │ qaa_payload_matches_type — TRANSCRIBED VERBATIM. Do not re-derive.       │
  -- └────────────────────────────────────────────────────────────────────────┘
  CONSTRAINT qaa_payload_matches_type
    CHECK (((action_type = 'add_track'::text AND track_id IS NOT NULL
             AND tag_id IS NULL AND milestone_id IS NULL)
        OR  (action_type = 'add_tag'::text AND track_id IS NULL
             AND tag_id IS NOT NULL AND milestone_id IS NULL)
        OR  (action_type = 'record_milestone'::text AND track_id IS NULL
             AND tag_id IS NULL AND milestone_id IS NOT NULL))),

  -- Foreign keys — targets + ON DELETE actions all confirmed:
  CONSTRAINT questionnaire_answer_actions_answer_id_fkey
    FOREIGN KEY (answer_id) REFERENCES questionnaire_answers (id) ON DELETE CASCADE,
  CONSTRAINT questionnaire_answer_actions_milestone_id_fkey
    FOREIGN KEY (milestone_id) REFERENCES milestones (id) ON DELETE RESTRICT,
  CONSTRAINT questionnaire_answer_actions_tag_id_fkey
    FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE RESTRICT,
  CONSTRAINT questionnaire_answer_actions_track_id_fkey
    FOREIGN KEY (track_id) REFERENCES tracks (id) ON DELETE RESTRICT
);
-- CONFIRMED (positive finding, not an open question): questionnaire_answer_actions has
-- ZERO non-internal triggers. `updated_at` gets now() on INSERT and is NEVER updated — it
-- is effectively a created_at duplicate. This is the intended live state; do NOT add an
-- updated_at touch trigger "to fix" it — there is nothing to fix.


-- ============================================================================
-- §6. (record) questionnaire_answers / questionnaire_questions as ATOM tables
-- ============================================================================
-- NOT REBUILT HERE. questionnaire_answers and questionnaire_questions already existed;
-- this change RE-PURPOSED them as the atom tables that §3 and §5 reference. No DDL on
-- them is recorded beyond §4's milestone_id add. Noted so the file doesn't imply they
-- were created here.


-- ============================================================================
-- §7. Recreate questionnaire_with_track_name / questionnaire_user_score
-- ============================================================================
-- TRANSCRIBED VERBATIM from live (the §7 gap is now CLOSED). Both views were recreated as
-- part of this change (they read questionnaire columns that §2 altered).

CREATE OR REPLACE VIEW questionnaire_user_score AS
 SELECT qua.user_id,
    qua.questionnaire_id,
    sum(COALESCE(qa.score::integer, 0)) AS total_score,
    max(qua.created_at) AS calculated_at
   FROM questionnaire_user_answers qua
     JOIN questionnaire_answers qa ON qa.id = qua.answer_id
  GROUP BY qua.user_id, qua.questionnaire_id;
-- OBSERVATION (not a defect): questionnaire_user_score has NO `kind` filter, so it also
-- computes a total_score for CHECK-INS — summed from catalog answer scores that are
-- meaningless for a check-in (COALESCE folds absent/NULL scores to 0). This is consistent
-- with the completed_items score-sentinel that migration 050 addresses. Whether anything
-- READS this view for check-ins is an open grep, not settled here.

CREATE OR REPLACE VIEW questionnaire_with_track_name AS
 SELECT q.id,
    q.questionnaire_name,
    q.description,
    q.track_id,
    t.track_name,
    q.is_published,
    q.kind,
    q.priority,
    q.created_at
   FROM questionnaire q
     LEFT JOIN tracks t ON t.id = q.track_id;

-- ============================================================================
-- END REBUILD RECORD — DO NOT RUN.
-- ============================================================================
