-- ============================================================================
-- MIGRATION 092: approving an image no longer un-approves its card — BOTH PROJECTS
--   — APPLIED financial 2026-09-21 · APPLIED Moosii 2026-09-21
-- ============================================================================
-- BUG (FINDINGS-cover-image.md §0, proven on live Moosii in rolled-back probes 2026-09-21):
-- POST /lessons/:id/approve reports the segment "complete" but leaves every card with a new image
-- in 'draft'. approve_segment_bundle promotes the cards FIRST, then loops approve_content_image,
-- whose step 3 writes `UPDATE sub_segments SET image = …, image_path = …`. 066's trigger
-- `sub_segments_reset_review_trg` listed `image` among its content columns, so that write reset
-- the card it had just approved. The standalone POST /content-images/:id/approve did the same.
-- Live since 066 (2026-09-11).
--
-- FIX: drop `image` from the trigger's column list. Writing the approved image's URL IS the
-- approval; it must not undo it. The trigger now fires on title / content / sequence (+ insert /
-- delete), exactly as before otherwise. The function is unchanged (only its COMMENT is updated).
--
-- WHY THIS LOSES NO RESET — every writer of sub_segments.image, checked 2026-09-21:
--   * moosii-cms: writes sub_segments only for reorder (sequence), add card (INSERT) and never
--     `image`; moosii-rn only reads sub_segments. No CMS-direct path writes the image.
--   * A NEW image (generate / upload) never touches `image` — it inserts a content_images candidate
--     and resets the card explicitly in code (generateSubSegmentImage.ts:292-296,
--     subSegments.ts:272-274). The card is re-reviewed when the candidate appears, not when the
--     reviewer approves it.
--   * approve_content_image / generate auto_approve: the approval itself (auto_approve's code comment
--     already says it "correctly skips the invalidation"; the trigger overrode that).
--   * Pointer clears (purgeImagesForSubSegments; unapprove_segment_bundle): every caller also
--     deletes the card or rewrites its content (still reset by this trigger) or sets the cards to
--     'draft' itself.
--
-- BOTH PROJECTS: schema only, no rows. Idempotent (DROP TRIGGER IF EXISTS + CREATE).
-- APPLY per migrations/README.md: financial first, then Moosii.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT the 066 definition, image in the column list:
--   SELECT pg_get_triggerdef(oid) FROM pg_trigger
--    WHERE tgrelid = 'public.sub_segments'::regclass AND tgname = 'sub_segments_reset_review_trg';
--   -- … AFTER INSERT OR DELETE OR UPDATE OF title, content, image, sequence ON public.sub_segments …
-- ---------------------------------------------------------------------------

BEGIN;

DROP TRIGGER IF EXISTS sub_segments_reset_review_trg ON public.sub_segments;
CREATE TRIGGER sub_segments_reset_review_trg
  AFTER INSERT OR DELETE OR UPDATE OF title, content, sequence
  ON public.sub_segments
  FOR EACH ROW EXECUTE FUNCTION public.sub_segments_reset_review();

COMMENT ON FUNCTION public.sub_segments_reset_review() IS
  'Migration 066 (column list narrowed by 092): a content edit sends cards back to draft and '
  'recomputes seg_status. Structural changes (insert/delete/reorder) reset the WHOLE segment because '
  'card roles are role-by-position (invariant 2); a title/content edit resets only that card. '
  'Writing sub_segments.image does NOT reset: that write is an image approval (092).';

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying (read-only / rolled back).
-- 1. EXPECT … AFTER INSERT OR DELETE OR UPDATE OF title, content, sequence ON public.sub_segments …
--    SELECT pg_get_triggerdef(oid) FROM pg_trigger
--     WHERE tgrelid = 'public.sub_segments'::regclass AND tgname = 'sub_segments_reset_review_trg';
-- 2. Approve a whole segment in a ROLLED-BACK transaction: promote its cards to
--    editorial_reviewed, call approve_segment_bundle with each card's latest linkable candidate,
--    then EXPECT every card clinically_approved and seg_status 'complete'. The script used for the
--    apply is docs/drafts/092-approve-proof.sql.
-- 3. A text edit still resets (rolled back): UPDATE sub_segments SET content = content || ' '
--    WHERE id = '<approved card>'; EXPECT that card 'draft'.
-- ============================================================================
