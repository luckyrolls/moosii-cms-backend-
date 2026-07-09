-- ============================================================================
-- Migration 008: demographic config tables — BACKFILLED RECORD (reconstructed)
-- ============================================================================
-- WHAT THIS IS. A faithful, RECONSTRUCTED record of four pre-existing tables that
-- predate this backend (created in the app's original/BuildShip era; there was never a
-- migration file for them). Reconstructed 2026-07-09 from live `information_schema` +
-- `pg_indexes` introspection (columns, defaults, constraints, FK delete rules, indexes
-- all captured from the running DB), so it matches the live schema exactly — it is NOT
-- hand-guessed.
--
-- WHY 008. It fills the gap at the head of the 008..038 reconciliation list
-- (`migrations/README.md`). It backfills the record only; 009 remains an open gap.
--
-- HOW TO USE.
--   * Live DB: these tables ALREADY EXIST, so every statement here is a no-op
--     (IF NOT EXISTS / inline named constraints). You do NOT need to run this against
--     the current database.
--   * Fresh rebuild: replay the reconciliation list IN ORDER. This creates the tables
--     in their ORIGINAL state — note the FKs below are ON DELETE CASCADE. Migration 038
--     later flips the two user_demographic_responses FKs to ON DELETE RESTRICT, so the
--     final state emerges from 008 THEN 038. (008 = "before", 038 = the change; no
--     contradiction when replayed in sequence.)
--
-- DEPENDS ON: public.tracks and public."user" already existing (both predate these).
--
-- SEMANTICS worth knowing (see docs/api-contract.md §5):
--   * demographic config is a LIVE activation source with retroactive semantics.
--   * user_demographic_responses UNIQUE (user_id, question_id) => at most one response
--     per user per question, i.e. single-select is enforced at the response level even
--     though no question-type column exists.
--   * demographic_track_rules UNIQUE (answer_id, track_id) => no duplicate answer->track
--     mappings.
-- ============================================================================

begin;

-- 1. demographic_questions ---------------------------------------------------
create table if not exists public.demographic_questions (
  id           uuid        not null default gen_random_uuid(),
  question_key text        not null,
  prompt_text  text        not null,
  sort_order   integer     not null default 0,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz,
  help_text    text,
  constraint demographic_questions_pkey primary key (id),
  constraint demographic_questions_question_key_key unique (question_key)
);

-- 2. demographic_answers -----------------------------------------------------
create table if not exists public.demographic_answers (
  id           uuid        not null default gen_random_uuid(),
  question_id  uuid        not null,
  answer_key   text,
  display_text text        not null,
  sort_order   integer     not null default 0,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz,
  constraint demographic_answers_pkey primary key (id),
  constraint demographic_answers_question_id_fkey
    foreign key (question_id) references public.demographic_questions (id)
    on update no action on delete cascade
);

-- 3. demographic_track_rules -------------------------------------------------
create table if not exists public.demographic_track_rules (
  id         uuid        not null default gen_random_uuid(),
  answer_id  uuid        not null,
  track_id   uuid        not null,
  created_at timestamptz not null default now(),
  constraint demographic_track_rules_pkey primary key (id),
  constraint demographic_track_rules_answer_id_track_id_key unique (answer_id, track_id),
  constraint demographic_track_rules_answer_id_fkey
    foreign key (answer_id) references public.demographic_answers (id)
    on update no action on delete cascade,
  constraint demographic_track_rules_track_id_fkey
    foreign key (track_id) references public.tracks (id)
    on update no action on delete cascade
);

-- 4. user_demographic_responses ---------------------------------------------
create table if not exists public.user_demographic_responses (
  id          uuid        not null default gen_random_uuid(),
  user_id     uuid        not null,
  question_id uuid        not null,
  answer_id   uuid        not null,
  answered_at timestamptz not null default now(),
  constraint user_demographic_responses_pkey primary key (id),
  constraint user_demographic_responses_user_id_question_id_key unique (user_id, question_id),
  constraint user_demographic_responses_answer_id_fkey
    foreign key (answer_id) references public.demographic_answers (id)
    on update no action on delete cascade,
  constraint user_demographic_responses_question_id_fkey
    foreign key (question_id) references public.demographic_questions (id)
    on update no action on delete cascade,
  constraint user_demographic_responses_user_id_fkey
    foreign key (user_id) references public."user" (id)
    on update no action on delete cascade
);

-- 5. Secondary indexes (the ones NOT backed by a PK/UNIQUE constraint above) -
-- Partial unique: answer keys unique within a question, nulls exempt.
create unique index if not exists demographic_answers_question_answer_key_uq
  on public.demographic_answers using btree (question_id, answer_key)
  where (answer_key is not null);
create index if not exists demographic_answers_question_id_idx
  on public.demographic_answers using btree (question_id);
create index if not exists demographic_track_rules_track_id_idx
  on public.demographic_track_rules using btree (track_id);
create index if not exists user_demographic_responses_answer_id_idx
  on public.user_demographic_responses using btree (answer_id);
create index if not exists idx_user_demographic_responses_user_id
  on public.user_demographic_responses using btree (user_id);

commit;
