-- ============================================================================
-- DRAFT 103: authenticated end users read only published, unarchived content — BOTH PROJECTS
--   — PROPOSAL (FINDINGS-rls-pass.md) — NOT APPLIED
-- ============================================================================
-- WHY: lessons / segments / sub_segments / quiz_* have SELECT policies `USING (true)` or
-- `auth.uid() IS NOT NULL`, so any signed-in user reads drafts, unapproved cards and quiz items. The CMS
-- reads as an admin (App.tsx gates on is_admin()), the RN app and the reader read published content only.
--
-- RULE (mirrors the anon reader policies of 096/097, which stay as they are):
--   admin (is_admin(): admin or super_admin)           → everything, as today;
--   any other signed-in user                           → lessons where reader_lesson_visible(id);
--     segments with seg_status='complete' of those; their cards; approved questions on those segments;
--     answers of those questions.
-- reader_lesson_visible(uuid) exists on financial (096); created here on Moosii with the SAME body.
--
-- ALSO: drops segments_insert_auth — any signed-in user could INSERT segments (the admin insert policy
-- segments_insert_admins remains). Write policies are otherwise unchanged.
-- service_role bypasses RLS: the backend is unaffected.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.reader_lesson_visible(p_lesson_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  select exists (
    select 1 from lessons l
    left join tracks t on t.id = l.track_id
    where l.id = p_lesson_id
      and l.is_published = true
      and l.archived_at is null
      and (l.track_id is null or t.archived_at is null)
  );
$$;
REVOKE ALL ON FUNCTION public.reader_lesson_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reader_lesson_visible(uuid) TO authenticated, service_role;
-- anon: financial's reader needs it (096 granted it); Moosii has no anon reader.
DO $$ BEGIN
  IF (SELECT value FROM app_settings WHERE key = 'domain') = 'financial' THEN
    GRANT EXECUTE ON FUNCTION public.reader_lesson_visible(uuid) TO anon;
  ELSE
    REVOKE EXECUTE ON FUNCTION public.reader_lesson_visible(uuid) FROM anon;
  END IF;
END $$;

-- lessons
DROP POLICY IF EXISTS "Enable read access for all users" ON public.lessons;
DROP POLICY IF EXISTS authenticated_can_read ON public.lessons;
DROP POLICY IF EXISTS lessons_sel ON public.lessons;
DROP POLICY IF EXISTS lessons_select_admin_or_visible ON public.lessons;
CREATE POLICY lessons_select_admin_or_visible ON public.lessons FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()) OR public.reader_lesson_visible(id));

-- segments
DROP POLICY IF EXISTS segments_read_auth ON public.segments;
DROP POLICY IF EXISTS segments_insert_auth ON public.segments;
DROP POLICY IF EXISTS segments_select_admin_or_visible ON public.segments;
CREATE POLICY segments_select_admin_or_visible ON public.segments FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()) OR (seg_status = 'complete' AND public.reader_lesson_visible(lesson_id)));

-- sub_segments
DROP POLICY IF EXISTS "auth read sub_segments" ON public.sub_segments;
DROP POLICY IF EXISTS sub_segments_select_admin_or_visible ON public.sub_segments;
CREATE POLICY sub_segments_select_admin_or_visible ON public.sub_segments FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()) OR EXISTS (
    SELECT 1 FROM public.segments s
     WHERE s.id = sub_segments.seg_id AND s.seg_status = 'complete' AND public.reader_lesson_visible(s.lesson_id)));

-- quiz_questions
DROP POLICY IF EXISTS authenticated_can_read ON public.quiz_questions;
DROP POLICY IF EXISTS qq_sel ON public.quiz_questions;
DROP POLICY IF EXISTS quiz_questions_select_admin_or_visible ON public.quiz_questions;
CREATE POLICY quiz_questions_select_admin_or_visible ON public.quiz_questions FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()) OR (answer_status = 'approved' AND EXISTS (
    SELECT 1 FROM public.segments s
     WHERE s.id = quiz_questions.segment_id AND s.seg_status = 'complete' AND public.reader_lesson_visible(s.lesson_id))));

-- quiz_answers (the subquery runs under the caller's quiz_questions policy)
DROP POLICY IF EXISTS authenticated_can_read ON public.quiz_answers;
DROP POLICY IF EXISTS qa_sel ON public.quiz_answers;
DROP POLICY IF EXISTS quiz_answers_select_admin_or_visible ON public.quiz_answers;
CREATE POLICY quiz_answers_select_admin_or_visible ON public.quiz_answers FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()) OR EXISTS (
    SELECT 1 FROM public.quiz_questions q WHERE q.question_id = quiz_answers.question_id));

COMMIT;
