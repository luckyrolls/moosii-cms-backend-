-- ============================================================================
-- Migration 040: RESTRICT the silent-cascade track FKs
-- ============================================================================
-- INTENT: a track deletes only when BARE — no lessons, no hosted questionnaires, no
-- rules, no mappings.
--
-- Track deletion was inconsistently guarded. lessons.track_id already BLOCKS (NO ACTION
-- default), but four other track FKs let a delete through SILENTLY and destructively:
--   * questionnaire.track_id            ON DELETE CASCADE   → hosted questionnaires die
--                                         with their bands + response history
--   * demographic_track_rules.track_id  ON DELETE CASCADE   → demographic routing rules vanish
--   * track_tag_map.track_id            ON DELETE CASCADE   → tag mappings vanish
--   * questionnaire_response.track_id   ON DELETE SET NULL  → targeting rules become
--                                         null-target husks
--
-- FIX: flip all four to ON DELETE RESTRICT (same pattern as migration 038). A track can
-- no longer be deleted while anything still references it — clear its lessons,
-- questionnaires, rules, and mappings first. ON UPDATE is PRESERVED per-FK exactly as
-- found in the live dump (CASCADE on questionnaire + track_tag_map; NO ACTION on the
-- other two). Constraint NAMES preserved so database.types.ts foreignKeyName values stay
-- stable. Idempotent (drop-if-exists + re-add); transaction-wrapped.
--
-- LEFT ALONE (intentional): the per-user state FKs on track_id (e.g. user_track,
-- user_mlp_mods) keep ON DELETE CASCADE — per-user state of a deleted track SHOULD go.
--
-- FLAGGED, NOT TOUCHED HERE: `user_track_actions_MM_unsed` (name as-is in the live FK
-- dump — looks like a leftover/misnamed object) is noted for a FUTURE cleanup migration;
-- this migration does not alter it.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..040 reconciliation list.
-- ============================================================================

begin;

-- questionnaire.track_id: ON DELETE CASCADE → RESTRICT; preserve ON UPDATE CASCADE
alter table public.questionnaire
  drop constraint if exists questionnaire_track_id_fkey;
alter table public.questionnaire
  add  constraint questionnaire_track_id_fkey
  foreign key (track_id) references public.tracks (id)
  on update cascade on delete restrict;

-- demographic_track_rules.track_id: ON DELETE CASCADE → RESTRICT; ON UPDATE NO ACTION
alter table public.demographic_track_rules
  drop constraint if exists demographic_track_rules_track_id_fkey;
alter table public.demographic_track_rules
  add  constraint demographic_track_rules_track_id_fkey
  foreign key (track_id) references public.tracks (id)
  on update no action on delete restrict;

-- track_tag_map.track_id: ON DELETE CASCADE → RESTRICT; preserve ON UPDATE CASCADE
alter table public.track_tag_map
  drop constraint if exists track_tag_map_track_id_fkey;
alter table public.track_tag_map
  add  constraint track_tag_map_track_id_fkey
  foreign key (track_id) references public.tracks (id)
  on update cascade on delete restrict;

-- questionnaire_response.track_id: ON DELETE SET NULL → RESTRICT; ON UPDATE NO ACTION
alter table public.questionnaire_response
  drop constraint if exists questionnaire_response_track_id_fkey;
alter table public.questionnaire_response
  add  constraint questionnaire_response_track_id_fkey
  foreign key (track_id) references public.tracks (id)
  on update no action on delete restrict;

commit;
