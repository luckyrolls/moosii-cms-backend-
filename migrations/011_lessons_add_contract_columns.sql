-- ============================================================================
-- Migration 011 (main track): persist band_rationale + safety_sensitive on lessons
-- ============================================================================
-- Extends lessons with the two remaining lesson-contract columns and updates
-- create_lessons_with_segments to insert them. topic_id already persists (010).
--
-- APPLIED VIA THE SUPABASE SQL EDITOR — not in supabase_migrations.schema_
-- migrations; on the 008/009/010/011 files-vs-DB reconciliation list.
--
-- Function changes ONLY add the two columns to the INSERT/SELECT lists. Same
-- signature (p_lessons jsonb), same return shape, SECURITY INVOKER, same
-- single-statement data-modifying CTE, same positional segment pairing as 010.
-- safety_sensitive is coalesced to false because it is NOT NULL and
-- jsonb_populate_recordset yields NULL for an omitted key (the column DEFAULT
-- does not apply when a value is explicitly supplied).
-- ============================================================================

BEGIN;

ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS safety_sensitive boolean NOT NULL DEFAULT false;

ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS band_rationale text;

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
  -- DB default. band_rationale + safety_sensitive added in 011 (topic_id from 010).
  with ins as (
    insert into lessons (
      lesson_name, description, min_child_age, max_child_age,
      priority, track_id, topic_id, created_by,
      band_rationale, safety_sensitive
    )
    select
      l.lesson_name, l.description, l.min_child_age, l.max_child_age,
      l.priority, l.track_id, l.topic_id, l.created_by,
      l.band_rationale, coalesce(l.safety_sensitive, false)
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
