-- ============================================================================
-- MIGRATION 099: tourniquet — REVOKE ALL FROM anon on the 15 RLS-off public tables
--   — APPLIED financial 2026-09-26 · PENDING Moosii — BOTH PROJECTS
-- ============================================================================
-- WHY (FINDINGS-anon-views.md §6, 2026-09-26): these tables have RLS DISABLED and anon held
-- SELECT/INSERT/UPDATE/DELETE/TRUNCATE on all of them (Supabase default grants), so anyone with the
-- anon key could read, rewrite or delete them through PostgREST — including content_approvals (the
-- publish audit, invariant 7) and prompt_blocks (every content job's voice blocks).
--
-- WHAT: REVOKE ALL on each table FROM anon. Nothing else.
-- NOT CHANGED (deliberately — follow-up brief after a caller sweep): RLS stays disabled; authenticated
-- and service_role grants are untouched, so the CMS (admin JWT → authenticated) and the backend
-- (service_role) see no change. ALTER DEFAULT PRIVILEGES is untouched: a NEW table still gets anon grants.
--
-- CALLERS WITHOUT A SESSION (checked 2026-09-26: backend, moosii-cms, moosii-rn, moosii-reader): none.
--   The backend uses the service-role key only (src/supabase.ts:6). moosii-cms reads screen_help
--   (data/help.ts:45), topics (data/reference.ts:34) only behind its session gate (App.tsx:55 — no session
--   → LoginScreen, which queries nothing); source_documents / ai_generation_log go through the backend.
--   moosii-rn and moosii-reader reference none of the 15 (no .from, no embeds).
-- Pre-check found no anon column-level grants on these tables, so the table-level REVOKE is complete.
--
-- BOTH PROJECTS: privileges only, no rows. Idempotent.
-- APPLY per migrations/README.md: financial first, then Moosii.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT 15 rows, rls f, anon S/I/U/D all t:
--   SELECT relname, relrowsecurity, has_table_privilege('anon', oid, 'SELECT'),
--          has_table_privilege('anon', oid, 'INSERT'), has_table_privilege('anon', oid, 'UPDATE'),
--          has_table_privilege('anon', oid, 'DELETE')
--     FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity;
-- ---------------------------------------------------------------------------

BEGIN;

REVOKE ALL ON TABLE
  public._segment_dedupe_backup,
  public.ai_generation_log,
  public.content_approvals,
  public.content_edits,
  public.image_assets,
  public.lesson_source_documents,
  public.notification_log,
  public.prompt_block_versions,
  public.prompt_blocks,
  public.screen_help,
  public.source_documents,
  public.subscription_plans,
  public.topics,
  public."user_tag_actions_MM_unused",
  public."user_track_actions_MM_unsed"
  FROM anon;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION:
-- 1. The PRE-CHECK query: anon S/I/U/D all f on the 15.
-- 2. As anon: SELECT from content_approvals, prompt_blocks, topics → permission denied (42501).
-- 3. As authenticated with an admin's request.jwt.claims: row counts of those three = before.
-- ---------------------------------------------------------------------------
