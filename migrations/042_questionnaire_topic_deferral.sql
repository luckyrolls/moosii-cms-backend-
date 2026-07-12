-- ============================================================================
-- Migration 042: questionnaire topic-mention deferral config
-- ============================================================================
-- Two nullable, OPT-IN columns so a recurring check-in can be briefly DEFERRED after the
-- parent recently "mentioned" its topic — don't re-ask about sleep the same week they
-- brought it up. A "mention" = a track-proposing classify signal
-- (user_update_signals.matched_track_id, persisted only under apply). Both NULL = feature
-- OFF for that questionnaire (the default). No backfill.
--
--   defer_topic uuid    NULL REFERENCES tracks(id) — the track whose recent mention defers
--                       this questionnaire (the only curated vocabulary mentions are
--                       recorded against today).
--   defer_days  integer NULL CHECK (defer_days IS NULL OR defer_days > 0) — window length.
--
-- POLICY (NOT code-enforced): concern-shaped / clinical questionnaires must stay NULL
-- unless a clinician signs off — deferral can only HIDE an ask, and a safety check-in must
-- never be silently hidden. The CMS slice carries that warning; the DB does not enforce it
-- (same as milestone_id gating suppression by policy, not constraint).
--
-- FK on delete: default NO ACTION — a track can't be dropped while a questionnaire defers
-- on it, consistent with migration 040 ("a track deletes only when bare"; lessons.track_id
-- already blocks the same way).
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..042 reconciliation list.
-- ============================================================================

begin;

alter table public.questionnaire
  add column if not exists defer_topic uuid,
  add column if not exists defer_days  integer;

alter table public.questionnaire
  drop constraint if exists questionnaire_defer_topic_fkey;
alter table public.questionnaire
  add  constraint questionnaire_defer_topic_fkey
  foreign key (defer_topic) references public.tracks (id);

alter table public.questionnaire
  drop constraint if exists questionnaire_defer_days_positive;
alter table public.questionnaire
  add  constraint questionnaire_defer_days_positive
  check (defer_days is null or defer_days > 0);

commit;
