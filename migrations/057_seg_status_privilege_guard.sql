-- ============================================================================
-- Migration 057: structural guard — segments.seg_status writable ONLY by the recompute RPC
-- ============================================================================
-- DRAFT — NOT applied by the agent. APPLY VIA THE SUPABASE SQL EDITOR; on the 008..057
-- reconciliation list. Apply order: after 056.
--
-- ██ PRECONDITION MET — safe to apply ██
-- Requires CMS slice 3 (two-stage review UI) DEPLOYED with `regateSegment` repointed to
-- POST /segments/:id/recompute-status, so NOTHING outside the backend writes seg_status.
-- Confirmed live 2026-08-11 (CMS build 048058c+; verified in-browser that card add fires
-- recompute-status with no Supabase-direct segments write). Applying this before that cutover
-- would break CMS card add/reorder with "permission denied for column seg_status".
--
-- WHY / WHAT. seg_status is DERIVED from cards and written ONLY by recompute_seg_status()
-- (migration 056), a SECURITY DEFINER function owned by a privileged role. This guard removes
-- UPDATE(seg_status) from every caller role so a stray direct write CANNOT silently succeed —
-- it fails closed at the privilege layer. Chosen over a BEFORE UPDATE trigger deliberately: a
-- trigger with a RAISE on the write path, load-bearing and coupled to session state, is the
-- image_assets cautionary pattern. This is static privilege, no runtime code. NO backend code
-- change is needed — the recompute/transition RPCs are already SECURITY DEFINER.
--
-- MECHANICS. A table-level UPDATE grant covers ALL columns, so locking one column means
-- revoking table UPDATE and re-granting UPDATE on every OTHER column. recompute_seg_status()
-- keeps working because it runs as its owner (which retains the grant).
--
-- ██ MAINTENANCE FOOTGUN — READ BEFORE ADDING A segments COLUMN ██
--   * seg_status is NOT directly writable. Any NEW segments column MUST be added to the
--     GRANT UPDATE (...) list below (in a follow-up migration), or backend writes to that
--     new column will fail with "permission denied".
--   * A blanket `GRANT ALL ON segments TO service_role` (or `GRANT UPDATE ON segments ...`)
--     SILENTLY UNDOES this guard — never re-grant table-wide UPDATE on segments.
--   * Column list below was verified against the LIVE table on 2026-08-11 (23 columns;
--     migration 056 added none to segments). `laytout_top` is the real (misspelled) column.
-- ============================================================================

BEGIN;

-- Remove table-wide UPDATE (which implicitly covers seg_status) from every caller role.
REVOKE UPDATE ON segments FROM service_role, authenticated, anon;

-- Re-grant UPDATE on every column EXCEPT seg_status. (id / created_at are never updated but
-- are harmless to include; keep the list exhaustive so nothing else silently breaks.)
GRANT UPDATE (
  anchor_text, approved_by, chatgpt_image_prompt, content, created_at, created_by,
  description, full_prompt, id, image_prompt, image_url, laytout_top, lesson_id,
  question_id, ref_link, segment_name, segment_order, takeaway, title, tone,
  updated_at, video_url
) ON segments TO service_role;
-- (authenticated / anon are intentionally NOT re-granted UPDATE on segments — the CMS reaches
--  segment writes through the backend, not Supabase-direct, as of slice 3. If a Supabase-direct
--  segment write is ever sanctioned again, re-grant the needed columns here EXCEPT seg_status.)

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying (as service_role / via PostgREST):
--   UPDATE segments SET seg_status = 'complete' WHERE id = '<any>';   -- expect: permission denied
--   SELECT recompute_seg_status('<seg id>');                          -- still works (definer)
--   UPDATE segments SET updated_at = now() WHERE id = '<any>';        -- still works (column granted)
-- ============================================================================
