-- ============================================================================
-- Migration 067: FIX create_lessons_with_segments — 42702 ambiguous lesson_name (DRAFT)
-- ============================================================================
-- ⚠ URGENT. Migration 062 as applied is BROKEN: every call to
-- create_lessons_with_segments raises
--   ERROR 42702: column reference "lesson_name" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
-- so BOTH lesson-creation paths — the `generate_lessons` job and
-- POST /lessons/coverage-accept — fail on every call until this is applied.
-- Confirmed live 2026-09-11 by calling the RPC. Nothing is corrupted: the statement aborts
-- before writing, so no lesson row, no segment row, and no overwrite of an existing lesson.
--
-- ── THE CAUSE ───────────────────────────────────────────────────────────────
-- `RETURNS TABLE (id, lesson_name, description, created)` puts those four names in scope as
-- PL/pgSQL variables for the whole body. 062 added
--     on conflict (track_id, lesson_name) where archived_at is null do nothing
-- and an ON CONFLICT inference specification takes UNQUALIFIED column names — table
-- qualification is not allowed there. `lesson_name` therefore matches both the OUT parameter
-- and the target column, and PL/pgSQL refuses to guess. (`track_id` and `archived_at` are
-- fine: no OUT parameter shares those names.) Everything else in the body is already
-- qualified with `l.` / `ins.` / `lessons.`, which is why the 047 version never hit this —
-- it had no ON CONFLICT clause at all.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- `#variable_conflict use_column` as the first line of the body: where a name is ambiguous,
-- resolve it to the COLUMN. The body never reads the OUT parameters (it is one `return
-- query`), so nothing else changes meaning. The alternative — renaming the OUT parameters —
-- was REJECTED: those names are the JSON keys PostgREST returns, so renaming them would
-- break every caller reading `lesson_name`.
--
-- CREATE OR REPLACE IS CORRECT HERE, unlike 062. The return type is unchanged from the
-- applied 062 (same four columns, same types, same order), so the 42P13 restriction that
-- forced 062's DROP + CREATE does not apply. No DROP, so no privileges are discarded.
--
-- THE BODY IS 062'S, VERBATIM, plus that one directive line. Nothing else was touched.
--
-- FINANCIAL PROJECT: inherits this via the schema dump.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..067 reconciliation list, immediately.
-- Idempotent: CREATE OR REPLACE.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST. Reproduces the break, so the fix is provably the thing that
-- cleared it. Substitute any live lesson's name and its track:
--   SELECT * FROM create_lessons_with_segments(
--     jsonb_build_array(jsonb_build_object(
--       'lesson_name', (SELECT lesson_name FROM lessons WHERE archived_at IS NULL LIMIT 1),
--       'track_id',    (SELECT track_id    FROM lessons WHERE archived_at IS NULL LIMIT 1))));
--   -- EXPECT 42702 before this migration; one row with created=false after it.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE FUNCTION public.create_lessons_with_segments(
  p_lessons jsonb
) RETURNS TABLE (
  id          uuid,
  lesson_name text,
  description text,
  created     boolean   -- ADDED (062): true = inserted by this call, false = already existed
)
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
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
  '(061). Migration 067 added #variable_conflict use_column — the ON CONFLICT inference '
  'takes unqualified column names, which collide with the RETURNS TABLE parameters.';

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying. Nothing here writes a row that survives.
--
-- 1. The call that was raising 42702 now succeeds and returns the EXISTING row:
--    SELECT * FROM create_lessons_with_segments(
--      jsonb_build_array(jsonb_build_object(
--        'lesson_name', (SELECT lesson_name FROM lessons WHERE archived_at IS NULL LIMIT 1),
--        'track_id',    (SELECT track_id    FROM lessons WHERE archived_at IS NULL LIMIT 1),
--        'description', 'PROBE — must not be written')));
--    -- EXPECT one row, created = false, id = the existing lesson.
--
-- 2. It did NOT overwrite (DO NOTHING, never DO UPDATE) and inserted nothing:
--    SELECT description FROM lessons WHERE archived_at IS NULL LIMIT 1;  -- the ORIGINAL text
--    SELECT count(*) FROM lessons;    -- unchanged
--    SELECT count(*) FROM segments;   -- unchanged
--
-- 3. A genuinely NEW name still creates — roll it back:
--    BEGIN;
--      SELECT * FROM create_lessons_with_segments(
--        jsonb_build_array(jsonb_build_object(
--          'lesson_name','ZZZ Migration 067 Probe',
--          'track_id',(SELECT id FROM tracks WHERE archived_at IS NULL LIMIT 1))));
--      -- EXPECT one row, created = true
--    ROLLBACK;
--
-- 4. Same name twice in ONE call yields ONE row (the DISTINCT ON path):
--    BEGIN;
--      SELECT count(*) FROM create_lessons_with_segments(
--        jsonb_build_array(
--          jsonb_build_object('lesson_name','ZZZ 067 Dup','track_id',(SELECT id FROM tracks WHERE archived_at IS NULL LIMIT 1)),
--          jsonb_build_object('lesson_name','ZZZ 067 Dup','track_id',(SELECT id FROM tracks WHERE archived_at IS NULL LIMIT 1))));
--      -- EXPECT 1
--    ROLLBACK;
-- ============================================================================
