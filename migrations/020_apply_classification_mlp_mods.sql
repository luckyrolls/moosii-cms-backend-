-- ============================================================================
-- Migration 020: apply_classification → user_mlp_mods (supersedes the 019 fn body)
-- ============================================================================
-- Corrects the write target: user_active_tracks is a VIEW that lower()s and unions
-- user_mlp_mods.action. A classify-add is a per-user OVERRIDE on top of the rule
-- layers, so it writes user_mlp_mods(action='add'), NOT user_tracks. Also drops the
-- now-moot UNIQUE(user_id,track_id) on user_tracks that 019 added (user_mlp_mods
-- legitimately holds many rows per pair over time — latest wins; idempotency is a
-- pre-check, not a constraint).
--
-- apply_classification, per proposal:
--   a. ALREADY-ACTIVE: (user_id,track_id) in user_active_tracks → skip, reason
--      'already_active'.
--   b. MANUAL-OVERRIDE GUARD: latest mod for the pair is 'delete' with NO
--      user_track_activations row referencing that mod (= a human delete; all
--      pre-classify rows are manual) → skip, reason 'manual_override'. Inference
--      never overrides an explicit human action.
--   else: INSERT user_mlp_mods(action='add') + one user_track_activations row
--   (source='classify', source_ref = the new mod's id, confidence). Manual vs
--   classify stays ALWAYS distinguishable by presence/absence of that activation row.
-- Milestone facts are DECOUPLED from activation: every resolved milestone writes
-- child_milestones (ON CONFLICT DO NOTHING, first-reach-wins), independent of adds.
--
-- APPLIED VIA THE SUPABASE SQL EDITOR — on the 008..020 reconciliation list.
-- ============================================================================

BEGIN;

ALTER TABLE user_tracks DROP CONSTRAINT IF EXISTS user_tracks_user_track_uniq;

CREATE OR REPLACE FUNCTION apply_classification(
  p_user_id    uuid,
  p_child_id   uuid,
  p_event_id   uuid,
  p_proposals  jsonb,   -- [{ "track_id", "confidence", "source_signal" }, ...]
  p_milestones jsonb    -- [{ "milestone_id", "confidence" }, ...]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  r               record;
  v_track         uuid;
  v_conf          numeric;
  v_new_mod_id    uuid;
  v_latest_mod_id uuid;
  v_latest_action text;
  v_reason        text;
  v_applied       boolean;
  v_results       jsonb := '[]'::jsonb;
  v_ms_count      integer;
BEGIN
  FOR r IN SELECT elem FROM jsonb_array_elements(p_proposals) AS t(elem) LOOP
    v_track  := (r.elem->>'track_id')::uuid;
    v_conf   := NULLIF(r.elem->>'confidence','')::numeric;
    v_reason := NULL;
    v_applied := false;

    IF EXISTS (SELECT 1 FROM user_active_tracks WHERE user_id = p_user_id AND track_id = v_track) THEN
      v_reason := 'already_active';
    ELSE
      SELECT id, action INTO v_latest_mod_id, v_latest_action
      FROM user_mlp_mods
      WHERE user_id = p_user_id AND track_id = v_track
      ORDER BY created_at DESC
      LIMIT 1;

      IF lower(v_latest_action) = 'delete'
         AND NOT EXISTS (SELECT 1 FROM user_track_activations WHERE source_ref = v_latest_mod_id::text) THEN
        v_reason := 'manual_override';
      ELSE
        INSERT INTO user_mlp_mods (user_id, track_id, action)
        VALUES (p_user_id, v_track, 'add')
        RETURNING id INTO v_new_mod_id;

        INSERT INTO user_track_activations (user_id, track_id, source, source_ref, confidence)
        VALUES (p_user_id, v_track, 'classify', v_new_mod_id::text, v_conf);

        v_applied := true;
      END IF;
    END IF;

    v_results := v_results || jsonb_build_object('track_id', v_track, 'applied', v_applied, 'reason', v_reason);
  END LOOP;

  WITH m AS (
    INSERT INTO child_milestones (child_id, milestone_id, source, source_ref, confidence)
    SELECT p_child_id, (elem->>'milestone_id')::uuid, 'classify', p_event_id::text,
           NULLIF(elem->>'confidence','')::numeric
    FROM jsonb_array_elements(p_milestones) AS t(elem)
    ON CONFLICT (child_id, milestone_id) DO NOTHING
    RETURNING id
  )
  SELECT count(*) INTO v_ms_count FROM m;

  RETURN jsonb_build_object('proposals', v_results, 'milestones_recorded', v_ms_count);
END $$;

COMMIT;
