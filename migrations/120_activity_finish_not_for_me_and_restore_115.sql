-- ============================================================================
-- MIGRATION 120: activity_finish — "Not for me" abandons a COMMITTED row (R15)
--   *** AND RESTORES MIGRATION 115, WHICH MIGRATION 118 REGRESSED *** — BOTH PROJECTS — DRAFT (pending apply)
-- ============================================================================
-- ⚠ THIS FILE FIXES A REGRESSION I SHIPPED. Migration 118 (2026-11-07) rebuilt activity_finish from **113's**
--   body instead of the then-live **115's** body, and 118's drift pre-check only tested for a string that exists
--   in 115's body too, so it passed. Applied to BOTH projects, live md5
--   f1808f31a09627b699d91d7ad70fffa9, this silently dropped THREE things 115 added:
--     F42  the `user_lesson_progress {is_completed:true}` upsert on the new-row path (progress parity with
--          moosii-rn's own completion) — gone;
--     F44  `did_it` on an existing COMMITTED row resolving it to done/self and paying `activity_did_it` ONCE
--          — gone; it became a no-op returning the row unchanged with `awarded: 0`;
--     the `FOR UPDATE` row lock on the existing-row SELECT — gone.
--   `docs/api-contract.md` §10 has documented 115's behaviour throughout, so the CONTRACT has been right and the
--   DATABASE wrong since 2026-11-07. This file re-bases on 115's exact body and re-applies 118's verify_mode on
--   top, so all three come back in the same statement that adds R15.
--
-- WHAT R15 ADDS (Mark 2026-11-10). `not_for_me` on an existing COMMITTED row ABANDONS the commitment:
--   status `skipped`, `resolved_at = now()`, no award, the updated row returned (`created: false`,
--   `awarded: 0`). Before this it was a no-op, so a member who committed and changed their mind had no way out
--   except waiting for the follow-up to lapse.
--
-- ⚠ DEVIATION FROM THE BRIEF, forced by the schema: the brief asked for `resolved_by = 'self'` on that row.
--   That is IMPOSSIBLE — `uaf_done_iff_resolved_by CHECK ((status = 'done') = (resolved_by IS NOT NULL))` means a
--   non-`done` row MUST have `resolved_by IS NULL` (verified on PG 17: it raises 23514). So the abandoned row
--   carries `resolved_by = NULL`, which is exactly what a FIRST-call `not_for_me` already writes
--   (`CASE WHEN p_choice = 'did_it' THEN 'self' END` is NULL for not_for_me) — so a committed-then-abandoned row
--   is indistinguishable from a straight "not for me", which is the right outcome. `resolved_at` is not
--   optional either: `uaf_open_iff_committed CHECK ((status = 'committed') = (resolved_at IS NULL))` requires it.
--   Relaxing `uaf_done_iff_resolved_by` to allow `resolved_by` on a skipped row would be a schema change on a
--   shared table AND would split the two not_for_me paths; not done, not proposed.
--
-- UNCHANGED, DELIBERATELY: `did_it` on a committed row still resolves and pays once (115 F44, restored);
--   `later` on any existing row is a no-op; anything on a `done` or `skipped` row is a no-op; **`skipped` is
--   final in v1** (a `did_it` after an abandon does NOT reopen it); the new-row paths for all three choices;
--   `verify_mode` (118) is still decided once, on the new-row path only; awards, `resolve_activity_followups`,
--   the due view, `mlp_item_pool`, `user_mlp` (invariants 1, 8) and RLS.
--
-- NUMBERING: 119 is TAKEN (plan reason labels, APPLIED on both projects 2026-11-09). The drafts in
--   `docs/FINDINGS-games-backend-prep.md` still propose 119/120/121 — written when both high-waters were 118 —
--   so they must shift to 121/122/123. No 120/121 .sql file exists yet, so this file takes 120.
--
-- BOTH PROJECTS (invariant 4): the function is identical on both (md5 f1808f31… checked 2026-11-10).
--   APPLY per migrations/README.md: financial first, then Moosii. No new objects → database.types.ts unchanged.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only).
-- 1. The live body is the CURRENT live version (118's) — EXPECT f1808f31a09627b699d91d7ad70fffa9, and
--    has_f42/has_f44 both 'f' (the regression this file repairs):
--      SELECT md5(replace(prosrc, chr(13), '')) AS md5_nocr,
--             prosrc LIKE '%user_lesson_progress%' AS has_f42,
--             prosrc LIKE '%status = ''committed''%' AS has_f44,
--             prosrc LIKE '%verify_mode%'          AS has_118
--        FROM pg_proc WHERE proname = 'activity_finish';
-- 2. Privileges to re-assert — EXPECT anon/authenticated false, service_role true:
--      SELECT r, has_function_privilege(r, 'public.activity_finish(uuid,uuid,text)', 'EXECUTE')
--        FROM unnest(ARRAY['anon','authenticated','service_role']) r;
-- 3. The constraints this body must satisfy (for the record):
--      SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--       WHERE conrelid = 'public.user_activity_followups'::regclass AND contype = 'c' ORDER BY 1;
-- ---------------------------------------------------------------------------

BEGIN;

-- Hash guard. Refuses unless the live body is one we recognise, and NAMES the one it matched, so a rebase error
-- like 118's cannot happen silently again. 115's own guard used the CR-stripped form; keep that.
DO $$
DECLARE cur text;
BEGIN
  SELECT md5(replace(prosrc, chr(13), '')) INTO cur
    FROM pg_proc WHERE oid = 'public.activity_finish(uuid,uuid,text)'::regprocedure;
  IF cur = 'f1808f31a09627b699d91d7ad70fffa9' THEN
    RAISE NOTICE '120: matched the CURRENT live body (118, F42/F44 regressed) — restoring 115 and adding R15';
  ELSIF cur = 'a46762668442cbcb2e609f19b44892ab' THEN
    RAISE NOTICE '120: matched 115''s body (118 not applied here) — adding verify_mode and R15';
  ELSIF cur = '686e0937964459e7099f28fa020c173c' THEN
    RAISE EXCEPTION '120: live body is 113''s — apply 115 and 118 first (md5 %)', cur;
  ELSE
    RAISE EXCEPTION '120: activity_finish body md5 % is not a version this file knows — re-base before applying', cur;
  END IF;
END $$;

-- 115's body verbatim (F42 + F44 + FOR UPDATE), plus 118's verify_mode, plus R15's abandon branch.
CREATE OR REPLACE FUNCTION public.activity_finish(p_user uuid, p_lesson uuid, p_choice text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  l       public.lessons%ROWTYPE;
  f       public.user_activity_followups%ROWTYPE;
  v_paid  integer := 0;
  v_mode  text    := 'self';
BEGIN
  IF p_choice IS NULL OR p_choice NOT IN ('did_it', 'later', 'not_for_me') THEN
    RAISE EXCEPTION 'activity:invalid_choice: choice must be did_it, later or not_for_me';
  END IF;
  SELECT * INTO l FROM public.lessons WHERE id = p_lesson;
  IF NOT FOUND THEN RAISE EXCEPTION 'activity:lesson_not_found: lesson % not found', p_lesson; END IF;
  IF l.kind IS DISTINCT FROM 'activity' THEN
    RAISE EXCEPTION 'activity:not_activity: lesson % is not an activity', p_lesson;
  END IF;

  -- A row already exists for (user, activity).
  SELECT * INTO f FROM public.user_activity_followups WHERE user_id = p_user AND lesson_id = p_lesson FOR UPDATE;
  IF FOUND THEN
    -- 115 (F44): "Did it" on a committed row resolves it, exactly like answer(did_it).
    IF p_choice = 'did_it' AND f.status = 'committed' THEN
      UPDATE public.user_activity_followups
         SET status = 'done', resolved_at = now(), resolved_by = 'self', updated_at = now()
       WHERE id = f.id RETURNING * INTO f;
      v_paid := public.activity_award(p_user, l.points, 'activity_did_it', f.id);
      RETURN jsonb_build_object('followup', to_jsonb(f), 'created', false, 'awarded', v_paid);
    END IF;
    -- 120 (R15): "Not for me" on a committed row ABANDONS it — skipped, resolved now, nothing paid.
    -- resolved_by stays NULL: uaf_done_iff_resolved_by allows it only on a 'done' row, and a first-call
    -- not_for_me writes NULL too, so the two paths produce the same row.
    IF p_choice = 'not_for_me' AND f.status = 'committed' THEN
      UPDATE public.user_activity_followups
         SET status = 'skipped', resolved_at = now(), resolved_by = NULL, updated_at = now()
       WHERE id = f.id RETURNING * INTO f;
      RETURN jsonb_build_object('followup', to_jsonb(f), 'created', false, 'awarded', 0);
    END IF;
    -- Every other repeat: the existing row, unchanged (skipped is final in v1).
    RETURN jsonb_build_object('followup', to_jsonb(f), 'created', false, 'awarded', 0);
  END IF;
  IF p_choice = 'later' AND l.followup_after_days IS NULL THEN
    RAISE EXCEPTION 'activity:no_followup_configured: activity % has no followup_after_days', p_lesson;
  END IF;

  -- 118: data verification is only possible when the activity HAS a verify rule AND the member is not
  -- already at the target value — since D6, re-pushing a value they already carry writes no row, so no
  -- observation would ever land after this commitment. Anything else is a self-report.
  IF l.verify_fact_key IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.user_facts_latest fl
        WHERE fl.user_id  = p_user
          AND fl.fact_key = l.verify_fact_key
          AND fl.value    = l.verify_fact_value)
  THEN
    v_mode := 'data';
  END IF;

  -- The completion (RN may already have written it — accept it; 111's trigger pays 0 for an activity).
  INSERT INTO public.completed_items (user_id, item_id, item_type, lesson_id, questionnaire_id,
                                      item_name, item_description, with_quiz, score)
  VALUES (p_user, l.id, 'lesson', l.id, NULL, coalesce(l.lesson_name, ''), coalesce(l.description, ''),
          coalesce(l.with_quiz, false), 0)
  ON CONFLICT (user_id, lesson_id) WHERE item_type = 'lesson' DO NOTHING;

  -- 115 (F42): progress parity with moosii-rn's completion — written once (new-row path only).
  INSERT INTO public.user_lesson_progress (user_id, lesson_id, is_completed)
  VALUES (p_user, l.id, true)
  ON CONFLICT (user_id, lesson_id) DO UPDATE SET is_completed = true
   WHERE public.user_lesson_progress.is_completed IS DISTINCT FROM true;

  INSERT INTO public.user_activity_followups (user_id, lesson_id, status, due_at, committed_at, resolved_at,
                                              resolved_by, verify_mode)
  VALUES (p_user, l.id,
          CASE p_choice WHEN 'did_it' THEN 'done' WHEN 'later' THEN 'committed' ELSE 'skipped' END,
          CASE WHEN p_choice = 'later' THEN now() + make_interval(days => l.followup_after_days) END,
          CASE WHEN p_choice = 'later' THEN now() END,
          CASE WHEN p_choice = 'later' THEN NULL ELSE now() END,
          CASE WHEN p_choice = 'did_it' THEN 'self' END,
          v_mode)
  ON CONFLICT (user_id, lesson_id) DO NOTHING
  RETURNING * INTO f;
  IF f.id IS NULL THEN                                   -- lost a race to a concurrent call: return theirs
    SELECT * INTO f FROM public.user_activity_followups WHERE user_id = p_user AND lesson_id = p_lesson;
    RETURN jsonb_build_object('followup', to_jsonb(f), 'created', false, 'awarded', 0);
  END IF;
  IF p_choice = 'did_it' THEN
    v_paid := public.activity_award(p_user, l.points, 'activity_did_it', f.id);
  END IF;
  RETURN jsonb_build_object('followup', to_jsonb(f), 'created', true, 'awarded', v_paid);
END;
$function$;

-- CREATE OR REPLACE keeps the function's privileges; re-assert them anyway (the 094 rule).
REVOKE EXECUTE ON FUNCTION public.activity_finish(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.activity_finish(uuid, uuid, text) TO service_role;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying. Steps 1–2 are universal; step 3 is the behaviour suite and needs a
-- verify-configured activity, so it is FINANCIAL-only (Moosii has no activity lessons).
-- 1. The regression is repaired and R15 is in — EXPECT all four 't':
--      SELECT prosrc LIKE '%user_lesson_progress%'                 AS f42_back,
--             prosrc LIKE '%status = ''committed''%'               AS f44_back,
--             prosrc LIKE '%FOR UPDATE%'                           AS lock_back,
--             prosrc LIKE '%R15%'                                  AS r15_in,
--             prosrc LIKE '%verify_mode%'                          AS still_118
--        FROM pg_proc WHERE proname = 'activity_finish';
-- 2. Privileges — EXPECT anon/authenticated false, service_role true:
--      SELECT r, has_function_privilege(r, 'public.activity_finish(uuid,uuid,text)', 'EXECUTE')
--        FROM unnest(ARRAY['anon','authenticated','service_role']) r;
-- 3. Behaviour (FINANCIAL, each scenario in its OWN rolled-back transaction, Sam + the statement-date
--    reminder d9f6e3b4-e448-4602-9de9-dd6a161b486a):
--    (a) R15 — commit, then abandon:
--        BEGIN;
--          SELECT activity_finish('19587e0a-…','d9f6e3b4-…','later')      -> 'followup' ->> 'status';  -- committed
--          SELECT activity_finish('19587e0a-…','d9f6e3b4-…','not_for_me');                             -- the abandon
--          -- EXPECT status skipped, resolved_by NULL, resolved_at set, created false, awarded 0
--          SELECT count(*) FROM user_activity_followups_due WHERE user_id = '19587e0a-…';  -- EXPECT 0
--        ROLLBACK;
--    (b) repeat abandon is a no-op, and did_it AFTER a skip does not reopen it (skipped is final):
--        BEGIN;
--          … 'later' … 'not_for_me' … then 'not_for_me' again -> awarded 0, status still skipped
--          … then 'did_it'                                    -> awarded 0, status STILL skipped
--        ROLLBACK;
--    (c) F44 restored — commit then did_it resolves and pays ONCE:
--        BEGIN;
--          … 'later' … then 'did_it' -> status done, resolved_by self, awarded = lessons.points
--          … then 'did_it' again     -> awarded 0 (activity_award is keyed on the follow-up id)
--        ROLLBACK;
--    (d) F42 restored — the new-row path writes user_lesson_progress:
--        BEGIN;
--          … 'later' … then SELECT is_completed FROM user_lesson_progress WHERE user_id/lesson_id -- EXPECT true
--        ROLLBACK;
--    (e) verify_mode (118) still decided on the new-row path:
--        BEGIN; … 'later' on d9f6e3b4 -> verify_mode 'data';  ROLLBACK;
--        BEGIN; … 'later' on e7fc45b6-1c6d-… -> verify_mode 'self'; ROLLBACK;
--    After every ROLLBACK: 0 rows for Sam in user_activity_followups beyond what existed before.
-- ============================================================================
