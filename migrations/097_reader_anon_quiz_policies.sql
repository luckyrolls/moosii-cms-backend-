-- ============================================================================
-- MIGRATION 097: moosii-reader slice 2 — anon read of approved quizzes + lesson gating columns
--   — APPLIED financial 2026-09-26   *** FINANCIAL ONLY ***
-- ============================================================================
-- WHY (Mark, 2026-09-26): extends 096 for moosii-reader slice 2 (quiz). Design:
-- moosii-reader/DESIGN-web-reader.md §3.1, §3.2, §5. The SQL below is Mark's brief, verbatim; only
-- this header, the domain guard and BEGIN/COMMIT are added.
--
-- WHAT anon gets (on top of 096, and nothing else):
--   lessons         — + is_published, archived_at (column SELECT), so the reader can restate its
--                     client-side gating filters (DESIGN §3.1). Rows are still 096's
--                     reader_lesson_visible(id) policy; this widens no row.
--   quiz_questions  — question_id, segment_id, question_text, question_explanation, type,
--                     answer_status; rows with answer_status='approved' on a 'complete' segment of a
--                     visible lesson.
--   quiz_answers    — id, question_id, answer_text, is_correct, response; answers of such a question
--                     (the subquery runs under anon's quiz_questions policy).
-- Column-level: anon's table-level SELECT on both quiz tables is revoked, then per-column SELECT
-- granted, so e.g. quiz_questions.lesson_id / image_url and quiz_answers.score are "permission
-- denied" for anon. `authenticated`, the CMS and the backend (service_role) are untouched.
-- quiz_answers.is_correct is exposed on purpose: the reader grades client-side (DESIGN §5.4).
--
-- Pre-existing and unchanged: the quiz tables' own SELECT policies (authenticated_can_read,
-- qq_sel / qa_sel) are TO public but require auth.uid() IS NOT NULL, so before 097 anon read 0
-- rows from both (checked 2026-09-26 on financial). anon's INSERT/UPDATE/DELETE grants are
-- untouched. The plain-view bypass recorded under 096 (docs/rls-sweep.md) is NOT fixed here.
--
-- NOT CHANGED: Moosii (parenting) — FINANCIAL ONLY; the schema is unchanged.
-- Idempotent: DROP POLICY IF EXISTS, REVOKE/GRANT. A re-run is a no-op.
-- APPLY per migrations/README.md: FINANCIAL ONLY.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT 'financial'; six rows, all t:
--   SELECT value FROM app_settings WHERE key = 'domain';
--   SELECT c.relname, c.relrowsecurity FROM pg_class c
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relname IN
--      ('lessons','segments','sub_segments','quiz_questions','quiz_answers','app_settings');
--   -- 096 must be live (the quiz policy calls it):
--   SELECT 'public.reader_lesson_visible(uuid)'::regprocedure;
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
BEGIN
  IF (SELECT value FROM app_settings WHERE key = 'domain') IS DISTINCT FROM 'financial' THEN
    RAISE EXCEPTION '097 is FINANCIAL ONLY — app_settings.domain is not ''financial''';
  END IF;
END $$;

-- lessons: add the two gating columns anon lacks, so the reader can apply its
-- redundant client-side filters (DESIGN §3.1) again
grant select (is_published, archived_at) on public.lessons to anon;

-- quiz: column-level grants, reader columns only
revoke select on public.quiz_questions, public.quiz_answers from anon;
grant select (question_id, segment_id, question_text, question_explanation, type,
  answer_status) on public.quiz_questions to anon;
grant select (id, question_id, answer_text, is_correct, response)
  on public.quiz_answers to anon;

drop policy if exists reader_anon_quiz_questions on public.quiz_questions;
create policy reader_anon_quiz_questions on public.quiz_questions for select to anon
  using (answer_status = 'approved' and exists (
    select 1 from public.segments s where s.id = segment_id
      and s.seg_status = 'complete' and public.reader_lesson_visible(s.lesson_id)));

drop policy if exists reader_anon_quiz_answers on public.quiz_answers;
create policy reader_anon_quiz_answers on public.quiz_answers for select to anon
  using (exists (select 1 from public.quiz_questions q
    where q.question_id = quiz_answers.question_id));

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION — as anon, each statement on its own:
--   SET ROLE anon;
--   SELECT is_published, archived_at FROM lessons;         -- one row, true / null
--   SELECT question_id, answer_status FROM quiz_questions;  -- approved rows on visible segments only
--   SELECT count(*) FROM quiz_answers;                      -- answers of those questions
--   SELECT lesson_id FROM quiz_questions;                   -- MUST fail: permission denied (42501)
--   RESET ROLE;
-- ---------------------------------------------------------------------------
