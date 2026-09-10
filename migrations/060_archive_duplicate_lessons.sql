-- ============================================================================
-- Migration 060: archive the duplicate lesson losers (APPLIED 2026-09-10)
-- ============================================================================
-- FROM: FINDINGS-catalog-integrity.md §A. Three lesson_name groups hold duplicate rows
-- created by repeated generate_lessons / coverage-accept runs (root cause: §B, fixed by
-- migration 062).
--
-- ARCHIVE, NOT DELETE (decided). archived_at is the shelve-without-destroying mechanism
-- (CLAUDE.md invariant 6): non-null = invisible to parents, derived, reversible with a
-- single UPDATE. It also PRESERVES the three approved quiz questions on 68a7b180, which a
-- delete would have destroyed — that was the open risk in the findings and archiving
-- removes it entirely.
--
-- ⚠ APPLY ORDER — THIS FILE MUST GO FIRST, BEFORE 061.
-- The brief listed the unique index first, but that ORDER CANNOT WORK: all seven duplicate
-- rows currently have archived_at IS NULL, so `CREATE UNIQUE INDEX … WHERE archived_at IS
-- NULL` (061) fails with "could not create unique index … Key (track_id, lesson_name) is
-- duplicated" until these rows are archived. Archiving is what makes 061 appliable.
--
-- WHAT IS ARCHIVED (3 rows) and WHAT IS KEPT:
--   Safe Sleep Setup for Newborns (track "New Parents") — keep b6e7628b (9 cards, 4 images)
--     · 68a7b180 — 0 cards, 3 approved quiz questions (PRESERVED by archiving)
--     · 2421cb61 — 9 draft cards, no images, 0 approved questions
--   Newborn Bathing Basics (track "New Parents") — keep 7dae9e3e (8 cards, all with images)
--     · 4d7af074 — 7 draft cards, no images
--
-- NOT TOUCHED (decided): the "Adapting Routines for a Mobile Baby" pair (9ee5ffa0 /
-- bded750f). Those two live in DIFFERENT tracks, so they are not duplicates under the 061
-- key and never collided. Both are left exactly as they are.
--
-- SAFETY: all three rows are unpublished, sit in already-archived tracks, and have ZERO
-- user-facing references (no user_mlp, completed_items, starred_items, user_lesson_progress
-- — verified live 2026-09-10). Nothing a parent can see changes.
--
-- REVERSIBLE: `UPDATE lessons SET archived_at = NULL WHERE id = '<id>';` — but note that
-- un-archiving a row whose name is taken by a live sibling will then violate 061.
--
-- FINANCIAL PROJECT: inherits this via the schema dump. The three ids below do not exist
-- there, so the UPDATE matches zero rows and is a harmless no-op.
--
-- APPLIED VIA THE SUPABASE SQL EDITOR (2026-09-10) — on the 008..060 reconciliation list.
-- Idempotent: the guard `WHERE archived_at IS NULL` makes a re-run a no-op and never
-- re-stamps the date.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST. Expect exactly the 7 rows below, with archived_at NULL
-- and the keep/archive split as described. If a row is missing or already
-- archived, stop and re-read §A before continuing.
-- ---------------------------------------------------------------------------
-- SELECT l.id, l.lesson_name, t.track_name, l.is_published, l.archived_at,
--        (SELECT count(*) FROM segments s WHERE s.lesson_id = l.id)      AS segs,
--        (SELECT count(*) FROM sub_segments ss
--           JOIN segments s2 ON s2.id = ss.seg_id WHERE s2.lesson_id = l.id) AS cards,
--        (SELECT count(*) FROM quiz_questions q
--           JOIN segments s3 ON s3.id = q.segment_id
--          WHERE s3.lesson_id = l.id AND q.answer_status = 'approved')   AS approved_q
--   FROM lessons l LEFT JOIN tracks t ON t.id = l.track_id
--  WHERE l.lesson_name IN ('Safe Sleep Setup for Newborns',
--                          'Newborn Bathing Basics',
--                          'Adapting Routines for a Mobile Baby')
--  ORDER BY l.lesson_name, l.created_at;

BEGIN;

-- Safe Sleep Setup for Newborns — archive two, keep b6e7628b.
UPDATE lessons SET archived_at = now()
 WHERE id = '68a7b180-201c-40b7-9007-7f4d8be2ef04' AND archived_at IS NULL;
UPDATE lessons SET archived_at = now()
 WHERE id = '2421cb61-e3a5-4b91-8fd6-698bf53b57f7' AND archived_at IS NULL;

-- Newborn Bathing Basics — archive one, keep 7dae9e3e.
UPDATE lessons SET archived_at = now()
 WHERE id = '4d7af074-a78e-4981-9061-c9bb04babce4' AND archived_at IS NULL;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying.
--
-- 1. The three losers are archived, the two keepers are not:
--    SELECT id, lesson_name, archived_at IS NOT NULL AS archived
--      FROM lessons
--     WHERE id IN ('68a7b180-201c-40b7-9007-7f4d8be2ef04',   -- expect archived = true
--                  '2421cb61-e3a5-4b91-8fd6-698bf53b57f7',   -- expect archived = true
--                  '4d7af074-a78e-4981-9061-c9bb04babce4',   -- expect archived = true
--                  'b6e7628b-b73a-4ed3-98a8-1ca758d33e39',   -- expect archived = false
--                  '7dae9e3e-e760-4b07-bacf-af178dd59c9d');  -- expect archived = false
--
-- 2. 061's precondition now holds — EXPECT ZERO ROWS:
--    SELECT track_id, lesson_name, count(*)
--      FROM lessons WHERE archived_at IS NULL
--     GROUP BY track_id, lesson_name HAVING count(*) > 1;
--
-- 3. The preserved quiz is still there (this is why we archived rather than deleted):
--    SELECT count(*) FROM quiz_questions q
--      JOIN segments s ON s.id = q.segment_id
--     WHERE s.lesson_id = '68a7b180-201c-40b7-9007-7f4d8be2ef04'
--       AND q.answer_status = 'approved';   -- EXPECT 3
-- ============================================================================

-- ============================================================================
-- CONFIRMED LIVE 2026-09-10 (read-only probe): 68a7b180, 2421cb61 and 4d7af074 all carry a
-- non-null archived_at; the keepers b6e7628b and 7dae9e3e do not. Zero (track_id,
-- lesson_name) collisions remain among non-archived lessons, which is what let 061 build.
-- ============================================================================
