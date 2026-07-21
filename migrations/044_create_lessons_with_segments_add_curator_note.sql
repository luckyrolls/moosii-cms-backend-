-- ============================================================================
-- Migration 044 (main track): persist curator_note in create_lessons_with_segments
-- ============================================================================
-- lessons.curator_note (nullable text) already exists (column migration applied
-- separately). This teaches the insert RPC to carry it through — curation metadata
-- for CMS reviewers, NEVER parent-facing, and the AI never writes it (no prompt path
-- sets it). The RPC now persists curator_note WHEN the p_lessons payload includes the
-- key, and inserts NULL when it does not. NOTE: no generation path supplies it today,
-- and the coverage-accept handler's row whitelist does not currently forward it — so
-- this migration makes the insert CAPABLE of curator_note; it is otherwise written by
-- a separate CMS curation update.
--
-- APPLIED VIA THE SUPABASE SQL EDITOR — not in supabase_migrations.schema_
-- migrations; on the 008..044 files-vs-DB reconciliation list.
--
-- Function change ONLY adds curator_note to the INSERT column list and the value
-- SELECT (same pattern as 011's band_rationale/safety_sensitive additions). Same
-- signature (p_lessons jsonb), same RETURNS TABLE shape, SECURITY INVOKER, same
-- single-statement data-modifying CTE, same positional segment pairing. Unlike
-- safety_sensitive there is NO coalesce: curator_note is plain nullable, so an
-- absent key yields NULL from jsonb_populate_recordset and inserts NULL — exactly
-- the intended default.
-- ============================================================================

BEGIN;

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
  -- Insert only the handler-set columns; jsonb_populate_recordset coerces each
  -- field to the real `lessons` column types, so every other column keeps its
  -- DB default. curator_note added in 044 (band_rationale + safety_sensitive from
  -- 011, topic_id from 010).
  with ins as (
    insert into lessons (
      lesson_name, description, min_child_age, max_child_age,
      priority, track_id, topic_id, created_by,
      band_rationale, safety_sensitive, curator_note
    )
    select
      l.lesson_name, l.description, l.min_child_age, l.max_child_age,
      l.priority, l.track_id, l.topic_id, l.created_by,
      l.band_rationale, coalesce(l.safety_sensitive, false), l.curator_note
    from jsonb_populate_recordset(null::lessons, p_lessons) as l
    returning lessons.id, lessons.lesson_name, lessons.description
  ),
  -- One segment per just-inserted lesson, paired by identity (ins.id) — NOT by a
  -- lesson_name match. This CTE executes even though the final SELECT does not
  -- read it: Postgres runs every data-modifying WITH clause exactly once.
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
