-- ============================================================================
-- Migration 034: backfill questionnaire.priority (NULL → target track priority)
-- ============================================================================
-- Generated questionnaires never got a priority. questionnaire.priority is the MLP
-- pool item priority (mlp_item_pool reads it directly), and the ranking orders items
-- within a host track by priority ASCENDING (lower = sooner; NULL → 9999 = bottom).
-- So every NULL-priority questionnaire was systematically sorted to the bottom of its
-- host track — recruiters buried under all prioritized lessons.
--
-- Ruling: a questionnaire's priority is COPIED from its TARGET track (the track its
-- add-rule activates) at generation. This backfills the existing rows to match. It is
-- a COPIED value, not a live reference — later track-priority edits must NOT reshuffle
-- existing questionnaires, so this is a one-time UPDATE, not a view/trigger.
--
-- Scale check (why inheriting a track priority into an item-priority slot is sound):
-- track priorities span ~10–850, lesson item priorities cluster ~100–220 — same
-- direction, same magnitude. A target track priority sits sensibly among lessons.
--
-- Only NULL rows are touched (already-set questionnaires keep their value). Statement 1
-- inherits via the add-rule target (COALESCE fallback if the target track's priority is
-- itself NULL). Statement 2 catches any remaining NULLs (no add-rule target at all) with
-- the same constant. Fallback 500 = neutral mid-scale, matching
-- QUESTIONNAIRE_DEFAULT_PRIORITY in generateQuestionnaire.ts. NEVER leaves NULL.
--
-- No schema change (priority column already exists) → no database.types.ts regen needed.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..034 reconciliation list.
-- (032 remains reserved for the user_track_matches/column-drop migration, tracked
-- separately — the list may have that hole.)
-- ============================================================================

BEGIN;

-- 1. Inherit the TARGET track's priority (one target per questionnaire, deterministic
--    pick if somehow >1 add-rule). COALESCE handles a target track with NULL priority.
UPDATE questionnaire q
SET priority = COALESCE(t.priority, 500)
FROM (
  SELECT DISTINCT ON (qr.questionnaire_id) qr.questionnaire_id, qr.track_id
  FROM questionnaire_response qr
  WHERE qr.add = true AND qr.track_id IS NOT NULL
  ORDER BY qr.questionnaire_id, qr.created_at
) rule
JOIN tracks t ON t.id = rule.track_id
WHERE q.id = rule.questionnaire_id
  AND q.priority IS NULL;

-- 2. Any questionnaire STILL NULL (no add-rule target) → the same constant fallback.
UPDATE questionnaire
SET priority = 500
WHERE priority IS NULL;

COMMIT;
