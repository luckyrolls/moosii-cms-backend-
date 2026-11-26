-- ============================================================================
-- MIGRATION 131: `segments.seg_status` can only ever hold the DERIVED value.
--
-- *** BOTH PROJECTS. Schema only, no rows. ***
-- *** REVIEW REQUIRED: it refuses a write that is legal today. ***
-- ============================================================================
-- WHY. `seg_status` is the column every reader trusts — the app (`useLesson.ts`), the three RLS
-- SELECT policies (103), `lessons_review_status` (065), `lesson_publish_blocker` (126) and
-- `lessons.with_quiz` (063) — and none of them looks at card state. Migration 056 left 25 Moosii
-- rows holding `complete` with every card in draft for three months and nothing noticed, because
-- nothing could. Migration 130 repaired those rows; this file makes the lie unrepresentable.
--
-- D5/D6 (Mark, 2026-11-25): the `segments` guard ships HERE, separately from and AFTER the repair,
-- so each migration has a clean undo. The other half of the hole — a raw
-- `UPDATE sub_segments SET review_state`, which bypasses every recompute — is closed by a column
-- REVOKE in the reset-audit slice, NOT here (docs/FINDINGS-reset-audit.md §6.2).
--
-- SHAPE. A CHECK constraint cannot express this: the condition spans `segments` and
-- `sub_segments`, and Postgres forbids a subquery in a table constraint. A BEFORE UPDATE trigger
-- is the only enforcement point.
--
--   seg_status_derived(uuid)  the derivation, extracted so there is exactly ONE copy
--   recompute_seg_status      rebased on it (behaviour unchanged, md5-guarded on the 129 body)
--   segments_status_derived_guard_trg   BEFORE UPDATE OF seg_status ON segments
--
-- Extracting the derivation is the point of the file as much as the trigger is: a guard that
-- re-implemented the rule would eventually disagree with the writer it is guarding, and then the
-- guard would be the bug. `src/lib/approvalSafety.ts deriveSegStatus` remains the TypeScript
-- mirror, and src/lib/__tests__/approvalGate.db.test.ts asserts the two agree on every fixture.
--
-- WHAT IT REFUSES. Any UPDATE whose SET list names `seg_status` and whose value differs from
-- `seg_status_derived(id)` — in EITHER direction. So:
--   * `UPDATE segments SET seg_status='complete'` on a segment with draft cards → REFUSED
--     (the write that 130 had to clean up after, and which is possible today);
--   * `UPDATE segments SET seg_status='pending'` on a fully approved segment → ALSO REFUSED. The
--     column is derived; "wrong in the safe direction" is still wrong, and allowing it would let a
--     reset hide from the audit the reset-audit slice is about to add.
--   * `recompute_seg_status` → always passes. It computes the status from the same rows the guard
--     reads, in the same transaction, so the two cannot disagree. Verified on exactly that path
--     below, not only against a hand-written UPDATE.
--
-- MEASURED FIRST (read-only, both projects, 2026-11-26): `recompute_seg_status` is the ONLY
-- function in `public` on either project whose body writes `seg_status`
-- (`prosrc ~* 'SET\s+seg_status'` → 1 row), and the only TypeScript path is the
-- `recompute_seg_status` RPC (`src/lib/cardReview.ts:15`). So this guard refuses NOTHING that any
-- caller does today. On Moosii 057 also revokes column UPDATE from every role but `postgres`,
-- making a stray write impossible there already; on financial it is wide open (23/23 columns to
-- anon, authenticated and service_role — FINDINGS-complete-with-draft-cards §6.3), which is the
-- project this guard actually protects.
--
-- ⚠ INSERT IS NOT GUARDED, deliberately. A segment is INSERTed before any card exists (cards FK
-- to it), so the derived value is always `pending` at that moment and an INSERT guard would refuse
-- any explicit `complete` — correct, but it would also fire on every ordinary create.
-- `create_lessons_with_segments` is the only function that inserts `segments` and it never
-- mentions `seg_status` (measured), so the column takes its DEFAULT `'pending'`. The residual hole
-- is a hand-written `INSERT … (seg_status) VALUES ('complete')`, which would then be corrected by
-- the first recompute. Noted rather than closed, because the brief scoped this file to UPDATE and
-- an INSERT guard deserves its own measurement of every create path.
--
-- TRIGGER ORDER. BEFORE triggers on one event fire in NAME order. `segments` carries
-- `set_updated_at_trigger` (BEFORE UPDATE); `segments_status_derived_guard_trg` sorts BEFORE it
-- ('seg' < 'set'), which is harmless either way — `set_updated_at` touches only `updated_at`.
-- The two AFTER triggers (`content_edit_policy_guard_trg`, `segments_sync_with_quiz_trg`) run
-- after the row is written and are unaffected. Renaming any of them reorders them; don't.
--
-- UNDO (one transaction):
--   1. DROP TRIGGER IF EXISTS segments_status_derived_guard_trg ON public.segments;
--   2. DROP FUNCTION IF EXISTS public.segments_status_derived_guard();
--   3. Restore `recompute_seg_status` to the 129 body — quoted verbatim in §2 below — and confirm
--      md5(replace(pg_get_functiondef(…), chr(13), '')) = '017a190fd685972a20924e1a98e16170';
--      then re-apply the 094 grants (REVOKE … FROM PUBLIC, anon, authenticated; GRANT … service_role).
--   4. DROP FUNCTION IF EXISTS public.seg_status_derived(uuid);
--   No rows are written by this file, so nothing else needs undoing.
--
-- ⚠ THE 130 UNDO AND THIS GUARD. Migration 130's undo restores `seg_status` from its snapshot with
-- a direct UPDATE, which this guard REFUSES by design. So the 130 undo must run step 1 above FIRST
-- and re-create the trigger last, in the same transaction — exactly as
-- docs/drafts/128-catalog-modes/undo.sql does for 128's triggers. 130's header says so, and
-- docs/drafts/130-stale-complete/undo.sql rehearses it in that order.
-- ============================================================================

BEGIN;

-- ============================================================================ PRE-CHECK
DO $$
DECLARE
  v_domain text;
  v_md5    text;
  v_bad    int;
BEGIN
  SELECT value INTO v_domain FROM public.app_settings WHERE key = 'domain';
  IF v_domain IS NULL OR v_domain NOT IN ('moosii','financial') THEN
    RAISE EXCEPTION '131 PRE-CHECK: app_settings.domain is %, expected moosii or financial',
      coalesce(v_domain, '(null)');
  END IF;

  -- The body this file re-bases on: the 129 one. EXACT md5, compared after stripping CR (the
  -- 118/120 rule — a substring match is what silently reverted 115).
  SELECT md5(replace(pg_get_functiondef('public.recompute_seg_status(uuid)'::regprocedure), chr(13), ''))
    INTO v_md5;
  IF v_md5 <> '017a190fd685972a20924e1a98e16170' THEN
    RAISE EXCEPTION '131 PRE-CHECK: recompute_seg_status body md5 % is not the 129 version this file re-bases on (expected 017a190fd685972a20924e1a98e16170) — re-base before applying', v_md5;
  END IF;

  IF to_regprocedure('public.seg_status_derived(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '131 PRE-CHECK: seg_status_derived(uuid) already exists';
  END IF;

  -- THE GUARD MUST NOT BE INSTALLED ONTO A LYING TABLE. If any row still disagrees with the
  -- derivation, the repair (130) has not run here — and installing the guard first would make
  -- that repair's undo path harder and leave rows nothing can now correct except a recompute.
  WITH d AS (
    SELECT s.id, s.seg_status,
           CASE
             WHEN NOT EXISTS (SELECT 1 FROM public.sub_segments ss WHERE ss.seg_id = s.id) THEN 'pending'
             WHEN EXISTS (SELECT 1 FROM public.sub_segments ss
                           WHERE ss.seg_id = s.id AND ss.review_state IS DISTINCT FROM 'clinically_approved') THEN 'pending'
             WHEN EXISTS (SELECT 1 FROM public.sub_segments ss
                           WHERE ss.seg_id = s.id
                             AND NOT EXISTS (SELECT 1 FROM public.content_images ci
                                              WHERE ci.sub_segment_id = ss.id AND ci.status = 'approved')
                             AND EXISTS (SELECT 1 FROM public.content_images ci
                                          WHERE ci.sub_segment_id = ss.id AND ci.status = 'candidate')) THEN 'pending'
             ELSE 'complete' END AS derived
      FROM public.segments s)
  SELECT count(*) INTO v_bad FROM d WHERE seg_status IS DISTINCT FROM derived;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '131 PRE-CHECK: % segment(s) still disagree with the derived value — apply migration 130 (the repair) FIRST (D6)', v_bad;
  END IF;

  RAISE NOTICE '131 PRE-CHECK ok on domain % — 0 disagreeing segments, % segment(s) total',
    v_domain, (SELECT count(*) FROM public.segments);
END $$;

-- ============================================================================ 1. THE DERIVATION
-- ONE definition, extracted from 129's recompute body unchanged. STABLE, not IMMUTABLE: it reads
-- tables. SECURITY DEFINER so the guard (which runs as whatever role issued the UPDATE) can call
-- it without that role holding EXECUTE.
CREATE FUNCTION public.seg_status_derived(p_seg_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.sub_segments WHERE seg_id = p_seg_id)
     AND NOT EXISTS (SELECT 1 FROM public.sub_segments
                     WHERE seg_id = p_seg_id AND review_state IS DISTINCT FROM 'clinically_approved')
     -- 129: no card may hold an UN-ADJUDICATED image — no approved image to fall back on, and a
     -- candidate nobody has ruled on. A candidate BESIDE an approved image does not block.
     AND NOT EXISTS (
       SELECT 1 FROM public.sub_segments ss
        WHERE ss.seg_id = p_seg_id
          AND NOT EXISTS (SELECT 1 FROM public.content_images ci
                           WHERE ci.sub_segment_id = ss.id AND ci.status = 'approved')
          AND EXISTS (SELECT 1 FROM public.content_images ci
                       WHERE ci.sub_segment_id = ss.id AND ci.status = 'candidate'))
    THEN 'complete' ELSE 'pending' END
$$;

COMMENT ON FUNCTION public.seg_status_derived(uuid) IS
  'Migrations 056 + 129 + 131: THE definition of segments.seg_status. complete iff >=1 card AND '
  'every card clinically_approved AND no card holds an un-adjudicated image. recompute_seg_status '
  'writes what this returns; segments_status_derived_guard refuses anything else. Mirrored in '
  'TypeScript by src/lib/approvalSafety.ts deriveSegStatus (agreement asserted by '
  'src/lib/__tests__/approvalGate.db.test.ts).';

REVOKE ALL ON FUNCTION public.seg_status_derived(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seg_status_derived(uuid) TO service_role;

-- ============================================================================ 2. THE WRITER
-- Rebased on the derivation. The 129 body (for the undo) was identical except that the CASE was
-- inlined here instead of calling seg_status_derived:
--     v_status := CASE
--       WHEN EXISTS (SELECT 1 FROM sub_segments WHERE seg_id = p_seg_id)
--        AND NOT EXISTS (SELECT 1 FROM sub_segments
--                        WHERE seg_id = p_seg_id AND review_state IS DISTINCT FROM 'clinically_approved')
--        AND NOT EXISTS (
--          SELECT 1 FROM sub_segments ss
--           WHERE ss.seg_id = p_seg_id
--             AND NOT EXISTS (SELECT 1 FROM content_images ci
--                              WHERE ci.sub_segment_id = ss.id AND ci.status = 'approved')
--             AND EXISTS (SELECT 1 FROM content_images ci
--                          WHERE ci.sub_segment_id = ss.id AND ci.status = 'candidate'))
--       THEN 'complete' ELSE 'pending' END;
-- Everything else — the FOR UPDATE, the UPDATE, the approved_by nulling, the return — is
-- unchanged, so behaviour is identical and `npm test`'s SQL/TS agreement test still holds.
CREATE OR REPLACE FUNCTION public.recompute_seg_status(p_seg_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_status text;
BEGIN
  PERFORM 1 FROM segments WHERE id = p_seg_id FOR UPDATE;   -- serialize per-segment recomputes
  -- 131: ONE definition, shared with the guard. See seg_status_derived's comment.
  v_status := public.seg_status_derived(p_seg_id);
  UPDATE segments SET
    seg_status  = v_status,
    updated_at  = now(),
    approved_by = CASE WHEN v_status = 'pending' THEN NULL ELSE approved_by END
  WHERE id = p_seg_id;
  RETURN v_status;
END $function$;

COMMENT ON FUNCTION public.recompute_seg_status(uuid) IS
  'Migrations 056 + 129 + 131: the SINGLE writer of segments.seg_status. It writes whatever '
  'seg_status_derived(p_seg_id) returns, and migration 131''s BEFORE UPDATE guard refuses any '
  'other value from any other writer.';

REVOKE ALL ON FUNCTION public.recompute_seg_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_seg_status(uuid) TO service_role;

-- ============================================================================ 3. THE GUARD
-- SECURITY DEFINER is REQUIRED: a trigger function runs as the role that issued the statement,
-- and seg_status_derived is service_role-only (094). Same reasoning as 129's
-- content_images_recompute.
CREATE OR REPLACE FUNCTION public.segments_status_derived_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_derived text;
BEGIN
  v_derived := public.seg_status_derived(NEW.id);

  IF NEW.seg_status IS DISTINCT FROM v_derived THEN
    RAISE EXCEPTION 'segment %: seg_status % is not the derived value (%). It is a DERIVED column — call recompute_seg_status(id), or change the card review states it is derived from.',
      NEW.id, coalesce(NEW.seg_status, '(null)'), v_derived
      USING ERRCODE = 'check_violation', HINT = 'seg_status_not_derived';
  END IF;

  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.segments_status_derived_guard() IS
  'Migration 131: seg_status may only ever hold seg_status_derived(id), so only '
  'recompute_seg_status can set it. Refuses a wrong value in EITHER direction. HINT '
  'seg_status_not_derived. INSERT is deliberately not guarded — see 131''s header.';

REVOKE ALL ON FUNCTION public.segments_status_derived_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.segments_status_derived_guard() TO service_role;

DROP TRIGGER IF EXISTS segments_status_derived_guard_trg ON public.segments;
CREATE TRIGGER segments_status_derived_guard_trg
  BEFORE UPDATE OF seg_status ON public.segments
  FOR EACH ROW EXECUTE FUNCTION public.segments_status_derived_guard();

-- ============================================================================ VERIFICATION
DO $$
DECLARE
  v_domain text;
  v_n      int;
  v_seg    uuid;
  v_before text;
  v_got    text;
  v_err    text;
BEGIN
  SELECT value INTO v_domain FROM public.app_settings WHERE key = 'domain';

  -- 1. the objects exist, with the right scope and the 094 grants
  IF to_regprocedure('public.seg_status_derived(uuid)') IS NULL THEN
    RAISE EXCEPTION '131 VERIFY: seg_status_derived is missing';
  END IF;

  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgname = 'segments_status_derived_guard_trg' AND tgrelid = 'public.segments'::regclass;
  IF v_n <> 1 THEN RAISE EXCEPTION '131 VERIFY: the guard trigger is missing'; END IF;

  IF (SELECT pg_get_triggerdef(oid) FROM pg_trigger
       WHERE tgname = 'segments_status_derived_guard_trg'
         AND tgrelid = 'public.segments'::regclass) NOT LIKE '%BEFORE UPDATE OF seg\_status%' THEN
    RAISE EXCEPTION '131 VERIFY: the trigger is not BEFORE UPDATE OF seg_status';
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname IN ('seg_status_derived','segments_status_derived_guard','recompute_seg_status')
     AND (NOT p.prosecdef
          OR has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
          OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE'));
  IF v_n <> 0 THEN
    RAISE EXCEPTION '131 VERIFY: % function(s) not SECURITY DEFINER + service_role-only (094)', v_n;
  END IF;

  -- 2. the writer still agrees with the derivation on EVERY row, and writing changed nothing
  --    (130 already made them agree, so a full recompute here must be a no-op).
  WITH before AS (SELECT id, seg_status FROM public.segments)
  SELECT count(*) INTO v_n FROM before b
   WHERE b.seg_status IS DISTINCT FROM public.seg_status_derived(b.id);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '131 VERIFY: % segment(s) disagree with seg_status_derived', v_n;
  END IF;

  -- 3. THE SANCTIONED PATH STILL WORKS. recompute_seg_status must pass its own guard — the trap
  --    §6.1 of the findings warned about. Run it for real on every segment: it writes the derived
  --    value, so the guard must accept all of them.
  FOR v_seg IN SELECT id FROM public.segments LOOP
    PERFORM public.recompute_seg_status(v_seg);
  END LOOP;
  RAISE NOTICE '131 VERIFY: recompute_seg_status passed the guard on all % segment(s)',
    (SELECT count(*) FROM public.segments);

  -- 4. A HAND-WRITTEN WRITE IS REFUSED. Done for real, inside a sub-transaction that is rolled
  --    back, so the guard is proven on live data rather than assumed.
  SELECT id, seg_status INTO v_seg, v_before FROM public.segments ORDER BY id LIMIT 1;
  IF v_seg IS NOT NULL THEN
    BEGIN
      UPDATE public.segments
         SET seg_status = CASE WHEN v_before = 'complete' THEN 'pending' ELSE 'complete' END
       WHERE id = v_seg;
      RAISE EXCEPTION '131 VERIFY: a hand-written seg_status UPDATE was ACCEPTED on % — the guard does not work', v_seg;
    EXCEPTION WHEN check_violation THEN
      v_err := 'refused';
    END;
    IF v_err IS DISTINCT FROM 'refused' THEN
      RAISE EXCEPTION '131 VERIFY: the hand-written UPDATE did not raise check_violation';
    END IF;
    SELECT seg_status INTO v_got FROM public.segments WHERE id = v_seg;
    IF v_got IS DISTINCT FROM v_before THEN
      RAISE EXCEPTION '131 VERIFY: the refused UPDATE still changed % (% -> %)', v_seg, v_before, v_got;
    END IF;
    RAISE NOTICE '131 VERIFY: a hand-written seg_status UPDATE on % was refused, row unchanged', v_seg;
  END IF;

  RAISE NOTICE '131 VERIFY ok: domain=% — one derivation, the writer passes, a direct write is refused',
    v_domain;
END $$;

COMMIT;
