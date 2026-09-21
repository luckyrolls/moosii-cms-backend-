-- ============================================================================
-- MIGRATION 093: a picture swap on a clinically-approved card needs clinical review again
--   — APPLIED financial 2026-09-21 · APPLIED Moosii 2026-09-21 — BOTH PROJECTS
-- ============================================================================
-- DECISION (Mark, 2026-09-21): approving a DIFFERENT image on a card whose review_state is
-- 'clinically_approved' drops that card to 'editorial_reviewed' (awaiting clinical review) — not to
-- draft: the text needs no re-edit, the new picture needs a clinician's eye (Moosii images carry
-- safety meaning, e.g. safe sleep). After 092 such a swap would otherwise reach parents unreviewed.
-- Re-writing the SAME image must reset nothing (the 092 bug stays fixed). A card that is not yet
-- clinically approved is unaffected.
--
-- WHERE IT LIVES — a trigger, not approve_content_image:
--   * The database can tell "image changed" from "same image re-written": OLD.image vs NEW.image in
--     the trigger's WHEN clause. The rule is about the column, whoever writes it.
--   * Three writers put an approved image on a card: both approve_content_image overloads AND the
--     generate job's auto_approve path, which UPDATEs sub_segments.image directly
--     (generateSubSegmentImage.ts:287). A function-level rule would miss the third.
--   * Removing a picture (NEW.image NULL) is out of scope: it only happens alongside a card delete,
--     a content rewrite or an explicit draft (see 092), which already reset further.
--
-- WHY approve_segment_bundle CHANGES TOO. It promoted the cards FIRST and wrote the images second.
-- With this trigger, that order would promote a freshly reviewed card and then demote it on its own
-- new image — the 092 bug again, for every lesson with new pictures. New order:
--   1. remember the cards that are 'editorial_reviewed' NOW (the ones this sign-off promotes);
--   2. approve the quiz (unchanged) and the images — a card that was ALREADY clinically approved and
--      gets a different picture is demoted to editorial_reviewed by the trigger;
--   3. promote ONLY the cards remembered in step 1 (editorial_reviewed → clinically_approved).
-- So a card whose new picture arrives with this sign-off ends clinically approved, and a card that
-- was approved before and has its picture swapped ends editorial_reviewed — the decision's rule,
-- applied inside whole-lesson approval too. The returned seg_status is computed AFTER both steps, so
-- the route reports the truth (e.g. 'pending' when a swap is waiting for clinical review).
-- Signature, return shape and privileges of approve_segment_bundle are unchanged
-- (CREATE OR REPLACE keeps its ACL).
--
-- Trigger ordering: AFTER triggers on one table fire in name order; the new
-- `sub_segments_image_swap_review_trg` sorts before `sub_segments_reset_review_trg` (066/092), so a
-- statement that changes image AND text ends at 'draft' either way.
--
-- BOTH PROJECTS: schema only, no rows. Idempotent (CREATE OR REPLACE + DROP TRIGGER IF EXISTS).
-- APPLY per migrations/README.md: financial first, then Moosii. Requires 092.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT 9d331c9b… (the 029-era bundle, same on both projects)
-- and the 092 trigger (title, content, sequence):
--   SELECT md5(pg_get_functiondef('public.approve_segment_bundle'::regproc));
--   SELECT pg_get_triggerdef(oid) FROM pg_trigger
--    WHERE tgrelid = 'public.sub_segments'::regclass AND tgname = 'sub_segments_reset_review_trg';
-- ---------------------------------------------------------------------------

BEGIN;

-- ---- 1. The rule, on the column --------------------------------------------
-- SECURITY DEFINER for the same reason as 066: recompute_seg_status and segments.seg_status are
-- not writable by the CMS's roles.
CREATE OR REPLACE FUNCTION public.sub_segments_image_swap_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE sub_segments
     SET review_state = 'editorial_reviewed'
   WHERE id = NEW.id
     AND review_state = 'clinically_approved';
  IF FOUND THEN
    PERFORM recompute_seg_status(NEW.seg_id);
  END IF;
  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.sub_segments_image_swap_review() IS
  'Migration 093: a DIFFERENT image written onto a clinically_approved card drops it to '
  'editorial_reviewed (awaiting clinical review) and recomputes seg_status. Re-writing the same '
  'image does nothing (WHEN clause).';

DROP TRIGGER IF EXISTS sub_segments_image_swap_review_trg ON public.sub_segments;
CREATE TRIGGER sub_segments_image_swap_review_trg
  AFTER UPDATE OF image ON public.sub_segments
  FOR EACH ROW
  WHEN (NEW.image IS NOT NULL
        AND OLD.image IS DISTINCT FROM NEW.image
        AND OLD.review_state = 'clinically_approved')
  EXECUTE FUNCTION public.sub_segments_image_swap_review();

-- ---- 2. Whole-lesson approval: images first, then promote --------------------
CREATE OR REPLACE FUNCTION public.approve_segment_bundle(p_seg_id uuid, p_approved_by uuid, p_images jsonb)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_img             jsonb;
  v_images_approved integer := 0;
  v_quiz_approved   integer;
  v_card            json;
  v_to_promote      uuid[];
BEGIN
  -- The cards THIS clinical sign-off promotes: those editorial_reviewed now. Captured before the
  -- images are written, so a card demoted by an image swap below (093) is not re-promoted here.
  -- Cards still in 'draft' (editorial not done) are never promoted.
  SELECT coalesce(array_agg(id), '{}') INTO v_to_promote
    FROM sub_segments
   WHERE seg_id = p_seg_id AND review_state = 'editorial_reviewed';

  UPDATE quiz_questions SET answer_status = 'approved', updated_at = now()
  WHERE segment_id = p_seg_id;
  GET DIAGNOSTICS v_quiz_approved = ROW_COUNT;

  -- Images BEFORE cards (093): a different picture on an already clinically approved card drops it
  -- to editorial_reviewed; on a card being promoted now, the picture is part of this sign-off.
  FOR v_img IN SELECT * FROM jsonb_array_elements(p_images) LOOP
    PERFORM approve_content_image(
      (v_img->>'id')::uuid, p_approved_by, v_img->>'public_url', v_img->>'storage_path');
    v_images_approved := v_images_approved + 1;
  END LOOP;

  -- Content: clinically approve the remembered cards and recompute (seg_status is derived).
  v_card := set_card_review_state(p_seg_id, v_to_promote, 'clinically_approved', 'editorial_reviewed', p_approved_by);

  RETURN json_build_object(
    'segment_id',      p_seg_id,
    'seg_status',      v_card->>'seg_status',
    'quiz_approved',   v_quiz_approved,
    'images_approved', v_images_approved
  );
END $function$;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying (read-only / rolled back).
-- 1. EXPECT the trigger with its WHEN clause, and the new bundle body (images before cards):
--    SELECT pg_get_triggerdef(oid) FROM pg_trigger
--     WHERE tgrelid = 'public.sub_segments'::regclass AND tgname = 'sub_segments_image_swap_review_trg';
-- 2. docs/drafts/093-swap-proof.sql against one segment with a linkable candidate per card (all
--    rolled back): fresh images + whole-lesson approve → all clinically approved; swap on a
--    clinically approved card (single approve AND whole-lesson) → that card editorial_reviewed,
--    segment pending; same image re-written → nothing moves; swap on an editorial card → stage
--    unchanged; text edit → that card draft.
-- ============================================================================
