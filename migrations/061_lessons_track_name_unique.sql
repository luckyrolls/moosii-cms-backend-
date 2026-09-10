-- ============================================================================
-- Migration 061: partial unique index on lessons (track_id, lesson_name) (APPLIED 2026-09-10)
-- ============================================================================
-- FROM: FINDINGS-catalog-integrity.md §C. Makes duplicate lessons IMPOSSIBLE rather than
-- merely discouraged. Until now the only protection anywhere was a sentence in an LLM
-- prompt ("do not duplicate or closely overlap these"); the write path itself was an
-- unconditional INSERT (§B).
--
-- SCOPED TO THE TRACK, NOT GLOBAL. The same title legitimately exists in two DIFFERENT
-- tracks today — "Adapting Routines for a Mobile Baby" in both "Baby Is Crawling" and
-- "First Steps and Walking" (1 case in 153 lessons). A global unique on lesson_name would
-- forbid that authoring pattern permanently in order to catch collisions a narrower key
-- already catches. A track is a curricular context; the same title in a Sleep track and a
-- Newborn track is a reasonable thing to want.
--
-- PARTIAL ON archived_at IS NULL. Archival is the shelve-without-deleting mechanism
-- (invariant 6). A shelved lesson must not hold its title hostage — the whole point of
-- archiving a weak lesson is to write a better one under the same name. This is also what
-- lets migration 060 resolve the existing duplicates by ARCHIVING rather than deleting.
--
-- ⚠ APPLY 060 FIRST. All seven duplicate rows currently have archived_at IS NULL, so this
-- index CANNOT be created until 060 has archived the losers. Running it early fails with
-- "could not create unique index … Key (track_id, lesson_name)=(…) is duplicated".
--
-- THIS INDEX IS MIGRATION 062'S CONFLICT TARGET. The RPC's
-- `ON CONFLICT (track_id, lesson_name) WHERE archived_at IS NULL` infers THIS index by
-- matching both the column list and the predicate. Change either here and 062 stops
-- compiling — they are one unit.
--
-- NOT ADDRESSED HERE (deliberate): lessons.lesson_name is NULLABLE, and a unique index
-- treats NULLs as distinct, so any number of unnamed lessons stay legal. Whether to
-- ALTER COLUMN lesson_name SET NOT NULL is a separate decision; nothing in this file
-- depends on it.
--
-- FINANCIAL PROJECT: inherits this via the schema dump. It has no lessons yet, so the
-- index is created empty and simply enforces the rule from the start.
--
-- APPLIED VIA THE SUPABASE SQL EDITOR (2026-09-10) — on the 008..061 reconciliation list,
-- after 060. Idempotent: IF NOT EXISTS.
--
-- NOTE ON HOW IT WAS RUN: the original draft used CREATE INDEX CONCURRENTLY, which CANNOT
-- run inside a transaction block — and the Supabase SQL editor wraps every statement it
-- sends in one. It was therefore applied WITHOUT CONCURRENTLY, inside BEGIN/COMMIT, and
-- this file has been rewritten to match what actually ran. At 153 rows the locking build is
-- instantaneous. See the standing rule now in migrations/README.md: no CONCURRENTLY in
-- editor-applied migrations.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST. MUST RETURN ZERO ROWS. Any row is a live collision that
-- would make the CREATE INDEX below fail; resolve it (archive the loser, as 060
-- does) before continuing.
-- ---------------------------------------------------------------------------
-- SELECT track_id, lesson_name, count(*) AS rows, array_agg(id) AS ids
--   FROM lessons
--  WHERE archived_at IS NULL
--  GROUP BY track_id, lesson_name
-- HAVING count(*) > 1;

BEGIN;

-- Plain (locking) build, deliberately — see the note above. It takes an ACCESS EXCLUSIVE
-- lock on `lessons` for the duration, which at this size is milliseconds.
CREATE UNIQUE INDEX IF NOT EXISTS lessons_track_name_active_uq
  ON public.lessons (track_id, lesson_name)
  WHERE archived_at IS NULL;

COMMENT ON INDEX public.lessons_track_name_active_uq IS
  'Migration 061: one live lesson per (track, name). Partial on archived_at IS NULL so an '
  'archived lesson frees its title. Conflict target for create_lessons_with_segments (062).';

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying.
--
-- 1. The index exists with the right shape:
--    SELECT i.indexrelid::regclass AS index, i.indisvalid, i.indisunique,
--           pg_get_expr(i.indpred, i.indrelid) AS predicate
--      FROM pg_index i
--     WHERE i.indexrelid = 'lessons_track_name_active_uq'::regclass;
--    -- EXPECT indisvalid = true, indisunique = true, predicate = (archived_at IS NULL)
--    -- (A non-concurrent build either commits or rolls back, so it cannot leave an INVALID
--    -- index the way a failed CONCURRENTLY build can.)
--
-- 2. It actually bites (this INSERT must fail with 23505 unique_violation):
--    INSERT INTO lessons (lesson_name, track_id)
--    SELECT lesson_name, track_id FROM lessons WHERE archived_at IS NULL LIMIT 1;
--
-- 3. It does NOT bite on archived rows (this must SUCCEED, then roll it back):
--    BEGIN;
--      INSERT INTO lessons (lesson_name, track_id, archived_at)
--      SELECT lesson_name, track_id, now() FROM lessons WHERE archived_at IS NULL LIMIT 1;
--    ROLLBACK;
-- ============================================================================

-- ============================================================================
-- CONFIRMED LIVE 2026-09-10 (read-only probe): the three 060 losers are archived, the two
-- keepers are not, there are ZERO (track_id, lesson_name) collisions among non-archived
-- lessons, and a duplicate INSERT is refused with 23505 naming
-- "lessons_track_name_active_uq". The index is enforcing.
-- ============================================================================
