-- ============================================================================
-- Migration 065: lessons_review_status — name the derived review state (APPLIED 2026-09-11)
-- ============================================================================
-- FROM: FINDINGS-published-edit.md §B, §D, §E. Gives the CMS and the reviewer queue a name
-- for the state a published-but-edited lesson is already in, WITHOUT storing it.
--
-- ⚠ NO COLUMN, NO CONSTRAINT — AND THAT IS THE DESIGN, NOT AN OMISSION.
-- The brief asked for `published_unreviewed` as a value or a column, plus a constraint that a
-- lesson cannot be published AND clinically approved AND carry unreviewed content changes.
-- Under the existing model that constraint is a TAUTOLOGY: "clinically approved" and "has
-- unreviewed changes" are the SAME fact read two ways — seg_status='complete' means every
-- card is clinically_approved (migration 056), and anything else means at least one is not.
-- The forbidden combination cannot be represented, so there is nothing to enforce. A stored
-- column would only add a second source of truth to drift (invariants 6 and 12).
--
-- IT CLEARS ITSELF. Re-approval moves the cards to clinically_approved, seg_status recomputes
-- to 'complete', and the lesson reads as published_reviewed again. No clearing step exists to
-- be forgotten.
--
-- ⚠ WHAT THIS VIEW DOES NOT FIX (READ THIS BEFORE BUILDING THE CMS DIALOG).
-- `published_unreviewed` currently means "published and BROKEN", not "published and flagged".
-- The app selects segments with `.eq('seg_status','complete')` and THROWS when none matches
-- (moosii-rn useLesson.ts), so a published lesson with any draft card errors when a parent
-- opens it. Option B ("keep live") is therefore not deliverable until the app stops requiring
-- seg_status='complete'. This view reports the state honestly either way — it does not make
-- option B work. See FINDINGS §B.4.
--
-- SECURITY: security_invoker so the view can never widen access to its base tables. Every
-- reader today is either the service-role backend or a CMS admin whose JWT already reads
-- `lessons` directly.
--
-- ⚠ REQUIRES POSTGRES 15+ for security_invoker (same check as the facts-v1 draft):
--   SELECT current_setting('server_version_num')::int >= 150000;
--
-- FINANCIAL PROJECT: inherits this via the schema dump; it reports on whatever catalog exists.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..065 reconciliation list, after 064.
-- Idempotent: CREATE OR REPLACE. Read-only — creates no table and changes no row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST. Shows how the catalog splits across the three states, so the view's
-- output can be sanity-checked against a number you already believe:
--   SELECT l.is_published,
--          bool_and(s.seg_status = 'complete') AS all_complete,
--          count(*)
--     FROM lessons l LEFT JOIN segments s ON s.lesson_id = l.id
--    WHERE l.archived_at IS NULL
--    GROUP BY 1, 2 ORDER BY 1, 2;
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE VIEW public.lessons_review_status
  WITH (security_invoker = true) AS
  SELECT
    l.id AS lesson_id,
    l.lesson_name,
    l.track_id,
    l.is_published,
    l.archived_at,

    -- The three states (§B.3). A published lesson with no segment at all counts as
    -- unreviewed: there is certainly nothing approved behind it.
    CASE
      WHEN NOT COALESCE(l.is_published, false) THEN 'draft'
      WHEN EXISTS (
        SELECT 1 FROM segments s
         WHERE s.lesson_id = l.id
           AND s.seg_status IS DISTINCT FROM 'complete'
      ) OR NOT EXISTS (SELECT 1 FROM segments s2 WHERE s2.lesson_id = l.id)
        THEN 'published_unreviewed'
      ELSE 'published_reviewed'
    END AS content_state,

    -- Queue counters (§E) — one query drives both review stages.
    (SELECT count(*) FROM sub_segments ss
       JOIN segments s3 ON s3.id = ss.seg_id
      WHERE s3.lesson_id = l.id AND ss.review_state = 'draft')
      AS cards_awaiting_editorial,
    (SELECT count(*) FROM sub_segments ss
       JOIN segments s4 ON s4.id = ss.seg_id
      WHERE s4.lesson_id = l.id AND ss.review_state = 'editorial_reviewed')
      AS cards_awaiting_clinical,
    (SELECT count(*) FROM sub_segments ss
       JOIN segments s5 ON s5.id = ss.seg_id
      WHERE s5.lesson_id = l.id)
      AS cards_total,

    -- Quiz review is a SEPARATE gate (quiz_questions.answer_status), surfaced alongside
    -- because a published lesson can carry an unapproved quiz question independently of its
    -- cards — and, per FINDINGS §A.2 row 12, a CMS-direct quiz edit does not reset anything.
    (SELECT count(*) FROM quiz_questions q
       JOIN segments s6 ON s6.id = q.segment_id
      WHERE s6.lesson_id = l.id AND q.answer_status IS DISTINCT FROM 'approved')
      AS quiz_questions_unapproved,

    -- Most recent card edit, so a queue can sort by "changed most recently" (migration 055).
    (SELECT max(ss.updated_at) FROM sub_segments ss
       JOIN segments s7 ON s7.id = ss.seg_id
      WHERE s7.lesson_id = l.id)
      AS content_last_edited_at
  FROM lessons l;

COMMENT ON VIEW public.lessons_review_status IS
  'Migration 065: DERIVED per-lesson review state — draft | published_reviewed | '
  'published_unreviewed — plus the stage-1/stage-2 queue counters. Nothing is stored: the '
  'state is lessons.is_published x segments.seg_status (itself derived from card '
  'review_state, 056), so it self-clears on re-approval. NOTE: published_unreviewed today '
  'also means the app cannot open the lesson (it requires seg_status=complete) — see '
  'FINDINGS-published-edit.md §B.4.';

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying.
--
-- 1. Every lesson lands in exactly one state, and the totals match the pre-check:
--    SELECT content_state, count(*) FROM lessons_review_status
--     WHERE archived_at IS NULL GROUP BY 1 ORDER BY 1;
--
-- 2. The stage-1 / stage-2 reviewer queues (§E):
--    SELECT lesson_id, lesson_name, cards_awaiting_editorial, cards_awaiting_clinical
--      FROM lessons_review_status
--     WHERE content_state = 'published_unreviewed'
--     ORDER BY content_last_edited_at DESC NULLS LAST;
--
-- 3. It tracks a real edit. Take a published, fully-approved lesson, send one card back to
--    draft, and watch the state flip — then roll back:
--    BEGIN;
--      SELECT content_state FROM lessons_review_status WHERE lesson_id = '<id>';  -- published_reviewed
--      SELECT set_card_review_state('<seg_id>'::uuid, NULL, 'draft', NULL, NULL);
--      SELECT content_state FROM lessons_review_status WHERE lesson_id = '<id>';  -- published_unreviewed
--    ROLLBACK;
-- ============================================================================

-- ============================================================================
-- CONFIRMED LIVE 2026-09-11 (read-only probe): the view returns all 153 lessons —
-- 142 draft, 9 published_reviewed, 2 published_unreviewed. The two in the queue are
-- "Getting enough sleep" (9 cards awaiting editorial) and "Surviving on Little Sleep"
-- (1 awaiting). ⚠ Per §B.4 those two are currently UN-OPENABLE in the app: their segment is
-- no longer 'complete', and useLesson.ts throws rather than rendering. They are the live
-- backlog this view exists to surface.
-- ============================================================================
