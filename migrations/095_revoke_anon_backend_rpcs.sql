-- ============================================================================
-- MIGRATION 095: backend-only RPCs — service_role only — BOTH PROJECTS
--   — APPLIED financial 2026-09-26 · APPLIED Moosii 2026-09-26
-- ============================================================================
-- WHY (FINDINGS-rpc-grants.md §2–3, 2026-09-21): four functions the anon key can call through
-- PostgREST that only the backend should:
--   * set_card_review_state — SECURITY DEFINER, no caller check. Proven (rolled back, both
--     projects): as anon it clinically approved every card of a draft lesson → seg_status complete.
--   * apply_classification — SECURITY DEFINER, no caller check; writes child_milestones,
--     user_mlp_mods, user_track_activations for ANY p_user_id.
--   * rebuild_user_mlp — SECURITY DEFINER, no caller check; DELETE + INSERT user_mlp for ANY user.
--   * unapprove_segment_bundle — SECURITY INVOKER, but calls set_card_review_state (definer), so
--     anon can send any lesson back to draft.
--
-- CALLERS (checked 2026-09-21): backend only, with the service-role key —
--   cardReview.ts:33 set_card_review_state; classifyUpdate.ts:499 apply_classification;
--   rebuildMlp.ts:677 rebuild_user_mlp; lessons.ts:184 unapprove_segment_bundle.
--   Inside the DB: approve_segment_bundle / unapprove_segment_bundle → set_card_review_state
--   (both called by service_role). moosii-cms and moosii-rn call none of them directly.
--
-- NOT CHANGED: is_admin / is_super_admin (RLS policies need them for every role),
-- renumber_track_priorities / renumber_track_priority_order (the CMS calls them; guarded by
-- is_admin()), trigger functions (not callable).
--
-- BOTH PROJECTS: privileges only, no rows. Idempotent.
-- APPLY per migrations/README.md: financial first, then Moosii.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT 4 rows, anon t / authenticated t / service_role t:
--   SELECT p.oid::regprocedure, has_function_privilege('anon', p.oid, 'EXECUTE'),
--          has_function_privilege('authenticated', p.oid, 'EXECUTE'),
--          has_function_privilege('service_role', p.oid, 'EXECUTE')
--     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('set_card_review_state', 'apply_classification', 'rebuild_user_mlp',
--                        'unapprove_segment_bundle');
-- ---------------------------------------------------------------------------

BEGIN;

REVOKE EXECUTE ON FUNCTION public.set_card_review_state(uuid, uuid[], text, text, uuid)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.apply_classification(uuid, uuid, uuid, jsonb, jsonb)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rebuild_user_mlp(uuid, jsonb)                          FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.unapprove_segment_bundle(uuid)                         FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.set_card_review_state(uuid, uuid[], text, text, uuid)   TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_classification(uuid, uuid, uuid, jsonb, jsonb)    TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_user_mlp(uuid, jsonb)                          TO service_role;
GRANT EXECUTE ON FUNCTION public.unapprove_segment_bundle(uuid)                         TO service_role;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying.
-- 1. The PRE-CHECK query: EXPECT anon f / authenticated f / service_role t on all 4.
-- 2. Rolled back, as anon: set_card_review_state(<seg>, NULL, 'clinically_approved', NULL, NULL)
--    → 42501; as service_role → still works. Classify dry run (persist=false) and an MLP rebuild
--    still succeed through the backend.
-- ============================================================================
