-- ============================================================================
-- GUARD (structural): make segments.seg_status writable ONLY by the recompute RPC
-- ============================================================================
-- ██ DO NOT APPLY UNTIL THE CMS IS CUT OVER ██
--
-- This file is an UNNUMBERED DRAFT. It is NOT on the reconciliation list yet and must NOT be
-- applied in this slice. Number it and apply it as a follow-up ONLY AFTER the CMS slice has
-- repointed its direct seg_status write (moosii-cms src/data/cards.ts `regateSegment`, used
-- by card add/reorder) to POST /segments/:id/recompute-status. Applying it before then would
-- make that CMS write fail with "permission denied for column seg_status" and break CMS card
-- add/reorder (that write is response-checked and re-thrown).
--
-- WHY / WHAT. seg_status is derived from cards and written ONLY by recompute_seg_status() (a
-- SECURITY DEFINER function owned by a privileged role). This guard removes UPDATE(seg_status)
-- from every caller role so a stray direct write CANNOT silently succeed — it fails closed at
-- the privilege layer. Chosen over a BEFORE UPDATE trigger deliberately: a trigger with a
-- RAISE on the write path, load-bearing and coupled to session state, is the image_assets
-- cautionary pattern. This is static privilege, no runtime code.
--
-- MECHANICS. A table-level UPDATE grant covers ALL columns, so locking one column means
-- revoking table UPDATE and re-granting UPDATE on every OTHER column. recompute_seg_status()
-- keeps working because it is SECURITY DEFINER (runs as its owner, which retains the grant).
--
-- ██ MAINTENANCE FOOTGUN — READ BEFORE ADDING A segments COLUMN ██
--   * seg_status is NOT directly writable. Any NEW segments column MUST be added to the
--     GRANT UPDATE (...) list below (in the numbered follow-up migration), or backend writes
--     to that new column will fail with "permission denied".
--   * A blanket `GRANT ALL ON segments TO service_role` (or `GRANT UPDATE ON segments ...`)
--     SILENTLY UNDOES this guard — never re-grant table-wide UPDATE on segments.
--   * Column list below is the segments schema as of migration 055 (post drop of `edited`).
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
--  segment writes through the backend, not Supabase-direct, after the cutover. If a
--  Supabase-direct segment write is ever sanctioned again, re-grant the needed columns here
--  EXCEPT seg_status.)

COMMIT;
