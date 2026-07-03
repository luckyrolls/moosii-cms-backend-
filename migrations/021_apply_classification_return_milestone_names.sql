-- ============================================================================
-- Migration 021: apply_classification returns milestone NAMES, not a count
-- ============================================================================
-- Supersedes the 020 fn body. Only the milestone tail changes: instead of
-- counting the newly-inserted child_milestones, return their milestone NAMES as
-- a jsonb array (milestones_recorded: string[]). The names are what the CMS
-- console panel renders — a bare count can't distinguish "crawling" from a
-- misresolved alias, and the names are the point of the panel.
--
-- Shape: milestones_recorded is now a jsonb array of names (e.g. ["crawling"]),
-- [] when nothing new landed. The proposals array and all activation/override
-- logic are UNCHANGED from 020.
--
-- Sequencing: RPC changes FIRST (this migration), THEN the endpoint flips its
-- response typing to string[]. In the gap, the deployed number-typed code passes
-- the jsonb array through harmlessly (no consumer yet besides the console in
-- progress).
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..021 reconciliation list.
-- ============================================================================

BEGIN;

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
  v_ms_names      jsonb;
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

  -- Return the NAMES of the milestones newly written this apply (first-reach-wins;
  -- ON CONFLICT DO NOTHING means a re-reached milestone is not re-listed). Stable
  -- ordering by name; [] when nothing new landed.
  WITH m AS (
    INSERT INTO child_milestones (child_id, milestone_id, source, source_ref, confidence)
    SELECT p_child_id, (elem->>'milestone_id')::uuid, 'classify', p_event_id::text,
           NULLIF(elem->>'confidence','')::numeric
    FROM jsonb_array_elements(p_milestones) AS t(elem)
    ON CONFLICT (child_id, milestone_id) DO NOTHING
    RETURNING milestone_id
  )
  SELECT coalesce(jsonb_agg(ms.name ORDER BY ms.name), '[]'::jsonb)
  INTO v_ms_names
  FROM m
  JOIN milestones ms ON ms.id = m.milestone_id;

  RETURN jsonb_build_object('proposals', v_results, 'milestones_recorded', v_ms_names);
END $$;

COMMIT;
