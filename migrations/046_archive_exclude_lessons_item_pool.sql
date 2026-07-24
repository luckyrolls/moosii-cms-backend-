-- ============================================================================
-- Migration 046: exclude ARCHIVED lessons from the MLP item pool (lesson arm)
-- ============================================================================
-- New nullable column lessons.archived_at (applied separately). Non-null = archived.
--
-- Migration 045 handles TRACK-level archival (an archived track drops from the active
-- set, so ALL its lessons + host questionnaires vanish from every plan). This migration
-- handles the other half of the derived rule: an INDIVIDUAL lesson archived inside a
-- still-LIVE track. mlp_item_pool is the item source loadUserMlpInputs reads, so adding
-- `WHERE l.archived_at IS NULL` to the lesson arm removes an archived lesson from every
-- user's candidate pool on recompute.
--
-- Together with 045 this implements: a lesson is effective-archived if lessons.archived_at
-- IS NOT NULL OR its track's archived_at IS NOT NULL — DERIVED, never stamped.
--
-- The questionnaire arm is unchanged: questionnaires carry no archived_at, so their
-- archival is purely track-derived (handled by 045 — a questionnaire surfaces only via its
-- host track q.track_id, which 045 drops when archived).
--
-- Body is byte-identical to migration 041 EXCEPT the one added WHERE on the lesson arm.
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..046 reconciliation list. Apply after 045.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.mlp_item_pool AS
 SELECT l.id AS item_id,
    'lesson'::text AS item_type,
    l.track_id,
    l.priority,
    l.lesson_name AS item_name,
    l.description AS item_description,
    l.min_child_age,
    l.max_child_age,
    l.is_published,
    l.with_quiz
   FROM lessons l
  WHERE l.archived_at IS NULL          -- ADDED (046): archived lessons are invisible to parents
UNION ALL
 SELECT q.id AS item_id,
    'questionnaire'::text AS item_type,
    q.track_id,
    q.priority,
    q.questionnaire_name AS item_name,
    q.description AS item_description,
    q.age AS min_child_age,            -- from 041 (age gate)
    NULL::integer AS max_child_age,
    q.is_published,
    q.with_quiz
   FROM questionnaire q;

COMMIT;
