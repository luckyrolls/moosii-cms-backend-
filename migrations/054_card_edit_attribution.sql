-- ============================================================================
-- Migration 054: card edit attribution — sub_segments actor columns + content_edits
--                append-only edit log + drop three confirmed-dead columns (DRAFT)
-- ============================================================================
-- DRAFT — NOT applied by the agent. APPLY VIA THE SUPABASE SQL EDITOR after review;
-- on the 008..054 reconciliation list. Apply order: after 053. Single migration.
--
-- WHY. Human card edits went CMS-direct to sub_segments and reset/stamped/logged nothing:
-- an approved segment stayed seg_status='complete' after its content changed, with no
-- timestamp and no actor. Slice 1 moves card edits behind PATCH /sub-segments/:id, which
-- stamps + logs + re-gates in one place; this migration adds the columns that route writes.
--
-- ACTOR COLUMNS (no FK — deliberate). sub_segments.updated_by / created_by carry NO foreign
-- key to "user", matching content_approvals (migration 043), so the audit SURVIVES user
-- deletion. content_edits.actor_id likewise has no FK.
--
-- created_by SEMANTICS: NULLABLE, and NULL MEANS AI-GENERATED. Do NOT invent an 'ai'
-- sentinel actor — the row's provenance already carries the machine story (a backend
-- generate/regen insert leaves created_by NULL; a human-authored card carries the editor's
-- uuid). Human card CREATION is CMS-direct today (useAddCard), so stamping created_by on
-- creation is a CMS-slice follow-up; this migration only adds the column.
--
-- content_edits: APPEND-ONLY edit log. entity_type is a CHECK enum with ONE value today
-- ('sub_segment') so later grains (segment/lesson/track) are an explicit constraint change,
-- not free-text drift. No update/delete path. `fields` records WHICH fields changed; this
-- slice deliberately does NOT store before/after values (volume + privacy decided separately).
--
-- DEAD-COLUMN DROPS (all verified UNWRITTEN and UNREAD in BOTH repos — backend + CMS):
--   * segments.edited          (boolean; nothing writes or reads it)
--   * lessons.status           (BuildShip-era; dead)
--   * lessons.segment_status   (BuildShip-era; dead)
-- The only live `.status` references are jobs.status / content_images.status (unrelated).
-- ============================================================================

BEGIN;

-- 1. sub_segments attribution (actor columns carry NO FK — audit survives user deletion).
ALTER TABLE sub_segments ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE sub_segments ADD COLUMN IF NOT EXISTS updated_by uuid;
ALTER TABLE sub_segments ADD COLUMN IF NOT EXISTS created_by uuid;   -- NULL = AI-generated

-- 2. Append-only edit log.
CREATE TABLE IF NOT EXISTS content_edits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('sub_segment')),  -- one value today; widen deliberately
  entity_id   uuid NOT NULL,          -- no FK: audit survives entity deletion
  actor_id    uuid NOT NULL,          -- no FK: audit survives user deletion
  actor_role  text NOT NULL,
  fields      text[] NOT NULL,        -- which fields changed (no before/after values in this slice)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_edits_entity ON content_edits (entity_type, entity_id);

-- 3. Drop three confirmed-dead columns (unwritten + unread in both repos).
ALTER TABLE segments DROP COLUMN IF EXISTS edited;
ALTER TABLE lessons  DROP COLUMN IF EXISTS status;
ALTER TABLE lessons  DROP COLUMN IF EXISTS segment_status;

COMMIT;
