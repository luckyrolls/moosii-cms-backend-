-- ============================================================================
-- Migration 045: exclude ARCHIVED tracks from the active-track set (fn + view twin)
-- ============================================================================
-- New nullable column tracks.archived_at (applied separately). Non-null = archived =
-- shelved test/legacy content that must be INVISIBLE TO PARENTS, not just the CMS.
--
-- Track "assignment" is DERIVED, not stored: user_active_tracks_for_user(uuid) and its
-- view twin user_active_tracks resolve the active set from every input (defaults,
-- demographic rules, questionnaire routing, classify/manual mods) and converge on ONE
-- final `JOIN tracks t`. Excluding archived tracks THERE removes them from every
-- assignment path at once, and cascades through the MLP (generateFullMLP only buckets
-- pool items whose track is in this set — so an archived track's lessons AND its
-- host questionnaires drop from every user's plan on recompute).
--
-- CHANGE (both objects, one line each): add `AND t.archived_at IS NULL` beside the
-- existing `* All Tracks` sentinel exclusion in the final SELECT. Nothing else changes.
-- The function and view are the SAME resolution logic in two places (migration 037) and
-- MUST stay in sync — hence both in this one migration, changed identically.
--
-- Lesson-level archival (an individual lesson archived inside a LIVE track) is handled
-- separately in migration 046 (mlp_item_pool lesson arm). Together they implement the
-- derived rule: a lesson is effective-archived if lessons.archived_at IS NOT NULL OR its
-- track's archived_at IS NOT NULL — never stamped onto the lessons.
--
-- Enforcement is AT RECOMPUTE (loadUserMlpInputs reads the function; apply_classification
-- reads the view). No live users exist yet, so stale user_mlp rows are a non-issue; if that
-- changes, filtering user_mlp_not_completed is the known instant-effect follow-up.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..046 reconciliation list. Apply 045 then 046.
-- ============================================================================

BEGIN;

-- ---- 1. Per-user function (twin of the view; migration 037) --------------------------
CREATE OR REPLACE FUNCTION user_active_tracks_for_user(p_user_id uuid)
RETURNS TABLE (user_id uuid, track_id uuid, track_name text, priority integer, weight integer)
LANGUAGE sql
STABLE
AS $$
  WITH base_tracks AS (
    SELECT DISTINCT udr.user_id, dtr.track_id
    FROM user_demographic_responses udr
      JOIN demographic_questions dq ON dq.id = udr.question_id AND dq.is_active = true
      JOIN demographic_answers da ON da.id = udr.answer_id AND da.is_active = true
      JOIN demographic_track_rules dtr ON dtr.answer_id = udr.answer_id
    WHERE udr.user_id = p_user_id
  ), default_tracks AS (
    SELECT u.user_id, nut.track_id
    FROM user_mlp_data u
      CROSS JOIN new_user_tracks nut
    WHERE u.user_id = p_user_id
  ), base_set AS (
    SELECT base_tracks.user_id, base_tracks.track_id FROM base_tracks
    UNION
    SELECT default_tracks.user_id, default_tracks.track_id FROM default_tracks
  ), questionnaire_track_actions AS (
    SELECT qrt.user_id, qrt.track_id, qrt.add, qrt.action_at
    FROM questionnaire_responses_tracks qrt
    WHERE qrt.track_id IS NOT NULL AND qrt.user_id = p_user_id
    UNION ALL
    SELECT qrt.user_id, ttm.track_id, qrt.add, qrt.action_at
    FROM questionnaire_responses_tracks qrt
      JOIN track_tag_map ttm ON qrt.tag_id = ttm.tag_id
    WHERE qrt.tag_id IS NOT NULL AND qrt.user_id = p_user_id
  ), latest_questionnaire_action AS (
    SELECT DISTINCT ON (qta.user_id, qta.track_id) qta.user_id, qta.track_id, qta.add, qta.action_at
    FROM questionnaire_track_actions qta
    ORDER BY qta.user_id, qta.track_id, qta.action_at DESC, qta.add DESC
  ), after_questionnaire AS (
    (
      SELECT base_set.user_id, base_set.track_id FROM base_set
      UNION
      SELECT latest_questionnaire_action.user_id, latest_questionnaire_action.track_id
      FROM latest_questionnaire_action
      WHERE latest_questionnaire_action.add = true
    ) EXCEPT
    SELECT latest_questionnaire_action.user_id, latest_questionnaire_action.track_id
    FROM latest_questionnaire_action
    WHERE latest_questionnaire_action.add = false
  ), latest_user_mod AS (
    SELECT DISTINCT ON (umm.user_id, umm.track_id) umm.user_id, umm.track_id, lower(umm.action) AS action, umm.created_at AS action_at
    FROM user_mlp_mods umm
    WHERE umm.user_id = p_user_id
    ORDER BY umm.user_id, umm.track_id, umm.created_at DESC
  ), final_tracks AS (
    (
      SELECT after_questionnaire.user_id, after_questionnaire.track_id FROM after_questionnaire
      UNION
      SELECT latest_user_mod.user_id, latest_user_mod.track_id
      FROM latest_user_mod
      WHERE latest_user_mod.action = 'add'::text
    ) EXCEPT
    SELECT latest_user_mod.user_id, latest_user_mod.track_id
    FROM latest_user_mod
    WHERE latest_user_mod.action = 'delete'::text
  )
  SELECT ft.user_id, ft.track_id, t.track_name, t.priority, t.weight
  FROM final_tracks ft
    JOIN tracks t ON t.id = ft.track_id
  WHERE t.track_name IS DISTINCT FROM '* All Tracks'::text
    AND t.archived_at IS NULL          -- ADDED (045): archived tracks are invisible to parents
  ORDER BY t.weight DESC;
$$;

-- ---- 2. The view twin (keep in sync with the function above) --------------------------
CREATE OR REPLACE VIEW public.user_active_tracks AS
  WITH base_tracks AS (
    SELECT DISTINCT udr.user_id, dtr.track_id
    FROM user_demographic_responses udr
      JOIN demographic_questions dq ON dq.id = udr.question_id AND dq.is_active = true
      JOIN demographic_answers da ON da.id = udr.answer_id AND da.is_active = true
      JOIN demographic_track_rules dtr ON dtr.answer_id = udr.answer_id
  ), default_tracks AS (
    SELECT u.user_id, nut.track_id
    FROM user_mlp_data u
      CROSS JOIN new_user_tracks nut
  ), base_set AS (
    SELECT base_tracks.user_id, base_tracks.track_id FROM base_tracks
    UNION
    SELECT default_tracks.user_id, default_tracks.track_id FROM default_tracks
  ), questionnaire_track_actions AS (
    SELECT qrt.user_id, qrt.track_id, qrt.add, qrt.action_at
    FROM questionnaire_responses_tracks qrt
    WHERE qrt.track_id IS NOT NULL
    UNION ALL
    SELECT qrt.user_id, ttm.track_id, qrt.add, qrt.action_at
    FROM questionnaire_responses_tracks qrt
      JOIN track_tag_map ttm ON qrt.tag_id = ttm.tag_id
    WHERE qrt.tag_id IS NOT NULL
  ), latest_questionnaire_action AS (
    SELECT DISTINCT ON (qta.user_id, qta.track_id) qta.user_id, qta.track_id, qta.add, qta.action_at
    FROM questionnaire_track_actions qta
    ORDER BY qta.user_id, qta.track_id, qta.action_at DESC, qta.add DESC
  ), after_questionnaire AS (
    (
      SELECT base_set.user_id, base_set.track_id FROM base_set
      UNION
      SELECT latest_questionnaire_action.user_id, latest_questionnaire_action.track_id
      FROM latest_questionnaire_action
      WHERE latest_questionnaire_action.add = true
    ) EXCEPT
    SELECT latest_questionnaire_action.user_id, latest_questionnaire_action.track_id
    FROM latest_questionnaire_action
    WHERE latest_questionnaire_action.add = false
  ), latest_user_mod AS (
    SELECT DISTINCT ON (umm.user_id, umm.track_id) umm.user_id, umm.track_id, lower(umm.action) AS action, umm.created_at AS action_at
    FROM user_mlp_mods umm
    ORDER BY umm.user_id, umm.track_id, umm.created_at DESC
  ), final_tracks AS (
    (
      SELECT after_questionnaire.user_id, after_questionnaire.track_id FROM after_questionnaire
      UNION
      SELECT latest_user_mod.user_id, latest_user_mod.track_id
      FROM latest_user_mod
      WHERE latest_user_mod.action = 'add'::text
    ) EXCEPT
    SELECT latest_user_mod.user_id, latest_user_mod.track_id
    FROM latest_user_mod
    WHERE latest_user_mod.action = 'delete'::text
  )
  SELECT ft.user_id, ft.track_id, t.track_name, t.priority, t.weight
  FROM final_tracks ft
    JOIN tracks t ON t.id = ft.track_id
  WHERE t.track_name IS DISTINCT FROM '* All Tracks'::text
    AND t.archived_at IS NULL          -- ADDED (045): keep in sync with the function twin
  ORDER BY ft.user_id, t.weight DESC;

COMMIT;
