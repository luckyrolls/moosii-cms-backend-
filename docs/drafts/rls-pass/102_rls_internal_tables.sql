-- ============================================================================
-- DRAFT 102: RLS on the 15 RLS-off public tables + fact vocabulary read — BOTH PROJECTS
--   — PROPOSAL (FINDINGS-rls-pass.md) — NOT APPLIED
-- ============================================================================
-- WHY: 099 revoked anon, but authenticated still holds full DML on these tables with RLS OFF, so any
-- signed-in user (a parent in the RN app, a demo persona in the reader) can read, rewrite or delete
-- prompts, the publish audit, the AI log, licensed source text, image records. Blocks demo sign-in.
--
-- CALLERS (FINDINGS §1): every table here is written/read ONLY by the backend (service_role, BYPASSRLS)
-- except: screen_help (CMS-direct, admin JWT: read + update + insert), topics (CMS reads the list;
-- user_mlp_not_completed — security_invoker since 098 — joins topics for label/colour as the parent).
-- DB-side: the image_assets storage triggers are SECURITY DEFINER (unaffected); set_lesson_published is
-- INVOKER, EXECUTE-able by authenticated, called only by the backend → revoked here (095 pattern).
--
-- service_role bypasses RLS: nothing the backend does changes. No table is dropped here.
-- ============================================================================

BEGIN;

-- 1. Backend-only: RLS on, NO policy (default-deny for anon + authenticated).
ALTER TABLE public._segment_dedupe_backup        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_generation_log             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_approvals             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_edits                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.image_assets                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lesson_source_documents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_log              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_block_versions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_blocks                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_documents              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_plans            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."user_tag_actions_MM_unused"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."user_track_actions_MM_unsed" ENABLE ROW LEVEL SECURITY;

-- 2. screen_help — CMS-direct (src/data/help.ts: select, update, insert). Admins only.
ALTER TABLE public.screen_help ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS screen_help_admin_all ON public.screen_help;
CREATE POLICY screen_help_admin_all ON public.screen_help FOR ALL TO authenticated
  USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- 3. topics — signed-in read (CMS topic list; RN plan labels through user_mlp_not_completed).
--    No write policy: topics are written by the backend / migrations only.
ALTER TABLE public.topics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS topics_select_authenticated ON public.topics;
CREATE POLICY topics_select_authenticated ON public.topics FOR SELECT TO authenticated USING (true);

-- 4. Fact vocabulary — signed-in read (reader outcomes view shows labels). Already RLS-on, no policy.
DROP POLICY IF EXISTS fact_keys_select_authenticated ON public.fact_keys;
CREATE POLICY fact_keys_select_authenticated ON public.fact_keys FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS fact_values_select_authenticated ON public.fact_values;
CREATE POLICY fact_values_select_authenticated ON public.fact_values FOR SELECT TO authenticated USING (true);

-- 5. set_lesson_published — backend-only RPC (src/routes/lessons.ts:211, service role).
REVOKE EXECUTE ON FUNCTION public.set_lesson_published(uuid, boolean, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.set_lesson_published(uuid, boolean, uuid, text) TO service_role;

COMMIT;
