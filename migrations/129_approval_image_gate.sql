-- 129 — APPROVAL SAFETY: an un-adjudicated image holds the segment's gate.
--
-- *** BOTH PROJECTS *** — schema only, no rows rewritten by this file.
-- *** REVIEW REQUIRED: this REPLACES recompute_seg_status, the SINGLE writer of
--     segments.seg_status, which the app and three RLS SELECT policies key on. Do not apply
--     without Mark's explicit go per project. FINANCIAL first, then MOOSII on a second go. ***
--
-- STATUS: DRAFT (pending apply).
--
-- WHAT CHANGES. `recompute_seg_status` gains ONE clause. A segment is 'complete' iff
--     >= 1 card                                                (056, unchanged)
-- AND every card is 'clinically_approved'                       (056, unchanged)
-- AND no card has an UN-ADJUDICATED IMAGE                       (NEW)
-- where un-adjudicated = the card has NO approved image but DOES have a candidate: a picture
-- nobody has ruled on, with nothing live to fall back to.
--
-- WHAT DELIBERATELY DOES NOT BLOCK. A replacement candidate BESIDE an approved image. The live
-- picture is still the approved one, so pressing regenerate on a published lesson must not drop
-- it to published_unreviewed. That asymmetry is the whole point; it is why the clause is
-- "no approved image AND a candidate" and not "any candidate".
--
-- WHY A GATE RATHER THAN A CARD RESET. Before slice A1 a new candidate sent its card to 'draft'
-- in application code (generateSubSegmentImage.ts:297, subSegments.ts:297), spending the
-- editorial review of text nobody had edited. The code now demotes clinical only, and only when
-- there is no approved image to fall back on (src/lib/approvalSafety.ts
-- `candidateArrivalTarget`). The requirement "the lesson is not complete until the image is
-- approved" is what THIS clause enforces — in the derived gate, where every reader already
-- looks, instead of by destroying review state.
--
-- THE SECOND HALF: A RECOMPUTE-ONLY TRIGGER ON content_images. A card's review_state does not
-- change when a candidate lands beside an approved image, so nothing would otherwise re-derive
-- the gate. `content_images_recompute` fires on INSERT / DELETE / UPDATE OF status and does
-- exactly one thing: PERFORM recompute_seg_status. It NEVER writes a card's review state.
-- recompute_seg_status stays the single writer of seg_status (invariant preserved).
--
-- ⚠ RECURSION AND ORDERING, CHECKED.
--   * The trigger only calls recompute_seg_status, which writes `segments` — a different table —
--     so it cannot re-fire itself. There is no trigger on segments.seg_status.
--   * `approve_content_image` supersedes the old approved row and then approves the new one: two
--     UPDATEs of status, so two recomputes, in one transaction. The intermediate one may read
--     'pending' (no approved image + a candidate); the final one reads the truth. Only the last
--     value is ever committed.
--   * `approve_segment_bundle` loops approve_content_image, so it recomputes once per image and
--     once more at the end via set_card_review_state. All in one transaction, all taking
--     `FOR UPDATE` on the SAME segment row, so they serialize behind each other rather than
--     deadlock. Wasted work, not a hazard; the catalog is small (354 content_images rows live).
--   * A card DELETE cascades to its content_images rows and fires this trigger, but the
--     sub_segment is already gone, so the seg_id lookup returns NULL and it returns early. 066's
--     own trigger does the recompute for a card delete.
--   * A LESSON- or SEGMENT-level image (sub_segment_id IS NULL — the polymorphic case) has no
--     card gate to recompute and returns early.
--
-- INDEXES: none needed. `content_images_one_approved_per_sub_segment`
-- (UNIQUE (sub_segment_id) WHERE status='approved') serves the approved EXISTS exactly, and
-- `content_images_sub_segment_id_idx` serves the candidate EXISTS. Verified live 2026-11-25.
--
-- MLP / card_positions: untouched. No prompt row, no prompt block (invariant 2). `mlp_item_pool`
-- and `user_active_tracks_for_user` are not referenced (invariants 1 and 8) — note that the pool
-- keys on `lessons.is_published`, NOT on seg_status, so this file changes no user's plan and
-- needs no rebuild.
--
-- WHAT THIS DOES NOT DO: no repair of the 25 stale 'complete' segments
-- (docs/FINDINGS-complete-with-draft-cards.md — its own migration, its own go), no guard against
-- a hand-written seg_status write, no CMS, no reports/preview (slice A2).
--
-- ── UNDO ────────────────────────────────────────────────────────────────────────────────────
--   1. DROP TRIGGER content_images_recompute_trg ON public.content_images;
--   2. DROP FUNCTION public.content_images_recompute();
--   3. Restore recompute_seg_status to its pre-129 body — the exact text is in section 2's
--      comment below, and the restored function must hash back to
--         md5(replace(pg_get_functiondef(...), chr(13), '')) = 660ed036da2cf30d2886244d850e7dab
--      Then re-apply the 094 grants (REVOKE … FROM PUBLIC, anon, authenticated; GRANT … TO
--      service_role), which a CREATE OR REPLACE keeps but a DROP+CREATE would discard.
--   4. Re-derive every segment the gate had moved:
--         SELECT recompute_seg_status(id) FROM segments;
--      (safe: with the clause gone it reproduces the 056 verdict.)
-- No row written by this file needs undoing — it writes none.
-- ────────────────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ================================================================ PRE-CHECK
DO $$
DECLARE
  v_domain text;
  v_md5    text;
BEGIN
  SELECT value INTO v_domain FROM public.app_settings WHERE key = 'domain';
  IF v_domain IS NULL OR v_domain NOT IN ('moosii', 'financial') THEN
    RAISE EXCEPTION '129 PRE-CHECK: app_settings.domain is %, expected moosii or financial', v_domain;
  END IF;

  -- The ONE body this migration knows how to replace. Compared after stripping CR, because a
  -- live function body may carry CRLF (CLAUDE.md; migration 118 reverted 115 by guarding on a
  -- substring that two different bodies both satisfied — this is an EXACT hash instead).
  SELECT md5(replace(pg_get_functiondef('public.recompute_seg_status(uuid)'::regprocedure), chr(13), ''))
    INTO v_md5;
  IF v_md5 <> '660ed036da2cf30d2886244d850e7dab' THEN
    RAISE EXCEPTION '129 PRE-CHECK: recompute_seg_status is not the known 056 body (md5 %). '
      'Refusing to replace a function this file has not seen.', v_md5;
  END IF;

  IF to_regprocedure('public.content_images_recompute()') IS NOT NULL THEN
    RAISE EXCEPTION '129 PRE-CHECK: content_images_recompute() already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE NOT tgisinternal AND tgname = 'content_images_recompute_trg') THEN
    RAISE EXCEPTION '129 PRE-CHECK: content_images_recompute_trg already exists';
  END IF;

  RAISE NOTICE '129 PRE-CHECK ok on domain %', v_domain;
END $$;

-- ================================================================ 1. the gate
-- The pre-129 body, for the undo above, was identical EXCEPT that the CASE had only the first
-- two conditions:
--     WHEN EXISTS (SELECT 1 FROM sub_segments WHERE seg_id = p_seg_id)
--      AND NOT EXISTS (SELECT 1 FROM sub_segments
--                      WHERE seg_id = p_seg_id AND review_state IS DISTINCT FROM 'clinically_approved')
--     THEN 'complete' ELSE 'pending' END;
-- Everything else — the FOR UPDATE, the UPDATE, the approved_by nulling — is unchanged.
CREATE OR REPLACE FUNCTION public.recompute_seg_status(p_seg_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_status text;
BEGIN
  PERFORM 1 FROM segments WHERE id = p_seg_id FOR UPDATE;   -- serialize per-segment recomputes
  v_status := CASE
    WHEN EXISTS (SELECT 1 FROM sub_segments WHERE seg_id = p_seg_id)
     AND NOT EXISTS (SELECT 1 FROM sub_segments
                     WHERE seg_id = p_seg_id AND review_state IS DISTINCT FROM 'clinically_approved')
     -- 129: no card may hold an UN-ADJUDICATED image — no approved image to fall back on, and a
     -- candidate nobody has ruled on. A candidate BESIDE an approved image does not block.
     AND NOT EXISTS (
       SELECT 1 FROM sub_segments ss
        WHERE ss.seg_id = p_seg_id
          AND NOT EXISTS (SELECT 1 FROM content_images ci
                           WHERE ci.sub_segment_id = ss.id AND ci.status = 'approved')
          AND EXISTS (SELECT 1 FROM content_images ci
                       WHERE ci.sub_segment_id = ss.id AND ci.status = 'candidate'))
    THEN 'complete' ELSE 'pending' END;
  UPDATE segments SET
    seg_status  = v_status,
    updated_at  = now(),
    approved_by = CASE WHEN v_status = 'pending' THEN NULL ELSE approved_by END
  WHERE id = p_seg_id;
  RETURN v_status;
END $function$;

COMMENT ON FUNCTION public.recompute_seg_status(uuid) IS
  'Migrations 056 + 129: the SINGLE writer of segments.seg_status. complete iff >=1 card AND '
  'every card clinically_approved AND no card holds an un-adjudicated image (no approved image '
  'but a candidate). A replacement candidate beside an approved image does NOT block. Mirrored '
  'in TypeScript by src/lib/approvalSafety.ts deriveSegStatus.';

-- CREATE OR REPLACE keeps the existing ACL (094/095: service_role only), but re-assert it so a
-- future DROP+CREATE of this file cannot silently widen it.
REVOKE ALL ON FUNCTION public.recompute_seg_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_seg_status(uuid) TO service_role;

-- ================================================================ 2. the recompute-only trigger
-- SECURITY DEFINER is REQUIRED: it calls recompute_seg_status, whose EXECUTE is service_role
-- only, and the invoker may be a CMS `authenticated` session writing content_images directly.
-- Postgres does not check EXECUTE for trigger invocation, so the trigger itself still fires.
CREATE OR REPLACE FUNCTION public.content_images_recompute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_card uuid := COALESCE(NEW.sub_segment_id, OLD.sub_segment_id);
  v_seg  uuid;
BEGIN
  -- A lesson- or segment-level image (the polymorphic case) owns no card gate.
  IF v_card IS NULL THEN
    RETURN NULL;
  END IF;

  -- The card may already be gone (a card DELETE cascades to its images). 066's trigger does the
  -- recompute for that case; there is nothing for us to resolve.
  SELECT seg_id INTO v_seg FROM sub_segments WHERE id = v_card;
  IF v_seg IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM recompute_seg_status(v_seg);
  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.content_images_recompute() IS
  'Migration 129: re-derives the owning segment''s seg_status when a card''s images change. '
  'RECOMPUTE ONLY — it never writes a card''s review_state. Needed because a candidate landing '
  'beside an approved image moves no review state, so nothing else would re-derive the gate.';

REVOKE ALL ON FUNCTION public.content_images_recompute() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.content_images_recompute() TO service_role;

-- AFTER, so the row's new state is visible. UPDATE is scoped to `status`: the generate job
-- rewrites `storage_path` moments after inserting the candidate, and that write must not cost a
-- second recompute.
DROP TRIGGER IF EXISTS content_images_recompute_trg ON public.content_images;
CREATE TRIGGER content_images_recompute_trg
  AFTER INSERT OR DELETE OR UPDATE OF status ON public.content_images
  FOR EACH ROW EXECUTE FUNCTION public.content_images_recompute();

-- ================================================================ VERIFY
DO $$
DECLARE
  v_n int;
  v_md5 text;
BEGIN
  SELECT md5(replace(pg_get_functiondef('public.recompute_seg_status(uuid)'::regprocedure), chr(13), ''))
    INTO v_md5;
  IF v_md5 = '660ed036da2cf30d2886244d850e7dab' THEN
    RAISE EXCEPTION '129 VERIFY: recompute_seg_status was not replaced (still the 056 body)';
  END IF;
  -- Match on the CLAUSE, not on a comment: a comment's wording (or its case) is cosmetic and a
  -- guard that depends on it fails for the wrong reason.
  IF position('ci.status = ''candidate''' in pg_get_functiondef('public.recompute_seg_status(uuid)'::regprocedure)) = 0
     OR position('ci.status = ''approved''' in pg_get_functiondef('public.recompute_seg_status(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '129 VERIFY: the new recompute_seg_status body does not carry the image clause';
  END IF;

  IF to_regprocedure('public.content_images_recompute()') IS NULL THEN
    RAISE EXCEPTION '129 VERIFY: content_images_recompute() is missing';
  END IF;

  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgname = 'content_images_recompute_trg'
     AND tgrelid = 'public.content_images'::regclass;
  IF v_n <> 1 THEN RAISE EXCEPTION '129 VERIFY: the content_images trigger is missing'; END IF;

  -- it must fire on status only, not on every UPDATE
  IF position('UPDATE OF status' in
      (SELECT pg_get_triggerdef(oid) FROM pg_trigger
        WHERE tgname = 'content_images_recompute_trg'
          AND tgrelid = 'public.content_images'::regclass)) = 0 THEN
    RAISE EXCEPTION '129 VERIFY: the trigger is not scoped to UPDATE OF status';
  END IF;

  -- 094: neither function may be callable by anon/authenticated
  SELECT count(*) INTO v_n FROM (
    SELECT has_function_privilege('anon',          'public.recompute_seg_status(uuid)',  'EXECUTE') AS p
    UNION ALL SELECT has_function_privilege('authenticated', 'public.recompute_seg_status(uuid)',  'EXECUTE')
    UNION ALL SELECT has_function_privilege('anon',          'public.content_images_recompute()',  'EXECUTE')
    UNION ALL SELECT has_function_privilege('authenticated', 'public.content_images_recompute()',  'EXECUTE')
  ) x WHERE p;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '129 VERIFY: % of the two functions are EXECUTE-able by anon/authenticated', v_n;
  END IF;

  -- 066/092/093 must be untouched: this file replaces exactly one function
  SELECT count(*) INTO v_n FROM (
    SELECT md5(replace(pg_get_functiondef(p.oid), chr(13), '')) AS m, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('sub_segments_reset_review','quiz_reset_review','sub_segments_image_swap_review','set_card_review_state')
  ) f
   WHERE (f.proname, f.m) NOT IN (
     ('sub_segments_reset_review',      '947187befcb5050a6101a4ed091d21e8'),
     ('quiz_reset_review',              '46edd21044b15188ef4c31c03e89c99c'),
     ('sub_segments_image_swap_review', '6d673726c5721364f1b97a4a01eee9f8'),
     ('set_card_review_state',          '4bb5e0cbab542e021c8aea22a0fe4168'));
  IF v_n <> 0 THEN
    RAISE EXCEPTION '129 VERIFY: % of the 056/066/092/093 functions changed — this file must touch none', v_n;
  END IF;

  RAISE NOTICE '129 VERIFY ok: the gate is live, the trigger is scoped to status, 056/066/093 untouched';
END $$;

COMMIT;

-- ============================================================================
-- POST-APPLY (read-only, run separately — this file writes no rows and re-derives nothing).
-- The gate does NOT retro-apply: a segment keeps its stored seg_status until something
-- recomputes it. That is deliberate — re-deriving the catalog is the stale-complete repair's
-- job, with its own go and its own row list. To see what the new rule WOULD say:
--
--   SELECT s.id, s.lesson_id, s.seg_status AS stored, l.is_published
--     FROM segments s JOIN lessons l ON l.id = s.lesson_id
--    WHERE s.seg_status = 'complete'
--      AND EXISTS (SELECT 1 FROM sub_segments ss
--                   WHERE ss.seg_id = s.id
--                     AND NOT EXISTS (SELECT 1 FROM content_images ci
--                                      WHERE ci.sub_segment_id = ss.id AND ci.status = 'approved')
--                     AND EXISTS (SELECT 1 FROM content_images ci
--                                  WHERE ci.sub_segment_id = ss.id AND ci.status = 'candidate'));
--   -- Moosii 2026-11-25: 7 segments, ALL of them already in the 25-segment stale set
--   -- (every card draft), so 0 correctly-complete segments and 0 published lessons change.
--   -- financial 2026-11-25: 0 segments.
-- ============================================================================
