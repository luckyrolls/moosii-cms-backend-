-- ============================================================================
-- Migration 010: create_lessons_with_segments() — atomic lesson+segment insert
-- ============================================================================
-- generateLessons previously inserted the lesson batch and then the segments as
-- two separate Supabase writes. A failure between them left orphaned lessons
-- with no segments. This function does both inserts in ONE statement (a single
-- data-modifying CTE = one transaction): the whole batch lands together, or
-- nothing does.
--
-- Numbered 010, NOT 008: the demographic rule system (008, 009) was applied
-- directly to the live DB via the Supabase SQL editor, so it is in the database
-- but absent from this folder and (likely) from supabase_migrations. Neither the
-- migrations folder nor schema_migrations is a reliable high-water mark, so 008
-- only LOOKS free. This migration depends on none of that work (lessons and
-- segments predate all of it) and applies cleanly.
--
-- SECURITY INVOKER (the default): runs with the caller's privileges. The backend
-- calls it as the service role, so it bypasses RLS exactly as the two direct
-- inserts did — zero RLS delta. Do NOT add SECURITY DEFINER.
-- ============================================================================

create or replace function create_lessons_with_segments(
  p_lessons jsonb
) returns table (
  id          uuid,
  lesson_name text,
  description text
)
language plpgsql
as $$
begin
  return query
  -- Insert only the 8 columns the handler sets; jsonb_populate_recordset coerces
  -- each field to the real `lessons` column types, so every other column keeps
  -- its DB default (abbreviated_title, with_quiz, quiz_onboarding_*, etc.).
  with ins as (
    insert into lessons (
      lesson_name, description, min_child_age, max_child_age,
      priority, track_id, topic_id, created_by
    )
    select
      l.lesson_name, l.description, l.min_child_age, l.max_child_age,
      l.priority, l.track_id, l.topic_id, l.created_by
    from jsonb_populate_recordset(null::lessons, p_lessons) as l
    returning lessons.id, lessons.lesson_name, lessons.description
  ),
  -- One segment per just-inserted lesson, paired by identity (ins.id) — NOT by a
  -- lesson_name match, which mis-pairs when two lessons in a batch share a name.
  -- This CTE executes even though the final SELECT does not read it: Postgres
  -- runs every data-modifying WITH clause exactly once, to completion.
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
