-- ============================================================================
-- Migration 029: bulk lesson approval — content + images + quiz in one transaction
-- ============================================================================
-- The app gates each artifact independently: content cards on segments.seg_status
-- = 'complete', images on sub_segments.image, quiz on quiz_questions.answer_status
-- = 'approved'. Content and image approvals existed; QUIZ had NO approve path, so
-- generated quizzes were stuck 'pending' and the app showed "no questions". This
-- adds the missing quiz flip and bundles all three so a lesson's content, images,
-- and quiz cross the app's gate together.
--
-- approve_segment_bundle: sets seg_status='complete', flips quiz_questions
-- answer_status→'approved', and approves each pre-resolved candidate image by reusing
-- approve_content_image (supersede-then-approve + write sub_segments.image). Atomic —
-- one transaction, so it fails toward UNDER-exposure, never leaking a partially
-- unreviewed lesson. Image public URLs are resolved by the handler (Node owns storage
-- URL construction) and passed in p_images.
--
-- unapprove_segment_bundle: full mirror — seg_status→'pending', quiz→'pending',
-- approved images → 'candidate', clear the sub_segments.image live pointer. Nothing is
-- regenerated; fully reversible.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..029 reconciliation list.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION approve_segment_bundle(
  p_seg_id      uuid,
  p_approved_by uuid,     -- nullable
  p_images      jsonb     -- [{ "id": uuid, "public_url": text, "storage_path": text }, ...]
) RETURNS json
LANGUAGE plpgsql AS $$
DECLARE
  v_img             jsonb;
  v_images_approved integer := 0;
  v_quiz_approved   integer;
BEGIN
  -- Content: gate the cards.
  UPDATE segments SET seg_status = 'complete', approved_by = p_approved_by, updated_at = now()
  WHERE id = p_seg_id;

  -- Quiz: flip pending → approved (the missing piece).
  UPDATE quiz_questions SET answer_status = 'approved', updated_at = now()
  WHERE segment_id = p_seg_id;
  GET DIAGNOSTICS v_quiz_approved = ROW_COUNT;

  -- Images: approve each pre-resolved candidate (reuse the proven approve fn).
  FOR v_img IN SELECT * FROM jsonb_array_elements(p_images) LOOP
    PERFORM approve_content_image(
      (v_img->>'id')::uuid,
      p_approved_by,
      v_img->>'public_url',
      v_img->>'storage_path'
    );
    v_images_approved := v_images_approved + 1;
  END LOOP;

  RETURN json_build_object(
    'segment_id',      p_seg_id,
    'quiz_approved',   v_quiz_approved,
    'images_approved', v_images_approved
  );
END $$;

CREATE OR REPLACE FUNCTION unapprove_segment_bundle(p_seg_id uuid)
RETURNS json
LANGUAGE plpgsql AS $$
DECLARE
  v_images_reverted integer;
  v_quiz_reverted   integer;
BEGIN
  UPDATE segments SET seg_status = 'pending', approved_by = NULL, updated_at = now()
  WHERE id = p_seg_id;

  UPDATE quiz_questions SET answer_status = 'pending', updated_at = now()
  WHERE segment_id = p_seg_id;
  GET DIAGNOSTICS v_quiz_reverted = ROW_COUNT;

  -- Revert approved images for this segment's cards → candidate; clear the live pointer.
  UPDATE content_images SET status = 'candidate'
  WHERE sub_segment_id IN (SELECT id FROM sub_segments WHERE seg_id = p_seg_id)
    AND status = 'approved';
  GET DIAGNOSTICS v_images_reverted = ROW_COUNT;

  UPDATE sub_segments SET image = NULL, image_path = NULL WHERE seg_id = p_seg_id;

  RETURN json_build_object(
    'segment_id',      p_seg_id,
    'quiz_reverted',   v_quiz_reverted,
    'images_reverted', v_images_reverted
  );
END $$;

COMMIT;
