-- ============================================================================
-- DRAFT 065: fact arm on user_active_tracks_for_user + its VIEW TWIN (NOT APPLIED)
-- ============================================================================
-- RATIONALE: this is the ONE line of code that makes facts do anything. Track assignment
-- is DERIVED, and every source (defaults, demographic rules, questionnaire routing,
-- classify/manual mods) converges on this single resolution. Adding facts as a sixth arm
-- means the MLP, archival, the CMS preview and the questionnaire inspector all pick it up
-- with NO further changes — exactly how migration 045 made archival universal.
--
-- ⚠⚠ THE FUNCTION AND THE VIEW ARE THE SAME LOGIC IN TWO PLACES AND MUST STAY IN SYNC.
-- (Established by migration 037, re-stated by 045.) They have different consumers —
-- the function is read by the backend recompute (loadUserMlpInputs), the view by
-- apply_classification (migrations 020/021) and any app-side reader — so a change to one
-- without the other silently gives two users different plans depending on entry point.
-- Both are changed here, identically, in one transaction. Never split them.
--
-- ⚠ TRANSCRIPTION WARNING: the bodies below are migration 045's verbatim, with ONE arm
-- added and ONE line added to base_set (both marked `-- ADDED (065)`). Nothing else
-- differs. BEFORE APPLYING, confirm 045 is still what is live — if anything has been
-- re-created since, re-base onto the live text instead of this file:
--   SELECT pg_get_functiondef('user_active_tracks_for_user(uuid)'::regprocedure);
--   SELECT pg_get_viewdef('user_active_tracks'::regclass, true);
--
-- ⚠ INTERACTION WITH MIGRATION 059 (user_mlp_data LEFT JOIN rewrite, SQL with Mark):
-- 059 does NOT touch these two objects, so apply order between them does not matter.
-- It DOES change what the `default_tracks` arm returns (zero-child users start getting a
-- user_mlp_data row, hence the default tracks). That is 059's intended effect and is
-- independent of this arm.
--
-- SEMANTICS OF THE NEW ARM:
--   * ADDITIVE ONLY. It contributes rows to base_set and can never emit a removal —
--     there is no `add=false` equivalent for facts (mirroring the check-in routing arm,
--     migration 048/049, which likewise only ever adds).
--   * A human `delete` in user_mlp_mods still WINS: the final EXCEPT runs after base_set,
--     so a fact cannot resurrect a track an admin explicitly removed.
--   * An ARCHIVED target track stays inert — the final `JOIN tracks … archived_at IS NULL`
--     (045) filters it exactly as it does every other arm.
--   * A CLEARED fact stops contributing immediately (user_facts_latest flips), so the
--     track leaves on the next recompute UNLESS another arm also grants it. See
--     `docs/drafts/facts-v1/README.md` §4 — this is the point Mark must confirm.
--   * EMPTY VOCABULARY = NO-OP. With no fact_track_rules rows the arm returns nothing and
--     resolution is byte-identical to 045, so this is safe to apply to BOTH Supabase
--     projects to keep the schemas identical.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — LAST in the facts-v1 set. Requires 062
-- (user_facts_latest) and 063 (fact_track_rules) to exist first, or it fails to compile.
-- ============================================================================

BEGIN;

-- ---- 1. Per-user function (twin of the view; migrations 037/045) ----------------------
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
  ), fact_tracks AS (                        -- ADDED (065): platform-supplied facts
    SELECT ufl.user_id, ftr.track_id
    FROM user_facts_latest ufl
      JOIN fact_track_rules ftr
        ON ftr.fact_key = ufl.fact_key AND ftr.value = ufl.value
    WHERE ufl.user_id = p_user_id
  ), base_set AS (
    SELECT base_tracks.user_id, base_tracks.track_id FROM base_tracks
    UNION
    SELECT default_tracks.user_id, default_tracks.track_id FROM default_tracks
    UNION
    SELECT fact_tracks.user_id, fact_tracks.track_id FROM fact_tracks   -- ADDED (065)
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
    AND t.archived_at IS NULL          -- from 045: archived tracks are invisible to parents
  ORDER BY t.weight DESC;
$$;

COMMENT ON FUNCTION user_active_tracks_for_user(uuid) IS
  'Per-user twin of the user_active_tracks view (migration 037): same resolution, filtered '
  'by user_id in each arm so it is O(one user). Keep in sync with the view definition. '
  'Migration 065 added the fact_tracks arm (user_facts_latest x fact_track_rules).';

-- ---- 2. The view twin (KEEP IN SYNC WITH THE FUNCTION ABOVE) --------------------------
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
  ), fact_tracks AS (                        -- ADDED (065): keep in sync with the function
    SELECT ufl.user_id, ftr.track_id
    FROM user_facts_latest ufl
      JOIN fact_track_rules ftr
        ON ftr.fact_key = ufl.fact_key AND ftr.value = ufl.value
  ), base_set AS (
    SELECT base_tracks.user_id, base_tracks.track_id FROM base_tracks
    UNION
    SELECT default_tracks.user_id, default_tracks.track_id FROM default_tracks
    UNION
    SELECT fact_tracks.user_id, fact_tracks.track_id FROM fact_tracks   -- ADDED (065)
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
    AND t.archived_at IS NULL          -- from 045: keep in sync with the function twin
  ORDER BY ft.user_id, t.weight DESC;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying.
--
-- 1. NO-OP PROOF (run BEFORE authoring any fact_track_rules row). With an empty rule
--    table the arm must contribute nothing — EXPECT ZERO ROWS from both halves:
--      WITH users AS (SELECT DISTINCT user_id FROM user_active_tracks)
--      (
--        SELECT 'in_view_not_fn' AS diff, user_id, track_id FROM user_active_tracks
--        EXCEPT
--        SELECT 'in_view_not_fn', f.user_id, f.track_id
--        FROM users u CROSS JOIN LATERAL user_active_tracks_for_user(u.user_id) f
--      )
--      UNION ALL
--      (
--        SELECT 'in_fn_not_view' AS diff, f.user_id, f.track_id
--        FROM users u CROSS JOIN LATERAL user_active_tracks_for_user(u.user_id) f
--        EXCEPT
--        SELECT 'in_fn_not_view', user_id, track_id FROM user_active_tracks
--      );
--
-- 2. ARM PROOF. Author one rule, write one matching fact, and confirm the track appears
--    in BOTH objects; then write a CLEARING observation and confirm it disappears from
--    both (assuming no other arm grants that track):
--      SELECT track_id FROM user_active_tracks_for_user('<uuid>');
--      SELECT track_id FROM user_active_tracks WHERE user_id = '<uuid>';
-- ============================================================================
