-- ============================================================================
-- MIGRATION 105: completed_items / user_lesson_progress — drop the open policies — BOTH PROJECTS
--   — APPLIED financial 2026-09-30 · APPLIED Moosii 2026-09-30
-- ============================================================================
-- WHY (FINDINGS-activities §2, backlog P1, 2026-09-30): each table carried an extra PERMISSIVE policy
--   "Enable insert for authenticated users only"  FOR INSERT TO authenticated WITH CHECK (true)
-- and user_lesson_progress also
--   "Enable read access for all users"            FOR SELECT TO authenticated USING (true).
-- Permissive policies OR together, so any signed-in user (a parent in the RN app, a public demo session in
-- the reader) could insert completions / progress for ANY user and read everyone's lesson progress.
--
-- WHAT: drop those three. The own-row policies that remain cover every caller:
--   completed_items      _sel (own | is_admin | service), _ins/_upd/_del (own | super_admin | service),
--                        user_or_super_admin_access (ALL: own | super_admin | service)
--   user_lesson_progress ulp_sel/ulp_ins/ulp_upd/ulp_del (own | super_admin | service), user_or_super_admin_access
--
-- CALLERS (grep 2026-09-30): backend reads as service_role (rebuildMlp.ts:586, questionnaireStatus.ts:87,
-- recordCheckinMilestones.ts:46); moosii-rn as the parent, own rows only (useCompletedItems, useCompleteLesson
-- — read + upsert user_lesson_progress + insert completed_items, useFinishQuestionnaire, useStreak via an invoker
-- view); moosii-cms / moosii-reader: no direct calls (admin views go through invoker views and keep is_admin read
-- on completed_items). No DB function references either table; all 7 views over them are security_invoker.
-- NOTE: a PLAIN admin loses cross-user READ of user_lesson_progress (super_admin keeps it) — no caller uses it.
--
-- BOTH PROJECTS: policies only, no rows. Idempotent (DROP POLICY IF EXISTS).
-- APPLY per migrations/README.md: financial first, then Moosii.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT the three policies present:
--   SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
--    WHERE tablename IN ('completed_items','user_lesson_progress')
--      AND policyname IN ('Enable insert for authenticated users only','Enable read access for all users');
-- ---------------------------------------------------------------------------

BEGIN;

DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.completed_items;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.user_lesson_progress;
DROP POLICY IF EXISTS "Enable read access for all users"          ON public.user_lesson_progress;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION: the PRE-CHECK query returns 0 rows; persona simulation (FINDINGS-activities / this commit):
-- own-row insert/read unchanged, cross-user insert → 42501, cross-user progress read → own rows only,
-- admin read of completed_items unchanged.
-- ---------------------------------------------------------------------------
