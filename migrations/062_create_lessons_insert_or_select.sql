-- ============================================================================
-- Migration 062: create_lessons_with_segments → INSERT-OR-SELECT (DRAFT)
-- ============================================================================
-- FROM: FINDINGS-catalog-integrity.md §B. The RPC was a bare INSERT with no conflict
-- handling, so every re-run of generate_lessons / coverage-accept that re-proposed an
-- existing title added a second row. This makes lesson creation IDEMPOTENT per
-- (track_id, lesson_name): the same call twice yields one lesson, and the second call
-- returns the FIRST one's id rather than nothing.
--
-- WHY INSERT-OR-SELECT AND NOT JUST DO NOTHING. With a plain DO NOTHING the RETURNING
-- clause emits no row for a conflict, so the caller gets fewer rows than it sent and has
-- no id for the proposal it just submitted — a dangling reference. Returning the EXISTING
-- row means a caller always gets exactly one id per proposal, whether it was created now
-- or months ago.
--
-- DELIBERATELY NOT `DO UPDATE`. An update would silently overwrite curator edits, tuned
-- priority, band_rationale and curator_note with fresh model output — and coverage-accept
-- is precisely where a human has just made choices. A skipped stub is a mild annoyance; a
-- silently rewritten hand-edited lesson is unrecoverable. Genuine update-in-place belongs
-- in an explicit PATCH /lessons/:id, invoked on purpose, not as a side effect of accepting
-- a proposal.
--
-- RETURN SHAPE: the three existing columns (id, lesson_name, description) are UNCHANGED in
-- name, type and order, so no existing caller breaks. One column is ADDED — `created
-- boolean` — because without it there is no way to tell "made now" from "already there",
-- and the CMS needs that to report honestly ("4 created, 2 already existed"). Adding a
-- trailing column is backward-compatible: PostgREST returns it as an extra JSON field and
-- a caller that ignores it is unaffected.
--
-- BACKEND COMPATIBILITY: the TypeScript in this repo tolerates the flag being ABSENT
-- (treats undefined as created), so the code can deploy BEFORE this migration is applied
-- without miscounting. See src/lib/lessonCreateResult.ts.
--
-- ⚠ REQUIRES MIGRATION 061. The `ON CONFLICT (track_id, lesson_name) WHERE archived_at IS
-- NULL` clause infers the partial unique index created there, by matching both the column
-- list AND the predicate. Without 061 this function fails at runtime with "there is no
-- unique or exclusion constraint matching the ON CONFLICT specification".
--
-- ARCHIVED ROWS DO NOT BLOCK. The conflict target is the partial index, so an archived
-- lesson with the same name is invisible to it: proposing that title again CREATES a new
-- live lesson, which is exactly the intent of archive-then-rewrite.
--
-- SIGNATURE UNCHANGED — still create_lessons_with_segments(p_lessons jsonb), so plain
-- CREATE OR REPLACE with no DROP and no overload hazard. The insert column list and the
-- segment-pairing CTE are carried over from 047 VERBATIM.
--
-- FINANCIAL PROJECT: inherits this via the schema dump.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..062 reconciliation list, AFTER 061.
-- Idempotent: CREATE OR REPLACE.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST.
-- 1. 061's index must exist and be valid, or the new body cannot infer it:
--    SELECT indisvalid FROM pg_index
--     WHERE indexrelid = 'lessons_track_name_active_uq'::regclass;   -- EXPECT true
-- 2. Confirm the CURRENT function still matches 047 before replacing it (if someone has
--    changed it since, re-base this body on the live text rather than on 047):
--    SELECT pg_get_functiondef('create_lessons_with_segments(jsonb)'::regprocedure);
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE FUNCTION create_lessons_with_segments(
  p_lessons jsonb
) RETURNS TABLE (
  id          uuid,
  lesson_name text,
  description text,
  created     boolean   -- ADDED (062): true = inserted by this call, false = already existed
)
LANGUAGE plpgsql
AS $$
begin
  return query
  with input as (
    -- Collapse INTRA-BATCH duplicates of the conflict key first. ON CONFLICT alone would
    -- skip the second copy but then `reused` could not find it either (it is not in the
    -- pre-statement snapshot of `lessons`), so the proposal would vanish from the result.
    -- DISTINCT ON keeps exactly one row per key, so N copies in one call yield ONE lesson
    -- and ONE returned row. The 010 header already flagged same-name-within-a-batch as a
    -- real case. (NULL lesson_name: DISTINCT ON treats NULLs as EQUAL while the unique
    -- index treats them as DISTINCT. Both current callers always supply a name.)
    select distinct on (l.track_id, l.lesson_name) l.*
    from jsonb_populate_recordset(null::lessons, p_lessons) as l
    order by l.track_id, l.lesson_name
  ),
  -- Insert only the handler-set columns; jsonb_populate_recordset coerces each field to the
  -- real `lessons` column types, so every other column keeps its DB default. internal_name
  -- added in 047 (curator_note 044; band_rationale + safety_sensitive 011; topic_id 010).
  -- NOTE: with_quiz is NOT set here and must not be — it is DERIVED by migration 063.
  ins as (
    insert into lessons (
      lesson_name, description, min_child_age, max_child_age,
      priority, track_id, topic_id, created_by,
      band_rationale, safety_sensitive, curator_note, internal_name
    )
    select
      l.lesson_name, l.description, l.min_child_age, l.max_child_age,
      l.priority, l.track_id, l.topic_id, l.created_by,
      l.band_rationale, coalesce(l.safety_sensitive, false), l.curator_note,
      -- always populated: verbatim internal_name when supplied, else the parent-facing name.
      coalesce(nullif(btrim(l.internal_name), ''), l.lesson_name)
    from input as l
    -- ADDED (062): infers the 061 partial index. Column list AND predicate must match it.
    on conflict (track_id, lesson_name) where archived_at is null do nothing
    returning lessons.id, lessons.lesson_name, lessons.description
  ),
  -- One segment per JUST-INSERTED lesson, paired by identity (ins.id) — NOT by a lesson_name
  -- match. This CTE executes even though the final SELECT does not read it: Postgres runs every
  -- data-modifying WITH clause exactly once. Reused lessons get NO new segment (they already
  -- have theirs) — that is the point of insert-or-select.
  seg as (
    insert into segments (lesson_id, segment_name, description)
    select ins.id, ins.lesson_name, ins.description
    from ins
    returning segments.id
  ),
  -- ADDED (062): the conflicting proposals, resolved to the LIVE row that already holds the
  -- name. `lessons` here is the pre-statement snapshot, so rows created by `ins` above are
  -- not visible and cannot be double-counted.
  reused as (
    select l.id, l.lesson_name, l.description
    from input i
    join lessons l
      on l.track_id    = i.track_id
     and l.lesson_name = i.lesson_name
     and l.archived_at is null
    where not exists (select 1 from ins where ins.id = l.id)
  )
  select ins.id, ins.lesson_name, ins.description, true from ins
  union all
  select reused.id, reused.lesson_name, reused.description, false from reused;
end;
$$;

COMMENT ON FUNCTION create_lessons_with_segments(jsonb) IS
  'Idempotent per (track_id, lesson_name) since migration 062: inserts new lessons (+1 '
  'segment each) and returns the EXISTING row for any proposal whose name is already live '
  'in that track, flagged created=false. Conflict target is lessons_track_name_active_uq '
  '(061), so ARCHIVED lessons do not block re-creating a title.';

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying. This creates and then rolls back real rows.
--
-- BEGIN;
--   -- pick any live track
--   WITH t AS (SELECT id FROM tracks WHERE archived_at IS NULL LIMIT 1)
--   SELECT * FROM create_lessons_with_segments(
--     jsonb_build_array(jsonb_build_object(
--       'lesson_name','ZZZ Migration 062 Probe','description','probe',
--       'track_id',(SELECT id FROM t)))
--   );
--   -- EXPECT one row, created = true
--
--   WITH t AS (SELECT id FROM tracks WHERE archived_at IS NULL LIMIT 1)
--   SELECT * FROM create_lessons_with_segments(
--     jsonb_build_array(jsonb_build_object(
--       'lesson_name','ZZZ Migration 062 Probe','description','probe again',
--       'track_id',(SELECT id FROM t)))
--   );
--   -- EXPECT one row, SAME id as above, created = false, description = the ORIGINAL
--   -- ('probe', not 'probe again') — proving it did not overwrite.
--
--   -- and exactly ONE segment exists for it (the second call added none):
--   SELECT count(*) FROM segments s JOIN lessons l ON l.id = s.lesson_id
--    WHERE l.lesson_name = 'ZZZ Migration 062 Probe';   -- EXPECT 1
-- ROLLBACK;
-- ============================================================================
