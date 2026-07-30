-- ============================================================================
-- Migration 048: check-in routing arm in questionnaire_responses_tracks (DRAFT)
-- ============================================================================
-- DRAFT — NOT applied by the agent. APPLY VIA THE SUPABASE SQL EDITOR after review;
-- on the 008..048 reconciliation list.
--
-- RECONCILIATION NOTE: the `checkins_foundation` change (wipe questionnaires; drop
-- is_score_based; add questionnaire.kind; rebuild questionnaire_user_answers against the
-- ATOM tables; add questionnaire_answer_actions + questionnaire_questions.milestone_id;
-- recreate questionnaire_with_track_name / questionnaire_user_score) is LIVE but has no
-- migration file yet — it must be filed and precede this one. Renumber 048 if needed.
--
-- WHAT THIS DOES. Adds a CHECK-IN routing arm to the view questionnaire_responses_tracks:
-- a parent's chosen ANSWER whose questionnaire_answer_actions row is add_track / add_tag
-- grants that track / tag. Routing stays DERIVED — nothing writes a routing result.
--
-- CONTRACT PRESERVED EXACTLY. The view keeps its 10 output columns, names, ORDER, types and
-- semantics. The diagnostic arm below is VERBATIM from the live definition
-- (pg_get_viewdef). The check-in arm's four diagnostic-only columns are bare NULL so the
-- UNION inherits the diagnostic arm's exact types (response_id uuid, score / score_*_range
-- numeric) — no explicit cast that could silently widen integer→numeric.
--
-- FROZEN NEIGHBORHOOD UNTOUCHED. user_active_tracks (view) and its byte-identical twin
-- user_active_tracks_for_user (migration 037) are NOT modified. A check-in add_track row
-- (track_id set, tag_id NULL) flows through their existing DIRECT arm; an add_tag row
-- (tag_id set, track_id NULL) flows through their existing TAG arm (track_tag_map
-- expansion). latest-answer-wins falls out of their existing
-- `DISTINCT ON (user_id, track_id) ORDER BY action_at DESC`, since action_at = the answer's
-- created_at.
--
-- ASYMMETRY (intentional, documented): the check-in arm hardcodes `add = true`. The check-in
-- action vocabulary has no removal concept (add_track / add_tag only) — unlike diagnostic
-- bands, which carry a real add boolean. record_milestone (and any other action_type) is
-- excluded by the WHERE filter and produces NO routing row.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.questionnaire_responses_tracks AS
-- DIAGNOSTIC ARM — verbatim from the live definition (unchanged).
 SELECT qr.id AS response_id,
    qr.track_id,
    qr.questionnaire_id,
    qr.score_min_range,
    qr.score_max_range,
    qr.add,
    qr.tag_id,
    ci.user_id,
    ci.score,
    ci.created_at AS action_at
   FROM questionnaire_response qr
     JOIN completed_items ci ON ci.questionnaire_id = qr.questionnaire_id
  WHERE ci.score >= qr.score_min_range AND ci.score <= qr.score_max_range
UNION ALL
-- CHECK-IN ARM — one chosen ANSWER's action grants a track (add_track) or tag (add_tag).
 SELECT NULL AS response_id,               -- inherits qr.id (uuid) from the diagnostic arm
    qaa.track_id,
    qua.questionnaire_id,
    NULL AS score_min_range,               -- inherits diagnostic type (no widening)
    NULL AS score_max_range,
    true AS add,                           -- check-ins only ADD (no removal in the vocabulary)
    qaa.tag_id,
    qua.user_id,
    NULL AS score,
    qua.created_at AS action_at            -- the answer's time drives latest-answer-wins
   FROM questionnaire_user_answers qua
     JOIN questionnaire_answer_actions qaa ON qaa.answer_id = qua.answer_id
  WHERE qaa.action_type = ANY (ARRAY['add_track'::text, 'add_tag'::text]);

COMMIT;
