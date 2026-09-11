-- ============================================================================
-- Migration 066: approval-reset triggers for the CMS-direct content paths (DRAFT)
-- ============================================================================
-- FROM: FINDINGS-published-edit.md §A.2 rows 10-12. Three content paths write
-- Supabase-DIRECT from the CMS and reset NOTHING, so an edit reaches parents with no review
-- and no audit:
--   10. card REORDER   — sub_segments.sequence (moosii-cms src/data/cards.ts renumberContiguous)
--   11. ADD CARD       — sub_segments INSERT   (cards.ts useAddCard)
--   12. QUIZ EDIT      — quiz_questions.question_text / quiz_answers.* (cards.ts useUpdateQuiz)
-- Row 12 is the sharpest: editing the text of an APPROVED question left answer_status
-- 'approved', so the new wording went live unreviewed.
--
-- A trigger is the right shape here precisely BECAUSE these bypass the backend. The
-- equivalent backend paths (PATCH /sub-segments/:id, upload-image) already reset via
-- resetCardsAndReport; after this migration they reset twice, which is idempotent and
-- harmless. Their explicit reset can be retired later — NOT in this migration, because
-- belt-and-braces costs nothing and removing it is a separate, testable change.
--
-- ── WHAT COUNTS AS "THE AFFECTED CARDS" ─────────────────────────────────────
-- Not always the row that changed:
--   * title / content / image changed  → THAT card only (matches the backend's behaviour).
--   * sequence changed, card INSERTed, card DELETEd → EVERY card in the segment. Card roles
--     are ROLE-BY-POSITION (CLAUDE.md invariant 2: first / body / takeaway are derived from
--     `sequence`, never pinned per card), so moving, adding or removing one card changes what
--     the surrounding cards ARE. Re-reviewing only the moved card would miss that.
-- Quiz is simpler: any change to a question's text, or to any of its answers, sends THAT
-- question back to 'pending'. Sibling questions are untouched.
--
-- NO RECURSION. Each trigger is scoped with `UPDATE OF <content columns>`, and the reset
-- writes only `review_state` / `answer_status`, which appear in no column list. So the reset
-- cannot re-fire the trigger that produced it.
--
-- NO CHURN. Both resets are guarded with `IS DISTINCT FROM`, so a card already in 'draft' is
-- not rewritten and `recompute_seg_status` is only called when something actually moved.
--
-- INTERACTION WITH 064: on the block domain the guard raises first and the statement aborts,
-- so these resets never run there. On a warn domain the guard is inert and these do the work.
--
-- FINANCIAL PROJECT: inherits this via the schema dump.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..066 reconciliation list, after 064/065.
-- Idempotent: CREATE OR REPLACE + DROP TRIGGER IF EXISTS.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST. The live blast radius: approved cards and approved quiz questions
-- that a future CMS-direct edit would now send back for review. Informational — this
-- migration changes NO existing row, it only governs future writes.
--   SELECT count(*) FILTER (WHERE ss.review_state = 'clinically_approved') AS approved_cards,
--          count(*) FILTER (WHERE ss.review_state = 'editorial_reviewed')  AS editorial_cards
--     FROM sub_segments ss;
--   SELECT count(*) AS approved_quiz_questions
--     FROM quiz_questions WHERE answer_status = 'approved';
-- ---------------------------------------------------------------------------

BEGIN;

-- ---- 1. Cards ---------------------------------------------------------------
-- SECURITY DEFINER: recompute_seg_status' EXECUTE is service_role-only (056) and
-- segments.seg_status is REVOKEd from every role (057), so the reset must run as the owner.
CREATE OR REPLACE FUNCTION public.sub_segments_reset_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seg_id     uuid := COALESCE(NEW.seg_id, OLD.seg_id);
  v_whole_seg  boolean;
  v_changed    integer;
BEGIN
  IF v_seg_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Structural change (insert / delete / reorder) → the whole segment, because roles are
  -- derived from position. A pure text/image edit → just this card.
  v_whole_seg := TG_OP IN ('INSERT', 'DELETE')
                 OR (TG_OP = 'UPDATE' AND NEW.sequence IS DISTINCT FROM OLD.sequence);

  IF v_whole_seg THEN
    UPDATE sub_segments
       SET review_state = 'draft'
     WHERE seg_id = v_seg_id
       AND review_state IS DISTINCT FROM 'draft';
  ELSE
    UPDATE sub_segments
       SET review_state = 'draft'
     WHERE id = NEW.id
       AND review_state IS DISTINCT FROM 'draft';
  END IF;

  GET DIAGNOSTICS v_changed = ROW_COUNT;

  -- Recompute whenever the card set or its states could have moved. A DELETE changes the
  -- card COUNT, which the 056 derivation reads (>=1 card required), so recompute even when
  -- no review_state row was rewritten.
  IF v_changed > 0 OR TG_OP IN ('INSERT', 'DELETE') THEN
    PERFORM recompute_seg_status(v_seg_id);
  END IF;

  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.sub_segments_reset_review() IS
  'Migration 066: a content edit sends cards back to draft and recomputes seg_status. '
  'Structural changes (insert/delete/reorder) reset the WHOLE segment because card roles are '
  'role-by-position (invariant 2); a text/image edit resets only that card.';

DROP TRIGGER IF EXISTS sub_segments_reset_review_trg ON public.sub_segments;
CREATE TRIGGER sub_segments_reset_review_trg
  AFTER INSERT OR DELETE OR UPDATE OF title, content, image, sequence
  ON public.sub_segments
  FOR EACH ROW EXECUTE FUNCTION public.sub_segments_reset_review();

-- ---- 2. Quiz ----------------------------------------------------------------
-- One function for both tables; the question is resolved from whichever fired.
CREATE OR REPLACE FUNCTION public.quiz_reset_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_question_id uuid;
BEGIN
  v_question_id := CASE TG_TABLE_NAME
    WHEN 'quiz_questions' THEN COALESCE(NEW.question_id, OLD.question_id)
    WHEN 'quiz_answers'   THEN COALESCE(NEW.question_id, OLD.question_id)
  END;

  IF v_question_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE quiz_questions
     SET answer_status = 'pending'
   WHERE question_id = v_question_id
     AND answer_status IS DISTINCT FROM 'pending';

  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.quiz_reset_review() IS
  'Migration 066: editing a quiz question''s text, or any of its answers, sends THAT question '
  'back to answer_status=pending. Closes the hole where a CMS-direct edit to an APPROVED '
  'question reached parents unreviewed (FINDINGS-published-edit.md §A.2 row 12).';

-- Question text only. answer_status is excluded, so the approve/unapprove route (and this
-- trigger's own write) cannot re-fire it.
DROP TRIGGER IF EXISTS quiz_questions_reset_review_trg ON public.quiz_questions;
CREATE TRIGGER quiz_questions_reset_review_trg
  AFTER UPDATE OF question_text, question_explanation, image_url, type
  ON public.quiz_questions
  FOR EACH ROW EXECUTE FUNCTION public.quiz_reset_review();

-- Any answer change at all is a content change to its question.
DROP TRIGGER IF EXISTS quiz_answers_reset_review_trg ON public.quiz_answers;
CREATE TRIGGER quiz_answers_reset_review_trg
  AFTER INSERT OR DELETE OR UPDATE OF answer_text, is_correct, response, score
  ON public.quiz_answers
  FOR EACH ROW EXECUTE FUNCTION public.quiz_reset_review();

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying. All of these ROLL BACK.
--
-- 1. REORDER resets the whole segment (row 10). Pick a segment with >1 approved card:
--    BEGIN;
--      SELECT id, sequence, review_state FROM sub_segments WHERE seg_id = '<seg>' ORDER BY sequence;
--      UPDATE sub_segments SET sequence = sequence + 100 WHERE seg_id = '<seg>';
--      SELECT count(*) FILTER (WHERE review_state <> 'draft') AS not_draft
--        FROM sub_segments WHERE seg_id = '<seg>';            -- EXPECT 0
--      SELECT seg_status FROM segments WHERE id = '<seg>';    -- EXPECT 'pending'
--    ROLLBACK;
--
-- 2. ADD CARD resets the whole segment (row 11):
--    BEGIN;
--      INSERT INTO sub_segments (seg_id, sequence, title, content)
--      VALUES ('<seg>', 9999, '', '');
--      SELECT count(*) FILTER (WHERE review_state <> 'draft') FROM sub_segments WHERE seg_id = '<seg>';
--    ROLLBACK;                                                -- EXPECT 0
--
-- 3. A TEXT edit resets ONLY that card (not the whole segment):
--    BEGIN;
--      UPDATE sub_segments SET content = content || '' WHERE id = '<one approved card>';
--      SELECT id, review_state FROM sub_segments WHERE seg_id = '<seg>' ORDER BY sequence;
--    ROLLBACK;   -- EXPECT exactly one row flipped to 'draft'
--
-- 4. QUIZ edit un-approves that question (row 12 — the sharpest hole):
--    BEGIN;
--      SELECT question_id, answer_status FROM quiz_questions WHERE answer_status = 'approved' LIMIT 1;
--      UPDATE quiz_questions SET question_text = question_text || '' WHERE question_id = '<q>';
--      SELECT answer_status FROM quiz_questions WHERE question_id = '<q>';   -- EXPECT 'pending'
--    ROLLBACK;
--
-- 5. ANSWER edit un-approves its parent question:
--    BEGIN;
--      UPDATE quiz_answers SET answer_text = answer_text || '' WHERE question_id = '<q>';
--      SELECT answer_status FROM quiz_questions WHERE question_id = '<q>';   -- EXPECT 'pending'
--    ROLLBACK;
--
-- 6. The APPROVE route still works (no recursion, no self-block):
--    BEGIN;
--      UPDATE quiz_questions SET answer_status = 'approved' WHERE question_id = '<q>';
--      SELECT answer_status FROM quiz_questions WHERE question_id = '<q>';   -- EXPECT 'approved'
--    ROLLBACK;
-- ============================================================================
