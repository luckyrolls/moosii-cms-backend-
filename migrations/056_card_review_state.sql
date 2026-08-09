-- ============================================================================
-- Migration 056: card-level review state + capabilities + derived seg_status (DRAFT)
-- ============================================================================
-- DRAFT — NOT applied by the agent. APPLY VIA THE SUPABASE SQL EDITOR after review; on the
-- 008..056 reconciliation list. Apply order: after 055.
--
-- WHAT. seg_status becomes DERIVED from the CARDS beneath it. Cards (sub_segments) hold the
-- review truth in a new 4-state-minus-published column; every transition recomputes the
-- segment's seg_status in the SAME transaction via recompute_seg_status(). seg_status keeps
-- its EXACT shape/meaning ('complete' | 'pending') — the app-facing gate is unchanged — but
-- can no longer be set independently of its cards.
--
-- NEW RULE (deliberate tightening): a segment reaches 'complete' only if it has >= 1 card
-- AND every card is clinically_approved. There is NO card-count guard on approval today
-- (segments.ts / approve_segment_bundle set seg_status unconditionally), so a cardless
-- segment could be marked complete. The EXISTS(>=1 card) clause below is a NEW guard, not a
-- preserved one — a cardless segment now stays 'pending'.
--
-- CAPABILITIES separate from ROLE. Role controls what you SEE; capability controls what you
-- can SIGN. Two booleans on "user" (default false) — added to the verifyAdminJwt SELECT so
-- they ride on req.user with no extra query. Grants (Megan clinical; Michelle editorial +
-- clinical; Mark neither) are a DATA step, not schema.
--
-- BACKFILL: EVERY existing card → 'draft'. No auto-grant of any state — a clinically_approved
-- backfill would fabricate a credentialed health sign-off attributable to nobody (worse than
-- re-review), and editorial_reviewed has the same disease. Pre-launch, re-review is cheap.
-- Consequence: every currently-'complete' segment recomputes to 'pending' until re-reviewed.
--
-- GUARD-READY: recompute_seg_status / set_card_review_state are SECURITY DEFINER so the
-- follow-up privilege guard (REVOKE UPDATE(seg_status); see the un-numbered
-- GUARD_seg_status_revoke.sql draft) drops in with ZERO backend change. EXECUTE is locked to
-- service_role so capability enforcement lives solely in the backend routes (a direct RPC
-- call cannot bypass the Node capability check).
-- ============================================================================

BEGIN;

-- 1. Card review state — the source of truth. Backfill = the NOT NULL DEFAULT on existing rows.
ALTER TABLE sub_segments ADD COLUMN IF NOT EXISTS review_state text NOT NULL DEFAULT 'draft'
  CHECK (review_state IN ('draft','editorial_reviewed','clinically_approved'));

-- 2. Capabilities (separate from role). Default false; grants are a data step.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS can_review_editorial boolean NOT NULL DEFAULT false;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS can_approve_clinical boolean NOT NULL DEFAULT false;

-- 3. content_approvals: admit 'sub_segment', add the per-stage actions, add a reject reason.
ALTER TABLE content_approvals DROP CONSTRAINT IF EXISTS content_approvals_entity_type_check;
ALTER TABLE content_approvals ADD  CONSTRAINT content_approvals_entity_type_check
  CHECK (entity_type IN ('segment','image','quiz','questionnaire','lesson','sub_segment'));
ALTER TABLE content_approvals DROP CONSTRAINT IF EXISTS content_approvals_action_check;
ALTER TABLE content_approvals ADD  CONSTRAINT content_approvals_action_check
  CHECK (action IN ('approve','unapprove','publish','unpublish',
                    'editorial_approve','clinical_approve','reject'));
ALTER TABLE content_approvals ADD COLUMN IF NOT EXISTS reason text;

-- 4. recompute_seg_status — the ONLY writer of seg_status. Locks the segment row so
--    concurrent card transitions serialize; the last committer's recompute sees every
--    committed card state, so the final gate is always correct. approved_by is nulled when
--    the result is 'pending' (no longer fully clinically approved).
CREATE OR REPLACE FUNCTION recompute_seg_status(p_seg_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status text;
BEGIN
  PERFORM 1 FROM segments WHERE id = p_seg_id FOR UPDATE;   -- serialize per-segment recomputes
  v_status := CASE
    WHEN EXISTS (SELECT 1 FROM sub_segments WHERE seg_id = p_seg_id)
     AND NOT EXISTS (SELECT 1 FROM sub_segments
                     WHERE seg_id = p_seg_id AND review_state IS DISTINCT FROM 'clinically_approved')
    THEN 'complete' ELSE 'pending' END;
  UPDATE segments SET
    seg_status  = v_status,
    updated_at  = now(),
    approved_by = CASE WHEN v_status = 'pending' THEN NULL ELSE approved_by END
  WHERE id = p_seg_id;
  RETURN v_status;
END $$;

-- 5. set_card_review_state — bulk/surgical transition + ONE recompute, atomic under the
--    segment lock. p_card_ids NULL = every card in the segment. p_from_state NULL = any
--    current state; non-null enforces the step order (draft→editorial→clinical) at the data
--    layer. approved_by is stamped only on a clinical approval. Capability is enforced in
--    the backend route BEFORE this is called (EXECUTE is service_role-only).
CREATE OR REPLACE FUNCTION set_card_review_state(
  p_seg_id    uuid,
  p_card_ids  uuid[],
  p_new_state text,
  p_from_state text,
  p_actor     uuid
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count integer; v_status text;
BEGIN
  PERFORM 1 FROM segments WHERE id = p_seg_id FOR UPDATE;   -- serialize
  UPDATE sub_segments SET review_state = p_new_state
   WHERE seg_id = p_seg_id
     AND (p_card_ids IS NULL OR id = ANY(p_card_ids))
     AND (p_from_state IS NULL OR review_state = p_from_state);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF p_new_state = 'clinically_approved' AND p_actor IS NOT NULL THEN
    UPDATE segments SET approved_by = p_actor WHERE id = p_seg_id;
  END IF;
  v_status := recompute_seg_status(p_seg_id);
  RETURN json_build_object('segment_id', p_seg_id, 'cards_updated', v_count, 'seg_status', v_status);
END $$;

-- 6. Bundle approve/unapprove (migration 029) cut over to the card model. NO direct
--    seg_status write remains — recompute owns it.
CREATE OR REPLACE FUNCTION approve_segment_bundle(
  p_seg_id      uuid,
  p_approved_by uuid,
  p_images      jsonb
) RETURNS json
LANGUAGE plpgsql AS $$
DECLARE
  v_img             jsonb;
  v_images_approved integer := 0;
  v_quiz_approved   integer;
  v_card            json;
BEGIN
  -- Content: clinically approve the cards (editorial_reviewed → clinically_approved) and
  -- recompute. Cards still in 'draft' (editorial not done) are NOT promoted, so the segment
  -- only reaches 'complete' once editorial preceded clinical.
  v_card := set_card_review_state(p_seg_id, NULL, 'clinically_approved', 'editorial_reviewed', p_approved_by);

  UPDATE quiz_questions SET answer_status = 'approved', updated_at = now()
  WHERE segment_id = p_seg_id;
  GET DIAGNOSTICS v_quiz_approved = ROW_COUNT;

  FOR v_img IN SELECT * FROM jsonb_array_elements(p_images) LOOP
    PERFORM approve_content_image(
      (v_img->>'id')::uuid, p_approved_by, v_img->>'public_url', v_img->>'storage_path');
    v_images_approved := v_images_approved + 1;
  END LOOP;

  RETURN json_build_object(
    'segment_id',      p_seg_id,
    'seg_status',      v_card->>'seg_status',
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
  v_card            json;
BEGIN
  -- Content: all cards back to 'draft' and recompute (→ 'pending').
  v_card := set_card_review_state(p_seg_id, NULL, 'draft', NULL, NULL);

  UPDATE quiz_questions SET answer_status = 'pending', updated_at = now()
  WHERE segment_id = p_seg_id;
  GET DIAGNOSTICS v_quiz_reverted = ROW_COUNT;

  UPDATE content_images SET status = 'candidate'
  WHERE sub_segment_id IN (SELECT id FROM sub_segments WHERE seg_id = p_seg_id)
    AND status = 'approved';
  GET DIAGNOSTICS v_images_reverted = ROW_COUNT;

  UPDATE sub_segments SET image = NULL, image_path = NULL WHERE seg_id = p_seg_id;

  RETURN json_build_object(
    'segment_id',      p_seg_id,
    'seg_status',      v_card->>'seg_status',
    'quiz_reverted',   v_quiz_reverted,
    'images_reverted', v_images_reverted
  );
END $$;

-- 7. Lock EXECUTE to the backend service role — capability is enforced in the routes, and a
--    direct RPC call must not bypass it. (approve_content_image is reused as-is.)
REVOKE EXECUTE ON FUNCTION recompute_seg_status(uuid)                         FROM public;
REVOKE EXECUTE ON FUNCTION set_card_review_state(uuid, uuid[], text, text, uuid) FROM public;
GRANT  EXECUTE ON FUNCTION recompute_seg_status(uuid)                         TO service_role;
GRANT  EXECUTE ON FUNCTION set_card_review_state(uuid, uuid[], text, text, uuid) TO service_role;

COMMIT;
