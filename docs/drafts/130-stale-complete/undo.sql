-- UNDO REHEARSAL for migrations 130 + 131, exactly as the two headers specify, in one
-- transaction. Run by run.sh step 11 against the harness cluster; it is NOT a migration and is
-- never applied to a live project without an explicit decision to roll back.
--
-- THE ORDER IS LOAD-BEARING:
--   1. drop 131's guard FIRST — it refuses any hand-written seg_status write, including this one;
--   2. restore seg_status + approved_by from the snapshot;
--   3. only THEN restore is_published, because 126's content precondition refuses to re-publish a
--      lesson that has no `complete` segment — so the segments must be back first;
--   4. restore the audit CHECK (which needs the actor-less rows gone);
--   5. put 131's objects back.
--
-- Step 2 writes `seg_status` directly: on Moosii 057 revokes that column from every role, so the
-- undo runs as the table owner (`postgres`), which is how this repo applies migrations.

BEGIN;

-- ---------------------------------------------------------------- 1. the guard comes off
DROP TRIGGER IF EXISTS segments_status_derived_guard_trg ON public.segments;

-- ---------------------------------------------------------------- 2. segments
UPDATE public.segments s
   SET seg_status  = k.seg_status_before,
       approved_by = k.approved_by_before,
       updated_at  = now()
  FROM public.repair_130_snapshot k
 WHERE k.kind = 'segment'
   AND k.entity_id = s.id
   AND (s.seg_status, s.approved_by) IS DISTINCT FROM (k.seg_status_before, k.approved_by_before);

-- ---------------------------------------------------------------- 3. lessons
UPDATE public.lessons l
   SET is_published = k.is_published_before,
       published_by = k.published_by_before,
       updated_at   = now()
  FROM public.repair_130_snapshot k
 WHERE k.kind = 'lesson'
   AND k.entity_id = l.id
   AND k.is_published_before IS DISTINCT FROM l.is_published;

-- ---------------------------------------------------------------- 4. the audit CHECK
-- The actor-less rows must go before the stricter CHECK can be re-added. They are the record of
-- an action that is being undone; keeping them would require keeping the widened CHECK too, which
-- is a decision, not a default.
DELETE FROM public.content_approvals WHERE actor_role = 'migration' AND actor_id IS NULL;

ALTER TABLE public.content_approvals DROP CONSTRAINT IF EXISTS content_approvals_actor_required;
ALTER TABLE public.content_approvals ADD  CONSTRAINT content_approvals_actor_required
  CHECK (actor_id IS NOT NULL OR action = ANY (ARRAY['archive','unarchive']));

-- ---------------------------------------------------------------- 5. 131's objects
-- recompute_seg_status goes back to the 129 body (the CASE inlined, no seg_status_derived call).
CREATE OR REPLACE FUNCTION public.recompute_seg_status(p_seg_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_status text;
BEGIN
  PERFORM 1 FROM segments WHERE id = p_seg_id FOR UPDATE;   -- serialize per-segment recomputes
  v_status := CASE
    WHEN EXISTS (SELECT 1 FROM sub_segments WHERE seg_id = p_seg_id)
     AND NOT EXISTS (SELECT 1 FROM sub_segments
                     WHERE seg_id = p_seg_id AND review_state IS DISTINCT FROM 'clinically_approved')
     -- 129: no card may hold an UN-ADJUDICATED image — no approved image to fall back on, and a
     -- candidate nobody has ruled on. A candidate BESIDE an approved image does not block.
     AND NOT EXISTS (
       SELECT 1 FROM sub_segments ss
        WHERE ss.seg_id = p_seg_id
          AND NOT EXISTS (SELECT 1 FROM content_images ci
                           WHERE ci.sub_segment_id = ss.id AND ci.status = 'approved')
          AND EXISTS (SELECT 1 FROM content_images ci
                       WHERE ci.sub_segment_id = ss.id AND ci.status = 'candidate'))
    THEN 'complete' ELSE 'pending' END;
  UPDATE segments SET
    seg_status  = v_status,
    updated_at  = now(),
    approved_by = CASE WHEN v_status = 'pending' THEN NULL ELSE approved_by END
  WHERE id = p_seg_id;
  RETURN v_status;
END $function$;

REVOKE ALL ON FUNCTION public.recompute_seg_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_seg_status(uuid) TO service_role;

DROP FUNCTION IF EXISTS public.segments_status_derived_guard();
DROP FUNCTION IF EXISTS public.seg_status_derived(uuid);

DROP TABLE IF EXISTS public.repair_130_snapshot;

-- ---------------------------------------------------------------- assertions
DO $$
DECLARE v_md5 text; v_n int;
BEGIN
  SELECT md5(replace(pg_get_functiondef('public.recompute_seg_status(uuid)'::regprocedure), chr(13), ''))
    INTO v_md5;
  IF v_md5 <> '017a190fd685972a20924e1a98e16170' THEN
    RAISE EXCEPTION 'UNDO: recompute_seg_status is not back to the 129 body (md5 %)', v_md5;
  END IF;

  IF to_regprocedure('public.seg_status_derived(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'UNDO: seg_status_derived still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'segments_status_derived_guard_trg') THEN
    RAISE EXCEPTION 'UNDO: the guard trigger still exists';
  END IF;
  IF to_regclass('public.repair_130_snapshot') IS NOT NULL THEN
    RAISE EXCEPTION 'UNDO: the snapshot table still exists';
  END IF;

  -- The stale rows are BACK — which is the proof the undo was exact, not merely clean.
  SELECT count(*) INTO v_n FROM public.segments s
   WHERE s.seg_status = 'complete'
     AND (NOT EXISTS (SELECT 1 FROM public.sub_segments ss WHERE ss.seg_id = s.id)
          OR EXISTS (SELECT 1 FROM public.sub_segments ss
                      WHERE ss.seg_id = s.id AND ss.review_state IS DISTINCT FROM 'clinically_approved'));
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'UNDO: expected the 5 fixture stale segments back, got %', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.lessons WHERE coalesce(is_published, false);
  RAISE NOTICE 'UNDO ok: 5 stale segments restored, % published lesson(s), 131 removed, CHECK restored', v_n;
END $$;

COMMIT;
