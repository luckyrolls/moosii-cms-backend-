-- ============================================================================
-- MIGRATION 098: anon-readable plain views → security_invoker, anon revoked; user_mlp read → is_admin()
--   — APPLIED financial 2026-09-26 · APPLIED Moosii 2026-09-26 — BOTH PROJECTS
-- ============================================================================
-- WHY (FINDINGS-anon-views.md, 2026-09-26): ten views owned by postgres (BYPASSRLS), not
-- security_invoker, SELECT granted to anon — so anon read EVERY row through them, bypassing RLS and
-- the 096/097 column grants. Worst: user_mlp_not_completed (every user's next items; 26 rows as anon on
-- Moosii, and any signed-in user could read everyone's).
--
-- WHAT:
--   1. security_invoker = true on all ten: base-table RLS now binds the caller.
--   2. REVOKE SELECT FROM anon on all ten (the reader uses none of them; it reads base tables via 096/097).
--   3. user_mlp_sel: own OR is_admin() OR service_role (was own OR is_super_admin() OR service_role) —
--      the 078 posture for per-user tables. Without it a PLAIN admin's CMS classify console
--      (moosii-cms src/data/classify.ts:75, another user's MLP) drops from 6 rows to 0 under invoker.
--      The FOR ALL policy user_or_super_admin_access is untouched, so writes do not widen.
--
-- CALLERS (FINDINGS §1, re-checked 2026-09-26 across backend, moosii-cms, moosii-rn, moosii-reader):
--   mlp_item_pool — backend rebuildMlp.ts:506, service_role (BYPASSRLS → unchanged, proven).
--   user_mlp_not_completed — moosii-rn useUpcomingMlp.ts:32 (own rows, unchanged, proven);
--     moosii-cms classify.ts:75 (admin, another user — restored by 3).
--   The other eight: no callers.
-- Measured with a rolled-back ALTER per persona, both projects (FINDINGS §4 + this brief's run for the
-- two questionnaire views): every authenticated/service_role count unchanged except the plain-admin case
-- that 3 fixes; anon → 0 / permission denied.
--
-- NOT CHANGED: authenticated / service_role SELECT on the views; no view is dropped (backlog P3).
-- Idempotent: ALTER VIEW SET, REVOKE, DROP POLICY IF EXISTS + CREATE. A re-run is a no-op.
-- APPLY per migrations/README.md: financial first, then Moosii.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT 10 rows, opts '-', anon t; and user_mlp_sel's qual =
--   ((user_id = auth.uid()) OR is_super_admin() OR (auth.role() = 'service_role'::text)):
--   SELECT relname, coalesce(reloptions::text,'-') opts, has_table_privilege('anon', oid, 'SELECT') anon
--     FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN
--     ('v_lesson_details','v_segment_details','lessons_with_track_name','lesson_segment_counts_with_track',
--      'sub_segment_image_fallback','sub_segments_image_fallback','mlp_item_pool','user_mlp_not_completed',
--      'questionnaire_user_score','questionnaire_with_track_name');
--   SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_mlp' AND policyname = 'user_mlp_sel';
-- ---------------------------------------------------------------------------

BEGIN;

ALTER VIEW public.v_lesson_details                 SET (security_invoker = true);
ALTER VIEW public.v_segment_details                SET (security_invoker = true);
ALTER VIEW public.lessons_with_track_name          SET (security_invoker = true);
ALTER VIEW public.lesson_segment_counts_with_track SET (security_invoker = true);
ALTER VIEW public.sub_segment_image_fallback       SET (security_invoker = true);
ALTER VIEW public.sub_segments_image_fallback      SET (security_invoker = true);
ALTER VIEW public.mlp_item_pool                    SET (security_invoker = true);
ALTER VIEW public.user_mlp_not_completed           SET (security_invoker = true);
ALTER VIEW public.questionnaire_user_score         SET (security_invoker = true);
ALTER VIEW public.questionnaire_with_track_name    SET (security_invoker = true);

REVOKE SELECT ON public.v_lesson_details, public.v_segment_details, public.lessons_with_track_name,
  public.lesson_segment_counts_with_track, public.sub_segment_image_fallback,
  public.sub_segments_image_fallback, public.mlp_item_pool, public.user_mlp_not_completed,
  public.questionnaire_user_score, public.questionnaire_with_track_name
  FROM anon;

DROP POLICY IF EXISTS user_mlp_sel ON public.user_mlp;
CREATE POLICY user_mlp_sel ON public.user_mlp FOR SELECT
  USING ((user_id = (SELECT auth.uid())) OR (SELECT is_admin()) OR ((SELECT auth.role()) = 'service_role'));

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION (FINDINGS §7):
-- 1. The PRE-CHECK query: opts {security_invoker=true}, anon f on all 10.
-- 2. As anon: SELECT count(*) FROM <each view> → permission denied for view (42501).
-- 3. Persona counts (rolled back, request.jwt.claims): own user's user_mlp_not_completed unchanged; a
--    plain admin reading another user = the owner's count; super_admin and service_role unchanged;
--    mlp_item_pool as service_role unchanged (and WHERE is_published).
-- 4. Financial only: the 096 and 097 anon verifies, unchanged.
-- ---------------------------------------------------------------------------
