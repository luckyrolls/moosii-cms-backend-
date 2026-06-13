-- ============================================================================
-- Migration 007: rebuild_user_mlp() — atomic delete+insert of a user's MLP
-- ============================================================================
-- Replaces the BuildShip updateMLP node's merge-duplicates upsert (whose
-- delete-cleanup step was commented out, leaving stale items behind — a latent
-- bug we are deliberately NOT porting). This deletes the user's existing rows
-- and reinserts the freshly computed set in one transaction: no stale rows, no
-- position collisions.
--
-- Column types verified against live user_mlp: item_id and track_id are uuid
-- (confirmed via type probe), so the ::uuid casts below are correct.
--
-- VERIFICATION PHASE: this targets user_mlp_v2.
-- CUTOVER: change BOTH table references below (DELETE and INSERT) to user_mlp
-- once the v2 diff is verified.
-- ============================================================================

CREATE OR REPLACE FUNCTION rebuild_user_mlp(
  p_user_id uuid,
  p_items jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  inserted_count integer;
BEGIN
  DELETE FROM user_mlp_v2 WHERE user_id = p_user_id;

  INSERT INTO user_mlp_v2 (
    user_id, item_id, item_type, track_id, track_name, position,
    item_name, item_description, with_quiz, item_priority,
    track_weight, track_priority, created_at
  )
  SELECT p_user_id,
         (e->>'item_id')::uuid,
         e->>'item_type',
         (e->>'track_id')::uuid,
         e->>'track_name',
         (e->>'position')::int,
         e->>'item_name',
         e->>'item_description',
         (e->>'with_quiz')::boolean,
         NULLIF(e->>'item_priority','')::int,
         NULLIF(e->>'track_weight','')::numeric,
         NULLIF(e->>'track_priority','')::int,
         now()
  FROM jsonb_array_elements(p_items) e;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END $$;
