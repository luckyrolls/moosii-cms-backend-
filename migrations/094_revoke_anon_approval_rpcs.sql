-- ============================================================================
-- MIGRATION 094: approval RPCs and recompute_seg_status — service_role only — BOTH PROJECTS
--   — APPLIED financial 2026-09-21 · APPLIED Moosii 2026-09-21
-- ============================================================================
-- WHY (backlog P1, found 2026-09-21 while fingerprinting for 093): both approve_content_image
-- overloads, approve_segment_bundle and recompute_seg_status carried EXECUTE for PUBLIC, anon and
-- authenticated, so anyone holding the anon key could call them through PostgREST
-- (/rest/v1/rpc/...). Proven before this migration with the anon key over HTTP on Moosii and as
-- `SET ROLE anon` on both projects (docs/drafts/094-anon-proof.*): every call EXECUTED.
-- recompute_seg_status is SECURITY DEFINER, so it ran as its owner for anon; 056 meant it to be
-- service-role only.
--
-- WHO CALLS THEM — checked 2026-09-21, nobody but the backend:
--   * backend (service_role key): images.ts:34 approve_content_image; lessons.ts:140
--     approve_segment_bundle; cardReview.ts:14 recompute_seg_status.
--   * moosii-cms: its only direct RPCs are is_admin, user_active_tracks_for_user, mark_mlp_stale,
--     renumber_track_priorities, renumber_track_priority_order. It approves via the backend routes.
--   * moosii-rn: no .rpc() calls at all.
--   * inside the database: approve_segment_bundle → approve_content_image (called by service_role);
--     set_card_review_state, sub_segments_reset_review (066) and sub_segments_image_swap_review (093)
--     → recompute_seg_status — all three SECURITY DEFINER, so they call it as the owner (postgres),
--     unaffected by these revokes. No pg_cron job references them.
--
-- The owner (postgres) keeps EXECUTE as owner. unapprove_segment_bundle and the other open
-- SECURITY DEFINER functions are NOT changed here — see FINDINGS-rpc-grants.md.
--
-- TRAP for later migrations: Supabase's default privileges grant EXECUTE to anon/authenticated on
-- every NEW function. CREATE OR REPLACE keeps this ACL; a DROP + CREATE (return-type change)
-- brings the grants back — repeat this REVOKE in that migration.
--
-- BOTH PROJECTS: privileges only, no rows. Idempotent.
-- APPLY per migrations/README.md: financial first, then Moosii.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT 4 rows, each anon t / authenticated t / service_role t:
--   SELECT p.oid::regprocedure, has_function_privilege('anon', p.oid, 'EXECUTE'),
--          has_function_privilege('authenticated', p.oid, 'EXECUTE'),
--          has_function_privilege('service_role', p.oid, 'EXECUTE')
--     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('approve_content_image', 'approve_segment_bundle', 'recompute_seg_status');
-- ---------------------------------------------------------------------------

BEGIN;

REVOKE EXECUTE ON FUNCTION public.approve_content_image(uuid, uuid, text)       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.approve_content_image(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.approve_segment_bundle(uuid, uuid, jsonb)     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recompute_seg_status(uuid)                    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.approve_content_image(uuid, uuid, text)       TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_content_image(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_segment_bundle(uuid, uuid, jsonb)     TO service_role;
GRANT EXECUTE ON FUNCTION public.recompute_seg_status(uuid)                    TO service_role;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying.
-- 1. The PRE-CHECK query: EXPECT anon f / authenticated f / service_role t on all 4.
-- 2. docs/drafts/094-anon-proof.sql (rolled back): every anon / authenticated call REFUSED (42501);
--    service_role still approves; an admin's CMS-direct text edit still resets + recomputes
--    through the owner-run trigger.
-- 3. docs/drafts/094-anon-proof.sh (anon key over HTTP, random ids): every call 401/403 with 42501.
-- ============================================================================
