-- ============================================================================
-- MIGRATION 118: follow-up verification MODE — a commitment made while the fact is already at target is a
--   SELF-REPORT — BOTH PROJECTS (schema + activity_finish + the due view) — DRAFT (pending apply)
-- ============================================================================
-- WHY (Mark 2026-11-06, after D6). Since D6 an unchanged facts push writes no row, so it is no evidence
-- (api-contract §8b, §10). A follow-up committed while its verifying fact ALREADY carries the target value
-- therefore has nothing to wait for: resolve_activity_followups needs an observation dated AFTER the
-- commitment, and re-pushing the same value no longer makes one. Such a follow-up is ASKED, not watched —
-- so record that when it is created, instead of leaving a data promise that cannot be kept.
--
-- WHAT:
--   1. user_activity_followups.verify_mode — text NOT NULL DEFAULT 'data', CHECK ('data' | 'self').
--      'data' = we watch the fact and may resolve it ourselves; 'self' = we will ask the member.
--      Set ONCE, at creation, by activity_finish; nothing updates it afterwards.
--   2. BACKFILL, reproducing the rule historically: 'self' for every existing row whose activity has no
--      verify rule, or whose member already carried the target value AT the moment of the commitment
--      (observed_at <= committed_at, else created_at — the same coalesce resolve_activity_followups uses).
--      A row whose evidence arrived later keeps 'data'.
--   3. activity_finish sets it: 'data' only when the activity HAS a verify rule AND the member's current
--      value is not already the target; 'self' otherwise (no verify rule, or already there). The row is
--      returned as to_jsonb(f), so POST /activities/:lessonId/finish and .../answer carry the new field
--      with no backend code change.
--   4. user_activity_followups_due gains the column, appended LAST (CREATE OR REPLACE VIEW can only add
--      columns at the end; grants survive a replace).
--
-- NOT CHANGED, DELIBERATELY: resolve_activity_followups. verify_mode records what we EXPECT at commitment
--   time; it does NOT gate verification. If the fact really moves away and back, a genuine observation
--   lands after the commitment and that row still verifies (resolved_by 'data') though verify_mode says
--   'self'. Refusing a real confirmation to honour a label would be worse than the mismatch, and the
--   combination is readable: "we expected to ask you; the data answered first."
-- NOT CHANGED: the awards (activity_verified still pays only on data verification), asks/grace limits,
--   mlp_item_pool, user_mlp (invariants 1, 8), RLS (the column rides the table's existing policy).
--
-- BOTH PROJECTS (invariant 4). APPLY per migrations/README.md: financial first, then Moosii; then
-- regenerate src/types/database.types.ts (Moosii) and drop any temporary bridge.
-- ⚠ MIGRATION BEFORE CODE: the backend reads verify_mode in GET /activity-followups and
--   GET /activity-followups/recent, so apply this on BOTH projects before the code is pushed (a push
--   deploys both services).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only).
-- 1. 113 is live — EXPECT not NULL:
--      SELECT to_regclass('public.user_activity_followups');
-- 2. The column is free — EXPECT 0 rows:
--      SELECT column_name FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'user_activity_followups' AND column_name = 'verify_mode';
-- 3. What the backfill will decide — EXPECT the counts to add up to the row count:
--      SELECT CASE WHEN l.verify_fact_key IS NULL THEN 'self (no verify rule)'
--                  WHEN EXISTS (SELECT 1 FROM public.user_facts_latest fl
--                                WHERE fl.user_id = f.user_id AND fl.fact_key = l.verify_fact_key
--                                  AND fl.value = l.verify_fact_value
--                                  AND fl.observed_at <= coalesce(f.committed_at, f.created_at))
--                       THEN 'self (already at target)'
--                  ELSE 'data' END AS mode, count(*)
--        FROM public.user_activity_followups f JOIN public.lessons l ON l.id = f.lesson_id GROUP BY 1;
-- 4. The live activity_finish is still 113's (this file REPLACES it wholesale) — EXPECT 'f' for the first
--    and 't' for the second; if either disagrees the body has drifted, so stop and reconcile:
--      SELECT prosrc LIKE '%verify_mode%' AS already_118,
--             prosrc LIKE '%activity:no_followup_configured%' AS looks_like_113
--        FROM pg_proc WHERE proname = 'activity_finish';
-- ---------------------------------------------------------------------------

BEGIN;

-- Guard: 113 must be live, or the ALTER below would create nothing and the function would not compile.
DO $$ BEGIN
  IF to_regclass('public.user_activity_followups') IS NULL THEN
    RAISE EXCEPTION '118: user_activity_followups missing — apply 113 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'lessons' AND column_name = 'verify_fact_key') THEN
    RAISE EXCEPTION '118: lessons.verify_fact_key missing — apply 113 first';
  END IF;
END $$;

-- ---- 1. the column -------------------------------------------------------------------------------------
ALTER TABLE public.user_activity_followups
  ADD COLUMN IF NOT EXISTS verify_mode text NOT NULL DEFAULT 'data';

ALTER TABLE public.user_activity_followups DROP CONSTRAINT IF EXISTS uaf_verify_mode_valid;
ALTER TABLE public.user_activity_followups
  ADD CONSTRAINT uaf_verify_mode_valid CHECK (verify_mode IN ('data', 'self'));

COMMENT ON COLUMN public.user_activity_followups.verify_mode IS
  'How this follow-up is expected to resolve, decided ONCE at creation (118): data = the activity has a '
  'verify rule and the member was not already at the target value, so resolve_activity_followups may '
  'confirm it; self = there is no verify rule, or the member already carried the target value when they '
  'committed, so nothing new can arrive and we ask them instead. Advisory: it does not gate verification.';

-- ---- 2. backfill ---------------------------------------------------------------------------------------
-- Everything starts 'data' (the column default); flip the rows the rule calls self-report.
UPDATE public.user_activity_followups f
   SET verify_mode = 'self'
  FROM public.lessons l
 WHERE l.id = f.lesson_id
   AND f.verify_mode = 'data'
   AND (l.verify_fact_key IS NULL
        OR EXISTS (SELECT 1 FROM public.user_facts_latest fl
                    WHERE fl.user_id  = f.user_id
                      AND fl.fact_key = l.verify_fact_key
                      AND fl.value    = l.verify_fact_value
                      AND fl.observed_at <= coalesce(f.committed_at, f.created_at)));

-- ---- 3. activity_finish — 113's body, with the mode decided before the INSERT ---------------------------
CREATE OR REPLACE FUNCTION public.activity_finish(p_user uuid, p_lesson uuid, p_choice text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  l       public.lessons%ROWTYPE;
  f       public.user_activity_followups%ROWTYPE;
  v_new   boolean := false;
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

  -- Idempotent: a repeat call returns the existing row unchanged (whatever the choice).
  SELECT * INTO f FROM public.user_activity_followups WHERE user_id = p_user AND lesson_id = p_lesson;
  IF FOUND THEN
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
  v_new := true;
  IF p_choice = 'did_it' THEN
    v_paid := public.activity_award(p_user, l.points, 'activity_did_it', f.id);
  END IF;
  RETURN jsonb_build_object('followup', to_jsonb(f), 'created', v_new, 'awarded', v_paid);
END;
$function$;

-- CREATE OR REPLACE keeps the function's privileges; re-assert them anyway (the 094 rule).
REVOKE EXECUTE ON FUNCTION public.activity_finish(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.activity_finish(uuid, uuid, text) TO service_role;

-- ---- 4. the due view gains the column (appended last) ---------------------------------------------------
CREATE OR REPLACE VIEW public.user_activity_followups_due WITH (security_invoker = true) AS
SELECT f.id, f.user_id, f.lesson_id, l.lesson_name, l.description AS lesson_description,
       f.asks, lim.max_asks, f.due_at, f.committed_at, f.created_at,
       f.due_at + make_interval(days => lim.grace_days) AS lapses_at,
       f.verify_mode
  FROM public.user_activity_followups f
  JOIN public.lessons l ON l.id = f.lesson_id
  JOIN public.tracks  t ON t.id = l.track_id
 CROSS JOIN public.activity_followup_limits() lim
 WHERE f.status = 'committed'
   AND f.due_at <= now()
   AND f.asks < lim.max_asks
   AND now() <= f.due_at + make_interval(days => lim.grace_days)
   AND l.kind = 'activity' AND l.is_published
   AND l.archived_at IS NULL AND t.archived_at IS NULL;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying.
-- 1. The column and its constraint exist — EXPECT one row, is_nullable 'NO', default '''data''::text':
--      SELECT column_name, is_nullable, column_default FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'user_activity_followups' AND column_name = 'verify_mode';
--      SELECT conname FROM pg_constraint WHERE conname = 'uaf_verify_mode_valid';
-- 2. The CHECK bites — EXPECT 23514:
--      BEGIN; UPDATE public.user_activity_followups SET verify_mode = 'guess' WHERE true; ROLLBACK;
--      (no rows yet on a project without follow-ups: then just confirm the constraint exists.)
-- 3. The backfill agrees with the rule — EXPECT 0 rows (every row's stored mode equals the computed one):
--      SELECT f.id, f.verify_mode FROM public.user_activity_followups f JOIN public.lessons l ON l.id = f.lesson_id
--       WHERE f.verify_mode <> CASE WHEN l.verify_fact_key IS NULL THEN 'self'
--              WHEN EXISTS (SELECT 1 FROM public.user_facts_latest fl
--                            WHERE fl.user_id = f.user_id AND fl.fact_key = l.verify_fact_key
--                              AND fl.value = l.verify_fact_value
--                              AND fl.observed_at <= coalesce(f.committed_at, f.created_at)) THEN 'self'
--              ELSE 'data' END;
-- 4. The view carries it — EXPECT 'verify_mode' last:
--      SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'user_activity_followups_due';
-- 5. The function decides it (FINANCIAL, rolled back — Sam and the two demo activities):
--      BEGIN;
--        -- "Set a Statement-Date Reminder" verifies on credit_utilization_band = low; Sam is high → data
--        SELECT public.activity_finish('19587e0a-bfe0-48e2-94a1-055a5bbc9584',
--                                      'd9f6e3b4-e448-4602-9de9-dd6a161b486a', 'later') -> 'followup' ->> 'verify_mode';
--        -- EXPECT 'data'
--      ROLLBACK;
--      BEGIN;
--        -- "Put Your Buffer on Autopilot" verifies on has_emergency_buffer = true; Sam is already true → self
--        SELECT public.activity_finish('19587e0a-bfe0-48e2-94a1-055a5bbc9584',
--                                      'e7fc45b6-1c6d-4b8c-b55e-844a9a88cbaa', 'later') -> 'followup' ->> 'verify_mode';
--        -- EXPECT 'self'
--      ROLLBACK;
--    (MOOSII has no verify-configured activity today: step 5 is financial-only.)
-- ============================================================================
