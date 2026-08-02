-- ============================================================================
-- Migration 049: scope the check-in routing arm to kind='checkin' (DRAFT)
-- ============================================================================
-- DRAFT — NOT applied by the agent. APPLY VIA THE SUPABASE SQL EDITOR after review;
-- on the 008..049 reconciliation list. Independent of 050/051 (any apply order).
--
-- WHY. Closes the Claim-1 hazard: the check-in arm added in 048 joined only
-- questionnaire_user_answers ⨝ questionnaire_answer_actions with no `kind` predicate,
-- so an action authored on a kind='diagnostic' questionnaire routed through the
-- check-in arm. Because that arm hardcodes add=true and carries action_at =
-- qua.created_at (per-answer, pre-scoring), such a row could OUTRANK and REVERSE a
-- diagnostic band's add=false in user_active_tracks' latest-action-wins resolution
-- (DISTINCT ON (user_id, track_id) ORDER BY action_at DESC, add DESC), and could fire
-- MID-questionnaire before the score is summed. Prior guard was CONVENTION only (no
-- tool authored actions on diagnostics); this makes it STRUCTURAL.
--
-- CONTRACT PRESERVED EXACTLY. The diagnostic arm is unchanged byte-for-byte. The output
-- column list is unchanged (10 cols, same names/order/types), so CREATE OR REPLACE
-- succeeds and user_active_tracks / user_active_tracks_for_user (migration 037/045) need
-- NO changes. The ONLY change is the added `JOIN questionnaire q` + `AND q.kind =
-- 'checkin'` in the check-in arm.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW questionnaire_responses_tracks AS
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
 SELECT NULL::uuid AS response_id,
    qaa.track_id,
    qua.questionnaire_id,
    NULL::integer AS score_min_range,
    NULL::integer AS score_max_range,
    true AS add,
    qaa.tag_id,
    qua.user_id,
    NULL::bigint AS score,
    qua.created_at AS action_at
   FROM questionnaire_user_answers qua
     JOIN questionnaire_answer_actions qaa ON qaa.answer_id = qua.answer_id
     JOIN questionnaire q ON q.id = qua.questionnaire_id
  WHERE qaa.action_type = ANY (ARRAY['add_track'::text, 'add_tag'::text])
    AND q.kind = 'checkin';

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying.
--   SELECT pg_get_viewdef('questionnaire_responses_tracks'::regclass, true);
--   SELECT count(*) FROM user_active_tracks;
-- ============================================================================
