-- ============================================================================
-- Migration 063: lessons.with_quiz becomes DERIVED (trigger + backfill) (DRAFT)
-- ============================================================================
-- FROM: FINDINGS-catalog-integrity.md §D. `with_quiz` was never an authored flag: no code
-- in the backend has ever written it on a lesson, create_lessons_with_segments leaves it at
-- its column DEFAULT, and all 153 rows are `true`. Nothing could ever make it false. The
-- app reads it to decide whether to offer a quiz, so a lesson with no approved questions
-- still advertises one — the documented "app showed no questions" failure.
--
-- DERIVE IT, DO NOT GUARD IT (decided). A publish-time guard would only check one
-- transition; deriving removes the drift class entirely.
--
-- ── THE DEFINITION IS THE APP'S READ PATH, COPIED EXACTLY ────────────────────
-- Transcribed from moosii-rn (read 2026-09-10):
--   src/hooks/useLesson.ts — segments .eq('lesson_id') .eq('seg_status','complete')
--                            .order('segment_order', {ascending:true}) → takes [0]
--   src/hooks/useQuiz.ts   — quiz_questions .eq('segment_id', <that segment>)
--                            .eq('answer_status','approved')
-- So: with_quiz = "an approved question exists on the FIRST complete segment by
-- segment_order". Two consequences worth stating, because both are easy to get wrong:
--   * segment_id ONLY. The app never filters quiz_questions by lesson_id, so neither do we.
--     (Verified live: zero lessons have approved questions linked by lesson_id alone, so
--     this costs nothing today and matching the app is what keeps it honest.)
--   * NULLS LAST. PostgREST's `.order(col, {ascending:true})` is plain `ORDER BY col ASC`,
--     and Postgres sorts NULLs LAST on ASC. The function below spells that out so the two
--     cannot drift.
--
-- ⚠ IT INHERITS seg_status, INCLUDING ITS STALENESS — BY DESIGN. The app's own read path
-- keys off seg_status, so a lesson whose seg_status is wrong is one the app already reads
-- wrongly; with_quiz agreeing with it is correct behaviour, not a bug. But two segments are
-- known stale (§A aside: 'complete' with zero cards, and 'complete' with nine draft cards,
-- both contradicting migration 056's derivation). RUN recompute_seg_status() ACROSS THE
-- CATALOG BEFORE OR AFTER THIS — the triggers below will pick the correction up
-- automatically, because segments changes recompute the flag.
--
-- ── IMPACT, MEASURED LIVE (2026-09-10) ──────────────────────────────────────
--   153 lessons → 12 derive TRUE, 141 derive FALSE. All 153 are `true` today, so the
--   backfill flips 141 rows true→false and changes nothing else.
--   Of the 141: 135 have NO complete segment at all, so the app throws "No complete
--   segment found" on them regardless — the flag is bookkeeping there.
--   5 of the 11 PUBLISHED lessons flip to false. Every one of them has exactly ONE quiz
--   question that is NOT approved:
--     Newborn Feeding Basics · Balancing Work and Family Time ·
--     Understanding Your Premature Baby's Cues · Babyproofing Your Home for a Crawler ·
--     Managing Stress and Finding Support as a Single Mom
--   Those five currently offer a quiz that renders EMPTY. This migration makes the flag
--   honest. ⚠ IF THE INTENT IS FOR THEM TO HAVE A QUIZ, APPROVE THE QUESTION INSTEAD —
--   the trigger flips with_quiz back to true the moment answer_status becomes 'approved',
--   with no further migration.
--
-- ── WHAT IS IN THIS FILE ────────────────────────────────────────────────────
--   1. lesson_with_quiz_derive(uuid)  — the ONE definition, used by everything below.
--   2. TRIGGER on quiz_questions      — as briefed (INSERT/UPDATE/DELETE).
--   3. TRIGGER on segments            — ADDED BEYOND THE BRIEF, and load-bearing: the
--      derivation depends on seg_status and segment_order, so approving a segment must
--      recompute the flag. Without this the flag stays wrong until someone happens to
--      touch a quiz row. Drop it only if you accept that.
--   4. TRIGGER on lessons             — ADDED BEYOND THE BRIEF: forces with_quiz to the
--      derived value on INSERT/UPDATE, which is what makes the column genuinely READ-ONLY
--      (a CMS or SQL-editor write is overwritten rather than honoured). Chosen over
--      migration 057's REVOKE-and-GRANT approach because that requires enumerating every
--      column of `lessons` and re-editing the list whenever one is added. Drop this trigger
--      if you would rather keep manual writes possible.
--   5. The one-time backfill.
--
-- FINANCIAL PROJECT: inherits this via the schema dump. It has no lessons, so the backfill
-- is a no-op and the rule applies from the first lesson created.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..063 reconciliation list, after 062.
-- Idempotent: CREATE OR REPLACE + DROP TRIGGER IF EXISTS; the backfill is convergent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST. Shows exactly which rows the backfill will change, so
-- the result can be compared against the numbers above before committing.
-- ---------------------------------------------------------------------------
-- WITH derived AS (
--   SELECT l.id, l.lesson_name, l.is_published, l.with_quiz AS current,
--          EXISTS (
--            SELECT 1 FROM quiz_questions q
--             WHERE q.answer_status = 'approved'
--               AND q.segment_id = (
--                 SELECT s.id FROM segments s
--                  WHERE s.lesson_id = l.id AND s.seg_status = 'complete'
--                  ORDER BY s.segment_order ASC NULLS LAST
--                  LIMIT 1)
--          ) AS derived
--     FROM lessons l
-- )
-- SELECT count(*) FILTER (WHERE derived)                         AS will_be_true,
--        count(*) FILTER (WHERE NOT derived)                     AS will_be_false,
--        count(*) FILTER (WHERE derived IS DISTINCT FROM current) AS rows_changed,
--        count(*) FILTER (WHERE derived IS DISTINCT FROM current AND is_published) AS published_changed
--   FROM derived;
-- -- EXPECT: 12 / 141 / 141 / 5   (as measured 2026-09-10)

BEGIN;

-- ---- 1. The single definition ---------------------------------------------
-- STABLE, not IMMUTABLE: it reads other tables. Returns false (never NULL) when the lesson
-- has no complete segment, so it is always safe to assign to a NOT NULL column.
CREATE OR REPLACE FUNCTION lesson_with_quiz_derive(p_lesson_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM quiz_questions q
    WHERE q.answer_status = 'approved'
      AND q.segment_id = (
        SELECT s.id
        FROM segments s
        WHERE s.lesson_id = p_lesson_id
          AND s.seg_status = 'complete'
        ORDER BY s.segment_order ASC NULLS LAST   -- matches PostgREST's .order(asc)
        LIMIT 1
      )
  );
$$;

COMMENT ON FUNCTION lesson_with_quiz_derive(uuid) IS
  'Migration 063: does the lesson have an approved quiz question on the segment the APP '
  'reads? Mirrors moosii-rn useLesson.ts (first seg_status=complete segment by '
  'segment_order) + useQuiz.ts (segment_id + answer_status=approved). Single source of '
  'truth for lessons.with_quiz — do not inline this logic anywhere else.';

-- ---- 2. quiz_questions → recompute the owning lesson (as briefed) ----------
CREATE OR REPLACE FUNCTION quiz_questions_sync_with_quiz()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_lesson uuid;
BEGIN
  -- Both sides, because an UPDATE can move a question between segments.
  FOR v_lesson IN
    SELECT DISTINCT s.lesson_id
    FROM segments s
    WHERE s.id IN (COALESCE(NEW.segment_id, OLD.segment_id), COALESCE(OLD.segment_id, NEW.segment_id))
      AND s.lesson_id IS NOT NULL
  LOOP
    UPDATE lessons SET with_quiz = lesson_with_quiz_derive(v_lesson) WHERE id = v_lesson;
  END LOOP;
  RETURN NULL;   -- AFTER trigger: return value is ignored
END $$;

DROP TRIGGER IF EXISTS quiz_questions_sync_with_quiz_trg ON public.quiz_questions;
CREATE TRIGGER quiz_questions_sync_with_quiz_trg
  AFTER INSERT OR UPDATE OR DELETE ON public.quiz_questions
  FOR EACH ROW EXECUTE FUNCTION quiz_questions_sync_with_quiz();

-- ---- 3. segments → recompute (ADDED; the derivation depends on these columns) ----
CREATE OR REPLACE FUNCTION segments_sync_with_quiz()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_lesson uuid;
BEGIN
  FOR v_lesson IN
    SELECT DISTINCT x FROM unnest(ARRAY[NEW.lesson_id, OLD.lesson_id]) AS x
    WHERE x IS NOT NULL
  LOOP
    UPDATE lessons SET with_quiz = lesson_with_quiz_derive(v_lesson) WHERE id = v_lesson;
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS segments_sync_with_quiz_trg ON public.segments;
CREATE TRIGGER segments_sync_with_quiz_trg
  AFTER INSERT OR UPDATE OF seg_status, segment_order, lesson_id OR DELETE ON public.segments
  FOR EACH ROW EXECUTE FUNCTION segments_sync_with_quiz();

-- ---- 4. lessons → force the derived value (ADDED; makes the column read-only) ----
-- No recursion risk: this is BEFORE on lessons and writes nothing outside NEW.
CREATE OR REPLACE FUNCTION lessons_force_derived_with_quiz()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.with_quiz := lesson_with_quiz_derive(NEW.id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS lessons_force_derived_with_quiz_trg ON public.lessons;
CREATE TRIGGER lessons_force_derived_with_quiz_trg
  BEFORE INSERT OR UPDATE ON public.lessons
  FOR EACH ROW EXECUTE FUNCTION lessons_force_derived_with_quiz();

-- ---- 5. One-time backfill --------------------------------------------------
-- Convergent: re-running changes nothing. (Trigger 4 would force the same value on any
-- UPDATE anyway; this is written explicitly so the migration stands on its own.)
UPDATE lessons
   SET with_quiz = lesson_with_quiz_derive(id)
 WHERE with_quiz IS DISTINCT FROM lesson_with_quiz_derive(id);

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying.
--
-- 1. The backfill landed where predicted:
--    SELECT with_quiz, count(*) FROM lessons GROUP BY with_quiz;
--    -- EXPECT true = 12, false = 141
--
-- 2. Nothing is left inconsistent with the definition — EXPECT ZERO ROWS:
--    SELECT id, lesson_name, with_quiz, lesson_with_quiz_derive(id) AS should_be
--      FROM lessons WHERE with_quiz IS DISTINCT FROM lesson_with_quiz_derive(id);
--
-- 3. The column is read-only (this must NOT stick):
--    BEGIN;
--      UPDATE lessons SET with_quiz = true WHERE with_quiz = false;
--      SELECT count(*) FROM lessons WHERE with_quiz = true;   -- EXPECT still 12
--    ROLLBACK;
--
-- 4. Approving a question flips the flag with no migration (the intended repair path for
--    the five published lessons named in the header):
--    BEGIN;
--      UPDATE quiz_questions SET answer_status = 'approved'
--       WHERE question_id = (
--         SELECT q.question_id FROM quiz_questions q
--           JOIN segments s ON s.id = q.segment_id
--          WHERE s.lesson_id = (SELECT id FROM lessons WHERE lesson_name = 'Newborn Feeding Basics')
--            AND q.answer_status IS DISTINCT FROM 'approved' LIMIT 1);
--      SELECT with_quiz FROM lessons WHERE lesson_name = 'Newborn Feeding Basics';  -- EXPECT true
--    ROLLBACK;
-- ============================================================================
