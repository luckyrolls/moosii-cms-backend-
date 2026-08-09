-- ============================================================================
-- Migration 055: card edit attribution — sub_segments actor columns + content_edits
--                append-only edit log + drop three dead columns (via view recreate)
-- ============================================================================
-- APPLIED via the Supabase SQL editor. On the 008..055 reconciliation list. Apply order:
-- after 054 (drop-P0001). Backs PATCH /sub-segments/:id (the approval-integrity edit path).
--
-- WHY. Human card edits went CMS-direct to sub_segments and reset/stamped/logged nothing:
-- an approved segment stayed seg_status='complete' after its content changed, with no
-- timestamp and no actor. The PATCH route stamps + logs + re-gates in one place; this
-- migration adds the columns it writes.
--
-- ACTOR COLUMNS (no FK — deliberate). sub_segments.updated_by / created_by carry NO FK to
-- "user" (matching content_approvals, migration 043), so the audit SURVIVES user deletion.
-- content_edits.actor_id likewise has no FK. created_by is NULLABLE and NULL MEANS
-- AI-GENERATED — no 'ai' sentinel; a backend generate/regen insert leaves it NULL, a
-- human-authored card carries the editor's uuid. Human card CREATION is CMS-direct today
-- (useAddCard), so stamping created_by on creation is a CMS-slice follow-up.
--
-- content_edits: APPEND-ONLY. entity_type is a CHECK enum with ONE value ('sub_segment')
-- so later grains are an explicit constraint change, not free-text drift. `fields` records
-- WHICH fields changed; NO before/after values (volume + privacy decided separately).
--
-- DEAD-COLUMN DROPS — corrected from the original draft. segments.edited / lessons.status /
-- lessons.segment_status were unwritten/unread in BOTH repos' SOURCE, but three DB VIEWS
-- still referenced them (lessons_with_track_name, v_lesson_details,
-- lesson_segment_counts_with_track), so a bare DROP COLUMN would fail. The views are
-- DROP+CREATE'd WITHOUT those columns first (CREATE OR REPLACE cannot remove columns —
-- 42P16), then the columns drop cleanly. View column lists are otherwise identical to the
-- live defs.
-- ============================================================================

BEGIN;

-- 1. sub_segments attribution (actor columns carry NO FK — audit survives user deletion).
ALTER TABLE sub_segments ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE sub_segments ADD COLUMN IF NOT EXISTS updated_by uuid;
ALTER TABLE sub_segments ADD COLUMN IF NOT EXISTS created_by uuid;   -- NULL = AI-generated

-- 2. Append-only edit log.
CREATE TABLE IF NOT EXISTS content_edits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('sub_segment')),
  entity_id   uuid NOT NULL,
  actor_id    uuid NOT NULL,
  actor_role  text NOT NULL,
  fields      text[] NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_edits_entity ON content_edits (entity_type, entity_id);

-- 3. Recreate the three views WITHOUT the dead columns.
--    CREATE OR REPLACE cannot remove columns (42P16), so these are
--    DROP + CREATE. Column lists otherwise identical to the live defs.

DROP VIEW IF EXISTS lessons_with_track_name;
CREATE VIEW lessons_with_track_name AS
 SELECT lessons.created_at,
    lessons.lesson_name,
    lessons.description,
    lessons.image_url,
    lessons."time",
    lessons.article,
    lessons.min_child_age,
    lessons.max_child_age,
    lessons.min_questionnaire_score_range,
    lessons.max_questionnaire_score_range,
    lessons.is_published,
    lessons.id,
    lessons.priority,
    lessons.track_id,
    tracks.track_name
   FROM lessons
     JOIN tracks ON lessons.track_id = tracks.id;

DROP VIEW IF EXISTS v_lesson_details;
CREATE VIEW v_lesson_details AS
 SELECT l.id AS lesson_id,
    l.lesson_name,
    l.description,
    l.image_url,
    l."time",
    l.is_published,
    l.min_child_age,
    l.max_child_age,
    t.id AS track_id,
    t.track_name,
    string_agg(tag.tag_name, ', '::text ORDER BY tag.tag_name) AS tags
   FROM lessons l
     JOIN tracks t ON l.track_id = t.id
     LEFT JOIN lesson_tags lt ON l.id = lt.lesson_id
     LEFT JOIN tags tag ON lt.tag_id = tag.id
  GROUP BY l.id, l.lesson_name, l.description, l.image_url, l."time", l.is_published, l.min_child_age, l.max_child_age, t.id, t.track_name;

DROP VIEW IF EXISTS lesson_segment_counts_with_track;
CREATE VIEW lesson_segment_counts_with_track AS
 SELECT lessons.created_at,
    lessons.lesson_name,
    lessons.description,
    lessons.image_url,
    lessons."time",
    lessons.article,
    lessons.min_child_age,
    lessons.max_child_age,
    lessons.min_questionnaire_score_range,
    lessons.max_questionnaire_score_range,
    lessons.is_published,
    lessons.id,
    lessons.priority,
    lessons.track_id,
    lessons.with_quiz,
    tracks.track_name,
    count(segments.id) AS segment_count
   FROM lessons
     JOIN tracks ON lessons.track_id = tracks.id
     LEFT JOIN segments ON segments.lesson_id = lessons.id
  GROUP BY lessons.id, tracks.track_name;

-- 4. Drop the dead columns, now unreferenced.
ALTER TABLE segments DROP COLUMN IF EXISTS edited;
ALTER TABLE lessons  DROP COLUMN IF EXISTS status;
ALTER TABLE lessons  DROP COLUMN IF EXISTS segment_status;

COMMIT;
