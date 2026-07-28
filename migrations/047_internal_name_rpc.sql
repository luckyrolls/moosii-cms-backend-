-- ============================================================================
-- Migration 047: internal_name — column + backfill + insert RPC (DRAFT)
-- ============================================================================
-- DRAFT — NOT applied by the agent. APPLY VIA THE SUPABASE SQL EDITOR after review;
-- on the 008..047 reconciliation list.
--
-- SCOPE. This file is the COMPLETE, idempotent record of the internal_name change: (1) the
-- `lessons.internal_name` column, (2) its backfill from `lesson_name`, and (3) the insert RPC
-- that persists it. internal_name is a curator catalog handle (searchable — what a lesson
-- COVERS), distinct from the parent-facing `lesson_name`.
--
-- ALREADY LIVE ON THIS DB. The DDL — (1) + (2) — was applied ad-hoc from chat SQL and is already
-- present here: column confirmed, 144 rows backfilled, 0 mismatched. But it had NO migration
-- file, so the schema change was missing from the reconciliation list (the only ledger standing
-- in for schema_migrations here). This file closes that gap. Both DDL statements are GUARDED
-- (`ADD COLUMN IF NOT EXISTS`; `UPDATE … WHERE internal_name IS NULL`), so on THIS DB the file's
-- ONLY effect is the RPC replacement; on a FRESH/rebuilt DB it produces the identical state, and
-- re-running is a no-op. The UPDATE guard is deliberate — NEVER unconditional, so a re-run cannot
-- clobber a real catalog title with the parent-facing name.
--
-- WHAT THE RPC CHANGES. The INSERT column list + value SELECT gain `internal_name`, COALESCEd so
-- the column is ALWAYS populated even while it is still nullable:
--     coalesce(nullif(btrim(l.internal_name), ''), l.lesson_name)
-- absent / NULL / whitespace-only internal_name → falls back to lesson_name. This is what makes
-- a later `ALTER COLUMN internal_name SET NOT NULL` safe (deferred — NOT in this file).
--
-- NO OVERLOAD / NO DROP HAZARD. The function signature is UNCHANGED — it is still
-- `create_lessons_with_segments(p_lessons jsonb)`. internal_name is a FIELD inside each
-- p_lessons jsonb object (populated via jsonb_populate_recordset(null::lessons, …)), NOT a new
-- function parameter — so there is no defaulted-param ambiguity and no DROP is required. Plain
-- CREATE OR REPLACE. The currently-deployed backend (which does not send internal_name) keeps
-- working between apply and deploy: jsonb_populate_recordset yields NULL for the absent key →
-- COALESCE → lesson_name.
--
-- SHARED BY generate_lessons AND coverage-accept — both call this RPC; atomicity and the exact
-- lessons+segments insert behavior (011/010) are preserved verbatim, only the two internal_name
-- lines are added (diff vs migration 044).
-- ============================================================================

BEGIN;

-- (1) Column + (2) backfill. Both GUARDED and already live on this DB (no-op here); on a fresh
-- DB they establish the column and fill it. The UPDATE is guarded WHERE internal_name IS NULL —
-- never unconditional — so re-running never overwrites a real catalog title.
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS internal_name text;
UPDATE lessons SET internal_name = lesson_name WHERE internal_name IS NULL;

-- (3) The insert RPC — the only statement with an effect on this (already-backfilled) DB.
CREATE OR REPLACE FUNCTION create_lessons_with_segments(
  p_lessons jsonb
) RETURNS TABLE (
  id          uuid,
  lesson_name text,
  description text
)
LANGUAGE plpgsql
AS $$
begin
  return query
  -- Insert only the handler-set columns; jsonb_populate_recordset coerces each field to the
  -- real `lessons` column types, so every other column keeps its DB default. internal_name
  -- added in 047 (curator_note 044; band_rationale + safety_sensitive 011; topic_id 010).
  with ins as (
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
    from jsonb_populate_recordset(null::lessons, p_lessons) as l
    returning lessons.id, lessons.lesson_name, lessons.description
  ),
  -- One segment per just-inserted lesson, paired by identity (ins.id) — NOT by a lesson_name
  -- match. This CTE executes even though the final SELECT does not read it: Postgres runs every
  -- data-modifying WITH clause exactly once.
  seg as (
    insert into segments (lesson_id, segment_name, description)
    select ins.id, ins.lesson_name, ins.description
    from ins
    returning segments.id
  )
  select ins.id, ins.lesson_name, ins.description
  from ins;
end;
$$;

COMMIT;
