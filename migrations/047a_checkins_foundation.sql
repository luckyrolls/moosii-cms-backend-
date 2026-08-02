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
-- Only ONE part of this file is TRANSCRIBED from the confirmed live constraint text:
-- the `qaa_payload_matches_type` CHECK and the enumerated constraint list on
-- questionnaire_answer_actions. EVERYTHING ELSE is RECONSTRUCTED from the resulting
-- live column shapes (src/types/database.types.ts) and the change description — the
-- exact DDL statements that ran were not captured. Every reconstructed section is
-- marked `-- RECONSTRUCTED`. Two view bodies could NOT be reconstructed at all and are
-- left as explicit gaps for Mark to fill from pg_get_viewdef (see §7). A reconstructed
-- line is an honest best-effort at WHAT ran, not a byte record of it.
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
ALTER TABLE questionnaire DROP COLUMN is_score_based;                        -- RECONSTRUCTED
ALTER TABLE questionnaire ADD COLUMN kind text NOT NULL DEFAULT 'diagnostic'; -- RECONSTRUCTED
-- UNCERTAIN / FLAG FOR MARK: whether a CHECK constrains kind to a fixed set
-- (e.g. ('diagnostic','checkin')) is NOT known — the live types expose `kind` only as
-- `text`. Routing uses kind='checkin'; generation writes 'diagnostic'. If a CHECK
-- exists in prod, it is NOT reflected here. Confirm via:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'questionnaire'::regclass AND contype = 'c';


-- ============================================================================
-- §3. Rebuild questionnaire_user_answers against the ATOM tables
-- ============================================================================
-- RECONSTRUCTED. The pre-rebuild shape is not captured; the change re-pointed this
-- table's FKs at the atom tables (answer_id → questionnaire_answers.id, question_id →
-- questionnaire_questions.question_id). Final column set is confirmed from the live
-- types: (id, user_id, questionnaire_id, question_id, answer_id, created_at). Shown as
-- DROP + CREATE; whether prod actually did ALTER-in-place vs drop/recreate is unknown.
DROP TABLE IF EXISTS questionnaire_user_answers;   -- RECONSTRUCTED (form uncaptured)
CREATE TABLE questionnaire_user_answers (          -- RECONSTRUCTED
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- RECONSTRUCTED (PK/default inferred)
  user_id         uuid NOT NULL,                                -- RECONSTRUCTED
  questionnaire_id uuid NOT NULL,                               -- RECONSTRUCTED
  question_id     uuid NOT NULL,                                -- RECONSTRUCTED
  answer_id       uuid NOT NULL,                                -- RECONSTRUCTED
  created_at      timestamptz NOT NULL DEFAULT now(),           -- RECONSTRUCTED
  -- The two ATOM-table FK re-points are the POINT of this rebuild (per the change
  -- description); the referenced columns are confirmed, the ON DELETE actions are NOT:
  CONSTRAINT questionnaire_user_answers_answer_id_fkey
    FOREIGN KEY (answer_id) REFERENCES questionnaire_answers (id),          -- RECONSTRUCTED (ON DELETE unknown)
  CONSTRAINT questionnaire_user_answers_question_id_fkey
    FOREIGN KEY (question_id) REFERENCES questionnaire_questions (question_id), -- RECONSTRUCTED (ON DELETE unknown)
  CONSTRAINT questionnaire_user_answers_questionnaire_id_fkey
    FOREIGN KEY (questionnaire_id) REFERENCES questionnaire (id),           -- RECONSTRUCTED (ON DELETE unknown)
  CONSTRAINT questionnaire_user_answers_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES "user" (id)                           -- RECONSTRUCTED (target table + ON DELETE unknown)
);
-- FLAG FOR MARK: the user_id FK target table name ("user" vs users vs auth.users) and
-- ALL ON DELETE actions above are reconstructed guesses. Settle from:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'questionnaire_user_answers'::regclass;


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
-- FLAG FOR MARK (minor): an updated_at auto-touch TRIGGER is common on this DB's tables
-- but is NOT captured here — the change description gave only the column default. If one
-- exists on questionnaire_answer_actions in prod, it is not recorded in this file.


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
-- GAP — NOT RECONSTRUCTED. Both views were recreated as part of this change (they
-- reference questionnaire columns that §2 altered, so they had to be dropped/recreated),
-- but their BODIES are not recoverable from the types or the change description. Do NOT
-- invent them. Their live definitions must be pulled from prod and pasted here to make
-- this record complete:
--   SELECT pg_get_viewdef('questionnaire_with_track_name'::regclass, true);
--   SELECT pg_get_viewdef('questionnaire_user_score'::regclass, true);
-- Until then this file is a FAITHFUL-BUT-INCOMPLETE record: §7 is a known hole.
-- (Leaving them absent is correct per the fidelity rule — a guessed view body would be
--  worse than an honest gap.)

-- ============================================================================
-- END REBUILD RECORD — DO NOT RUN.
-- ============================================================================
