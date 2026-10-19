-- ============================================================================
-- MIGRATION 115: activity_finish — progress parity (F42) + "Did it" on a committed row (F44)
--   BOTH PROJECTS (one function) — DRAFT (pending apply)
-- ============================================================================
-- WHY (Mark 2026-10-19):
--   F42 — moosii-rn's own lesson completion upserts user_lesson_progress {is_completed: true} beside completed_items;
--         the follow-up end card (POST /activities/:lessonId/finish) wrote only the completion. It now upserts the
--         progress row too, in the SAME transaction (this function is the route's transaction).
--   F44 — reopening an activity you said you'd do and tapping "Did it" at the end card resolves the follow-up exactly
--         like answer(did_it): status done, resolved_by self, resolved_at now, activity_did_it paid once (ledger
--         UNIQUE (reason, source_id)). The updated row is returned.
--         Every other repeat stays a no-op returning the existing row unchanged: later / not_for_me on any existing
--         row; anything on done or skipped. skipped is final in v1.
--         The response always carries the row (followup.status), so a client can show the existing state when an
--         activity is reopened.
--
-- WHAT: CREATE OR REPLACE public.activity_finish(uuid, uuid, text) — same signature and return type (jsonb), so the
--   113 ACL (EXECUTE service_role only) is kept. Everything else in 113 is unchanged.
--   Progress: INSERT … ON CONFLICT (user_id, lesson_id) DO UPDATE SET is_completed = true WHERE it isn't already true,
--   on the NEW-row path only — a repeat call never touches it, so it is written once (user_lesson_progress_user_lesson_unique).
-- Hash-guarded: refuses unless the live body is 113's (md5 686e0937…) or 115's (a4676266…).
-- BOTH PROJECTS (invariant 4): the function is identical on both (checked 2026-10-19). APPLY per migrations/README.md:
-- financial first, then Moosii. No new objects → database.types.ts unchanged.
-- ============================================================================

-- PRE-CHECK (read-only). EXPECT md5 686e0937964459e7099f28fa020c173c and service_role-only EXECUTE:
--   SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE proname = 'activity_finish';
--   SELECT r, has_function_privilege(r, 'public.activity_finish(uuid,uuid,text)', 'EXECUTE')
--     FROM unnest(ARRAY['anon','authenticated','service_role']) r;

BEGIN;

DO $$ DECLARE cur text; BEGIN
  SELECT md5(replace(prosrc, chr(13), '')) INTO cur FROM pg_proc WHERE oid = 'public.activity_finish(uuid,uuid,text)'::regprocedure;
  IF cur <> '686e0937964459e7099f28fa020c173c' AND cur <> 'a46762668442cbcb2e609f19b44892ab' THEN
    RAISE EXCEPTION '115: activity_finish body md5 % is neither 113''s nor 115''s — re-base before applying', cur;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.activity_finish(p_user uuid, p_lesson uuid, p_choice text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  l       public.lessons%ROWTYPE;
  f       public.user_activity_followups%ROWTYPE;
  v_paid  integer := 0;
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
    -- Every other repeat: the existing row, unchanged (skipped is final in v1).
    RETURN jsonb_build_object('followup', to_jsonb(f), 'created', false, 'awarded', 0);
  END IF;
  IF p_choice = 'later' AND l.followup_after_days IS NULL THEN
    RAISE EXCEPTION 'activity:no_followup_configured: activity % has no followup_after_days', p_lesson;
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

  INSERT INTO public.user_activity_followups (user_id, lesson_id, status, due_at, committed_at, resolved_at, resolved_by)
  VALUES (p_user, l.id,
          CASE p_choice WHEN 'did_it' THEN 'done' WHEN 'later' THEN 'committed' ELSE 'skipped' END,
          CASE WHEN p_choice = 'later' THEN now() + make_interval(days => l.followup_after_days) END,
          CASE WHEN p_choice = 'later' THEN now() END,
          CASE WHEN p_choice = 'later' THEN NULL ELSE now() END,
          CASE WHEN p_choice = 'did_it' THEN 'self' END)
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

COMMIT;

-- VERIFICATION (after apply): md5 = 115's; EXECUTE still service_role only (anon / authenticated false);
-- behaviour ROLLED BACK: docs/drafts/115-activity-finish/verify.sql.
