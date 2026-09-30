-- ============================================================================
-- MIGRATION 107: lessons.kind ('lesson' | 'activity') — BOTH PROJECTS (schema + RPC)
--   — APPLIED financial 2026-09-30 · APPLIED Moosii 2026-09-30   (106 stays reserved for demo_outcome_series)
-- ============================================================================
-- WHY (FINDINGS-activities; Mark 2026-09-30): the plan should recommend things to DO. An activity is a
-- lesson with kind = 'activity', so the MLP, pool, approvals, publishing, archival and images are unchanged.
--
-- WHAT:
--   1. lessons.kind text NOT NULL DEFAULT 'lesson' + CHECK (kind IN ('lesson','activity')). Existing rows → 'lesson'.
--   2. create_lessons_with_segments: `kind` added to the explicit insert list as coalesce(l.kind,'lesson'), so a
--      caller that sends no kind (generate_lessons, POST /lessons/accept) behaves exactly as before. Insert-or-
--      select semantics (invariant 9) and the return type are unchanged → CREATE OR REPLACE (ACL kept). Hash-
--      guarded: refuses unless the live body is 067's text (md5 a251abfb…, CR-stripped).
--   3. financial only: GRANT SELECT (kind) ON lessons TO anon (the reader reads lessons through column grants,
--      096/097). Moosii has no anon reader.
-- NOT CHANGED — deliberately: mlp_item_pool (explicit column list; kind stays OUT), user_mlp, generateFullMLP /
-- computeUserMlp, user_active_tracks_for_user (invariants 1, 8). Clients read lessons.kind by lesson id.
-- BOTH PROJECTS: one schema (invariant 4). Idempotent: ADD COLUMN IF NOT EXISTS, constraint added only if missing,
-- the function guard accepts the already-new body.
-- APPLY per migrations/README.md: financial first, then Moosii. Then regenerate database.types.ts (Moosii).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT no kind column; md5 a251abfb0d1ab466083c5247dafe21ce:
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'lessons' AND column_name = 'kind';
--   SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE proname = 'create_lessons_with_segments';
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE public.lessons ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'lesson';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lessons_kind_valid' AND conrelid = 'public.lessons'::regclass) THEN
    ALTER TABLE public.lessons ADD CONSTRAINT lessons_kind_valid CHECK (kind IN ('lesson', 'activity'));
  END IF;
END $$;

DO $$ DECLARE cur text; BEGIN
  SELECT md5(replace(prosrc, chr(13), '')) INTO cur FROM pg_proc WHERE oid = 'public.create_lessons_with_segments(jsonb)'::regprocedure;
  IF cur <> 'a251abfb0d1ab466083c5247dafe21ce' AND cur <> 'd7ae90fb94ade3f6151bc7f28dbfd56b' THEN
    RAISE EXCEPTION '107: create_lessons_with_segments body md5 % is neither 067''s nor 107''s — re-base before applying', cur;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.create_lessons_with_segments(p_lessons jsonb)
 RETURNS TABLE(id uuid, lesson_name text, description text, created boolean)
 LANGUAGE plpgsql
AS $function$
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
      band_rationale, safety_sensitive, curator_note, internal_name,
      kind                                                   -- ADDED (107)
    )
    select
      l.lesson_name, l.description, l.min_child_age, l.max_child_age,
      l.priority, l.track_id, l.topic_id, l.created_by,
      l.band_rationale, coalesce(l.safety_sensitive, false), l.curator_note,
      -- always populated: verbatim internal_name when supplied, else the parent-facing name.
      coalesce(nullif(btrim(l.internal_name), ''), l.lesson_name),
      coalesce(l.kind, 'lesson')                             -- ADDED (107): absent → 'lesson'
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
$function$
;

DO $$ BEGIN
  IF (SELECT value FROM app_settings WHERE key = 'domain') = 'financial' THEN
    GRANT SELECT (kind) ON public.lessons TO anon;
  END IF;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION:
-- 1. kind column: text, NOT NULL, default 'lesson'; lessons_kind_valid present; every existing row = 'lesson'.
-- 2. Function md5 = 107's (d7ae90fb94ade3f6151bc7f28dbfd56b); rolled back: the RPC with {kind:'activity'} creates kind='activity', without kind → 'lesson';
--    {kind:'bogus'} → 23514.
-- 3. mlp_item_pool has no kind column. Financial: has_column_privilege('anon','lessons','kind','SELECT') = true.
-- ---------------------------------------------------------------------------
