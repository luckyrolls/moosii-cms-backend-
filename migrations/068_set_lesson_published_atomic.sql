-- ============================================================================
-- Migration 068: set_lesson_published — flip + audit in ONE transaction (DRAFT)
-- ============================================================================
-- WHY. `POST /lessons/:id/publish|unpublish` did two separate writes: an UPDATE of
-- `lessons.is_published` and then an INSERT into `content_approvals` via logApproval().
-- Over PostgREST those are two HTTP round trips and therefore TWO transactions, so the
-- flip could commit while the audit row did not — and logApproval swallows its own errors
-- by design, so that outcome was invisible: the route still returned 200. A publish with
-- no audit row is exactly the failure this table exists to prevent.
--
-- supabase-js has no cross-statement transaction, so ONE SQL function is the only way to
-- make the pair atomic. Same shape as the existing multi-table RPCs (approve_segment_bundle
-- 029, set_card_review_state 056).
--
-- ⚠ THIS DELIBERATELY INVERTS logApproval's FAIL DIRECTION, FOR THIS ACTION ONLY.
-- logApproval's contract is "a logging failure must NEVER break the action" — right for an
-- approve, where losing the audit row is better than blocking the human. Here the
-- requirement is the opposite: the flip and its audit row are one fact. If the INSERT
-- fails, the function raises, the transaction rolls back, and the lesson is NOT published.
-- Publishing unaudited is the worse outcome. Every OTHER logApproval caller keeps the old,
-- forgiving behaviour — nothing else changes.
--
-- ACTOR IS REQUIRED. `content_approvals.actor_id` is NOT NULL, and the old code path
-- silently SKIPPED the row when `req.user` was missing (logApproval returns early with a
-- warning). Here a null actor raises instead, so the write cannot happen unattributed.
--
-- published_by IS TEXT, NOT uuid. Verified live: one row holds 'mark@moosiiapp.com', which
-- a uuid column could not store — a legacy direct-write value. This function writes the
-- actor's uuid AS TEXT on publish and NULL on unpublish, matching what the route did.
-- (Those legacy email values are left alone; cleaning them up is separate.)
--
-- SECURITY INVOKER (the default), deliberately: the backend calls it with the service role,
-- which already has UPDATE on `lessons` and INSERT on `content_approvals`. It needs no
-- elevated rights, so it gets none. Note migration 064's guard trigger on `lessons` is
-- scoped to `description` / `safety_sensitive` only, so it does not fire here.
--
-- FINANCIAL PROJECT: inherits this via the schema dump.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..068 reconciliation list.
-- Idempotent: CREATE OR REPLACE. No CONCURRENTLY. New function, so no return-type hazard.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST.
-- 1. The name is free:
--    SELECT to_regprocedure('public.set_lesson_published(uuid,boolean,uuid,text)');
--    -- EXPECT NULL on a first apply.
-- 2. Today's audit gap, for comparison after: EXPECT 0 before any publish goes through
--    the new path.
--    SELECT count(*) FROM content_approvals WHERE entity_type = 'lesson';
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE FUNCTION public.set_lesson_published(
  p_lesson_id  uuid,
  p_published  boolean,
  p_actor_id   uuid,
  p_actor_role text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows integer;
BEGIN
  -- Unattributed publish state changes are refused outright. The old path skipped the
  -- audit row here and carried on; that is what made the gap invisible.
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'set_lesson_published: an actor is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  UPDATE lessons
     SET is_published = p_published,
         -- text column (see the header): the actor's uuid on publish, cleared on unpublish.
         published_by = CASE WHEN p_published THEN p_actor_id::text ELSE NULL END,
         updated_at   = now()
   WHERE id = p_lesson_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- Unknown lesson: no audit row, and the caller turns this into a 404. Returning rather
  -- than raising keeps "not found" distinguishable from "the write failed".
  IF v_rows = 0 THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- Same transaction as the UPDATE above: if this fails, the flip is rolled back with it.
  INSERT INTO content_approvals (entity_type, entity_id, action, actor_id, actor_role)
  VALUES (
    'lesson',
    p_lesson_id,
    CASE WHEN p_published THEN 'publish' ELSE 'unpublish' END,
    p_actor_id,
    p_actor_role
  );

  RETURN jsonb_build_object('found', true, 'is_published', p_published);
END $$;

COMMENT ON FUNCTION public.set_lesson_published(uuid, boolean, uuid, text) IS
  'Migration 068: flips lessons.is_published AND writes the content_approvals row in ONE '
  'transaction, so a lesson can never be published or unpublished without its audit row. '
  'Raises if the actor is null. Returns {found:false} for an unknown lesson. Deliberately '
  'inverts logApproval''s "never block the action" rule for this action only.';

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying. Every case rolls back.
--
-- 1. Publish writes BOTH, atomically:
--    BEGIN;
--      SELECT set_lesson_published(
--        (SELECT id FROM lessons WHERE NOT is_published LIMIT 1),
--        true,
--        (SELECT id FROM "user" WHERE role IN ('admin','super_admin') LIMIT 1),
--        'super_admin');
--      -- EXPECT {"found": true, "is_published": true}
--      SELECT entity_type, action, actor_role FROM content_approvals
--       ORDER BY created_at DESC LIMIT 1;   -- EXPECT lesson / publish / super_admin
--    ROLLBACK;
--
-- 2. Unknown lesson → found:false, and NO audit row is written:
--    BEGIN;
--      SELECT set_lesson_published(gen_random_uuid(), true,
--        (SELECT id FROM "user" WHERE role IN ('admin','super_admin') LIMIT 1), 'super_admin');
--      -- EXPECT {"found": false}
--      SELECT count(*) FROM content_approvals WHERE created_at > now() - interval '1 minute';
--      -- EXPECT 0
--    ROLLBACK;
--
-- 3. A null actor is REFUSED (this is the case the old path silently skipped):
--    SELECT set_lesson_published(
--      (SELECT id FROM lessons LIMIT 1), true, NULL, NULL);
--    -- EXPECT ERROR 22004 "an actor is required"
--
-- 4. ATOMICITY, the whole point. Break the audit insert and confirm the flip does NOT
--    survive — temporarily forbid the action value, then put it back:
--    BEGIN;
--      ALTER TABLE content_approvals DROP CONSTRAINT content_approvals_action_check;
--      ALTER TABLE content_approvals ADD  CONSTRAINT content_approvals_action_check
--        CHECK (action IN ('approve','unapprove','editorial_approve','clinical_approve','reject'));
--      SELECT set_lesson_published((SELECT id FROM lessons WHERE NOT is_published LIMIT 1),
--        true, (SELECT id FROM "user" WHERE role IN ('admin','super_admin') LIMIT 1), 'super_admin');
--      -- EXPECT a check_violation, NOT a successful publish
--    ROLLBACK;   -- restores the original constraint AND discards any flip
-- ============================================================================
