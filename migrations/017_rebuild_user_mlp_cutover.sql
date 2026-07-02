-- ============================================================================
-- Migration 017: rebuild_user_mlp() CUTOVER — v2 → production user_mlp
-- ============================================================================
-- The deferred cutover from migration 007. rebuild_user_mlp() now writes the
-- REAL production table user_mlp (which the app reads, and which already has the
-- app's RLS policies / grants). user_mlp_v2 becomes vestigial (kept, not dropped).
--
-- One-time snapshot: the current user_mlp holds the OLD BuildShip-era rows. This
-- copies them to user_mlp_bs_backup before the first post-cutover recompute
-- overwrites them, so the old logic's output stays inspectable. (Data-only copy;
-- drop it whenever you're done comparing.)
--
-- APPLIED VIA THE SUPABASE SQL EDITOR — on the 008..017 reconciliation list.
-- Idempotent: snapshot guarded by IF NOT EXISTS; function is CREATE OR REPLACE.
-- ============================================================================

BEGIN;

-- 1. Preserve the old (BuildShip) user_mlp for later comparison.
CREATE TABLE IF NOT EXISTS user_mlp_bs_backup AS SELECT * FROM user_mlp;

-- 2. Point the rebuild function at production user_mlp (was user_mlp_v2).
CREATE OR REPLACE FUNCTION rebuild_user_mlp(
  p_user_id uuid,
  p_items jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  inserted_count integer;
BEGIN
  DELETE FROM user_mlp WHERE user_id = p_user_id;

  INSERT INTO user_mlp (
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

COMMIT;
