-- ============================================================================
-- Migration 037: user_active_tracks_for_user(uuid) — per-user resolution function
-- ============================================================================
-- WHY. The `user_active_tracks` VIEW resolves the active-track set for ALL users and
-- filters to one user LAST (EXPLAIN: the DISTINCT ON sorts scan the WHOLE
-- completed_items / user_mlp_mods tables every call, then `Rows Removed by Filter`
-- discards all but the queried user). Today that's ~12ms warm, but the per-call work
-- scales with the TOTAL user base, not the one user asked for — a real cliff as usage
-- grows. (The acute pain today is cold-connection PLANNING of this big view: ~1.2s cold
-- vs ~66ms warm.)
--
-- FIX (ADDITIVE — the view is left UNTOUCHED). A set-returning function that applies the
-- same resolution logic with `WHERE user_id = p_user_id` pushed into EACH arm up front,
-- so every arm processes one user's rows (index scans) and the whole thing is O(one
-- user) regardless of total users. Same columns, same rows as the view (verified below).
--
-- CONSUMERS. Only the backend recompute (loadUserMlpInputs) is switched to the function
-- in this change. The VIEW remains for its other consumers — the apply_classification
-- RPC (migrations 020/021: `SELECT 1 FROM user_active_tracks WHERE …`) and any app-side
-- reader — which are unaffected. The logic now lives in two places (view + function);
-- they are the STABLE BuildShip-era resolution and must be kept in sync — cross-referenced
-- in comments. Retire the view once an app-side audit confirms nothing else reads it.
--
-- Grants: left at Postgres defaults (same exposure as the existing view, which PostgREST
-- already serves). Locking EXECUTE to service_role is a follow-up on the RLS sweep.
--
-- Flag: database.types.ts regen is OPTIONAL — the backend calls this via the existing
-- `supabase as any` bridge, so tsc is unaffected.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..037 reconciliation list.
-- ============================================================================

BEGIN;

-- Indexes that make each filtered arm an index scan (only the clearly-useful ones — the
-- append-heavy source tables the function filters by user_id). user_mlp_data is keyed by
-- user_id already; new_user_tracks/track_tag_map are tiny config (no index needed).
CREATE INDEX IF NOT EXISTS idx_completed_items_user_id            ON completed_items (user_id);
CREATE INDEX IF NOT EXISTS idx_user_mlp_mods_user_id             ON user_mlp_mods (user_id);
CREATE INDEX IF NOT EXISTS idx_user_demographic_responses_user_id ON user_demographic_responses (user_id);

-- Per-user twin of the user_active_tracks view. Body mirrors the view's CTEs EXACTLY,
-- with `= p_user_id` added to each source arm. KEEP IN SYNC WITH THE VIEW.
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
  ORDER BY t.weight DESC;
$$;

COMMENT ON FUNCTION user_active_tracks_for_user(uuid) IS
  'Per-user twin of the user_active_tracks view (migration 037): same resolution, filtered '
  'by user_id in each arm so it is O(one user). Keep in sync with the view definition.';

COMMIT;

-- ============================================================================
-- VERIFICATION — run this after applying. EXPECT ZERO ROWS (function output is
-- byte-identical to the view for every user the view currently produces). Any row =
-- a divergence between the function and the view.
-- ============================================================================
-- WITH users AS (SELECT DISTINCT user_id FROM user_active_tracks)
-- (
--   SELECT 'in_view_not_fn' AS diff, user_id, track_id, track_name, priority, weight
--   FROM user_active_tracks
--   EXCEPT
--   SELECT 'in_view_not_fn', f.user_id, f.track_id, f.track_name, f.priority, f.weight
--   FROM users u CROSS JOIN LATERAL user_active_tracks_for_user(u.user_id) f
-- )
-- UNION ALL
-- (
--   SELECT 'in_fn_not_view' AS diff, f.user_id, f.track_id, f.track_name, f.priority, f.weight
--   FROM users u CROSS JOIN LATERAL user_active_tracks_for_user(u.user_id) f
--   EXCEPT
--   SELECT 'in_fn_not_view', user_id, track_id, track_name, priority, weight
--   FROM user_active_tracks
-- );
