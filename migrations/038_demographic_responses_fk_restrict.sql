-- ============================================================================
-- Migration 038: user_demographic_responses FKs -> ON DELETE RESTRICT
-- ============================================================================
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..038 reconciliation list.
--
-- WHY. demographic_questions / demographic_answers are a LIVE activation source. A
-- user's stored responses (user_demographic_responses) join demographic_track_rules to
-- resolve which tracks that user gets (the user_active_tracks machinery, gated on
-- question.is_active AND answer.is_active). The CMS demographic editor currently offers
-- HARD DELETE of questions/answers; with the responses FKs at ON DELETE CASCADE, deleting
-- a question/answer that still has responses SILENTLY destroys historical user response
-- data AND retroactively rewrites those users' past track activation. The intended
-- lifecycle for retiring a question/answer is DEACTIVATION (is_active=false), which drops
-- it from onboarding + activation while preserving history.
--
-- FIX. Swap the two user_demographic_responses -> demographic FKs to ON DELETE RESTRICT
-- so the database BLOCKS deleting any question/answer that still has responses. Rules
-- (demographic_track_rules) are intentionally untouched — nothing references a rule and
-- it carries no is_active, so add/remove of rule rows stays the correct CRUD.
--
-- CONSUMER IMPACT. The CMS delete flow (which today shows a cascade-count warning and
-- relies on the cascade) will now get a 23503 foreign_key_violation when a question/answer
-- has responses. The frontend should catch that and steer the user to DEACTIVATE instead.
-- No data is migrated; only future delete behavior changes.
--
-- Constraint NAMES are preserved so database.types.ts `foreignKeyName` values stay stable.
-- Idempotent: drop-if-exists + re-add makes a re-run safe.
-- ============================================================================

begin;

-- answer_id -> demographic_answers(id)
alter table public.user_demographic_responses
  drop constraint if exists user_demographic_responses_answer_id_fkey;
alter table public.user_demographic_responses
  add  constraint user_demographic_responses_answer_id_fkey
  foreign key (answer_id) references public.demographic_answers (id)
  on update no action on delete restrict;

-- question_id -> demographic_questions(id)
alter table public.user_demographic_responses
  drop constraint if exists user_demographic_responses_question_id_fkey;
alter table public.user_demographic_responses
  add  constraint user_demographic_responses_question_id_fkey
  foreign key (question_id) references public.demographic_questions (id)
  on update no action on delete restrict;

commit;
