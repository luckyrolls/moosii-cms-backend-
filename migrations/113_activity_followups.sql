-- ============================================================================
-- MIGRATION 113: activity follow-ups, slice 1 (schema, due view, backend functions) + F37 (no client deletes of
--   completed_items) — BOTH PROJECTS (schema + 3 settings rows) — DRAFT (pending apply)
-- ============================================================================
-- WHY (FINDINGS-activity-followups; Mark 2026-10-17): an activity's end card offers Did it / I'll do it / Not for me.
-- "I'll do it" commits the user; the follow-up comes back after the activity's followup_after_days, is asked at most
-- followup_max_asks times ("Not yet" taps; emails never count), and lapses after followup_grace_days unanswered.
-- Some activities are VERIFIED by data: when the activity's fact reaches its value, observed after the commitment.
-- Follow-ups are their OWN surface — never part of mlp_item_pool or user_mlp (invariants 1, 8 untouched).
--
-- WHAT:
--   1. F37 — completed_items: REVOKE DELETE (and TRUNCATE, which bypasses RLS) from anon + authenticated; DROP the
--      client delete paths: policy completed_items_del, and the catch-all user_or_super_admin_access (FOR ALL). The
--      catch-all's SELECT/INSERT/UPDATE are already covered by completed_items_sel/_ins/_upd (is_admin() includes
--      super_admin), so only DELETE changes. Client inventory 2026-10-17: moosii-rn b744b4f, moosii-cms ba18ba5,
--      moosii-reader 337f0d6 — none deletes completed_items. Unaffected: service role (backend teardown, demo:reset as
--      postgres), FK cascades (lesson / questionnaire / user deletes run as the table owner). This also closes
--      "delete the completion and redo it to be paid again" (backlog, 2026-10-17).
--   2. lessons: followup_after_days int (> 0), verify_fact_key, verify_fact_value — only on kind = 'activity'; key and
--      value both set or both NULL; (key, value) FK fact_values (the vocabulary IS a table — composite PK) RESTRICT.
--      Metadata: the 064 edit guard and 066 review reset cover only lessons' content columns, so no re-approval.
--   3. user_activity_followups — one row per (user, activity) for EVERY end-card choice:
--        committed (later; due_at set) | done (resolved_by self | data) | skipped (not_for_me).
--      user_id FK auth.users ON DELETE CASCADE (076 convention); lesson_id FK lessons ON DELETE CASCADE;
--      verified_fact_id FK user_facts ON DELETE SET NULL (verified_at stays as the record). RLS: own row or is_admin()
--      SELECT; NO client INSERT/UPDATE/DELETE (privileges revoked) — written only by the functions below.
--   4. app_settings: followup_max_asks = 2, followup_grace_days = 14, followup_verified_bonus = 5 (+ value CHECKs).
--   5. activity_followup_limits() — SECURITY DEFINER, returns ONLY max_asks + grace_days (app_settings is RLS-on with
--      no policy, so an invoker view could not read it). EXECUTE: authenticated + service_role.
--   6. VIEW user_activity_followups_due (security_invoker): committed, due_at <= now(), asks < max,
--      now() <= due_at + grace, lesson an activity, published, lesson + track not archived. Lapsed is derived (asks
--      exhausted or grace passed), never stored; nothing runs on a schedule.
--   7. Backend functions (EXECUTE service_role only, 094 rule; SECURITY INVOKER — the service role bypasses RLS):
--        activity_finish(user, lesson, choice)        — POST /activities/:lessonId/finish
--        activity_followup_answer(user, id, answer)   — POST /activity-followups/:id/answer
--        resolve_activity_followups(user)             — recordFacts, after a facts write
--      Each is ONE transaction. Awards go to moosie_awards (111): activity_did_it = lessons.points, activity_verified =
--      followup_verified_bonus, source_id = the follow-up id; UNIQUE (reason, source_id) → each pays once; the balance
--      moves only when the ledger row was inserted. Errors RAISE 'activity:<code>: …' (P0001); the route maps the code.
-- NOT CHANGED: completed_items award trigger (an activity completion still pays 0, 111), mlp_item_pool, user_mlp.
-- BOTH PROJECTS (invariant 4). APPLY per migrations/README.md: financial first, then Moosii; then regenerate
-- database.types.ts (Moosii).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT: no user_activity_followups; lessons without followup columns; the two
-- completed_items client-delete policies present; no followup_* settings.
--   SELECT to_regclass('public.user_activity_followups');
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'lessons' AND column_name LIKE ANY (ARRAY['followup%','verify_fact%']);
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'completed_items' ORDER BY 1;
--   SELECT key FROM app_settings WHERE key LIKE 'followup%';
-- ---------------------------------------------------------------------------

BEGIN;

-- Guards: 107 (lessons.kind) and 111 (moosie_awards) are live, and the specific completed_items policies that take over
-- from the catch-all exist — dropping user_or_super_admin_access without them would remove the client's own-row access.
DO $$ DECLARE n int; BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'lessons' AND column_name = 'kind') THEN
    RAISE EXCEPTION '113: lessons.kind missing — apply 107 first';
  END IF;
  IF to_regclass('public.moosie_awards') IS NULL THEN RAISE EXCEPTION '113: moosie_awards missing — apply 111 first'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'completed_items'
     AND policyname IN ('completed_items_sel', 'completed_items_ins', 'completed_items_upd');
  IF n <> 3 THEN
    RAISE EXCEPTION '113: completed_items_sel/_ins/_upd policies: % of 3 present — re-base before dropping the catch-all', n;
  END IF;
END $$;

-- ---- 1. F37 ----
REVOKE DELETE, TRUNCATE ON public.completed_items FROM anon, authenticated;
DROP POLICY IF EXISTS completed_items_del ON public.completed_items;
DROP POLICY IF EXISTS user_or_super_admin_access ON public.completed_items;

-- ---- 2. lessons: follow-up metadata ----
ALTER TABLE public.lessons
  ADD COLUMN IF NOT EXISTS followup_after_days integer,
  ADD COLUMN IF NOT EXISTS verify_fact_key     text,
  ADD COLUMN IF NOT EXISTS verify_fact_value   text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.lessons'::regclass AND conname = 'lessons_followup_days_positive') THEN
    ALTER TABLE public.lessons ADD CONSTRAINT lessons_followup_days_positive CHECK (followup_after_days > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.lessons'::regclass AND conname = 'lessons_followup_only_activity') THEN
    ALTER TABLE public.lessons ADD CONSTRAINT lessons_followup_only_activity
      CHECK (kind = 'activity' OR (followup_after_days IS NULL AND verify_fact_key IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.lessons'::regclass AND conname = 'lessons_verify_fact_pair') THEN
    ALTER TABLE public.lessons ADD CONSTRAINT lessons_verify_fact_pair
      CHECK ((verify_fact_key IS NULL) = (verify_fact_value IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.lessons'::regclass AND conname = 'lessons_verify_fact_fk') THEN
    ALTER TABLE public.lessons ADD CONSTRAINT lessons_verify_fact_fk
      FOREIGN KEY (verify_fact_key, verify_fact_value) REFERENCES public.fact_values (fact_key, value)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END $$;

-- ---- 3. user_activity_followups ----
CREATE TABLE IF NOT EXISTS public.user_activity_followups (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lesson_id        uuid        NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  status           text        NOT NULL CONSTRAINT uaf_status_valid CHECK (status IN ('committed', 'done', 'skipped')),
  asks             integer     NOT NULL DEFAULT 0 CONSTRAINT uaf_asks_nonneg CHECK (asks >= 0),
  due_at           timestamptz,
  committed_at     timestamptz,
  resolved_at      timestamptz,
  resolved_by      text        CONSTRAINT uaf_resolved_by_valid CHECK (resolved_by IN ('self', 'data')),
  verified_at      timestamptz,
  verified_fact_id uuid        REFERENCES public.user_facts(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uaf_user_lesson_unique   UNIQUE (user_id, lesson_id),
  CONSTRAINT uaf_committed_has_due    CHECK (status <> 'committed' OR due_at IS NOT NULL),
  CONSTRAINT uaf_committed_has_time   CHECK (status <> 'committed' OR committed_at IS NOT NULL),
  CONSTRAINT uaf_open_iff_committed   CHECK ((status = 'committed') = (resolved_at IS NULL)),
  CONSTRAINT uaf_done_iff_resolved_by CHECK ((status = 'done') = (resolved_by IS NOT NULL)),
  CONSTRAINT uaf_data_needs_verified  CHECK (resolved_by IS DISTINCT FROM 'data' OR verified_at IS NOT NULL),
  CONSTRAINT uaf_fact_needs_verified  CHECK (verified_fact_id IS NULL OR verified_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS uaf_lesson_id_idx ON public.user_activity_followups (lesson_id);
COMMENT ON TABLE public.user_activity_followups IS
  'Activity follow-ups (113): one row per (user, activity) for every end-card choice. Written ONLY by activity_finish / '
  'activity_followup_answer / resolve_activity_followups (backend). Never part of user_mlp.';

ALTER TABLE public.user_activity_followups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_activity_followups FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_activity_followups TO authenticated;
GRANT ALL ON public.user_activity_followups TO service_role;
DROP POLICY IF EXISTS uaf_sel ON public.user_activity_followups;
CREATE POLICY uaf_sel ON public.user_activity_followups FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT is_admin()));

-- ---- 4. Settings ----
INSERT INTO public.app_settings (key, value) VALUES
  ('followup_max_asks', '2'), ('followup_grace_days', '14'), ('followup_verified_bonus', '5')
ON CONFLICT (key) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.app_settings'::regclass AND conname = 'app_settings_followup_positive') THEN
    ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_followup_positive
      CHECK (key NOT IN ('followup_max_asks', 'followup_grace_days') OR value ~ '^[1-9][0-9]*$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.app_settings'::regclass AND conname = 'app_settings_followup_bonus_valid') THEN
    ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_followup_bonus_valid
      CHECK (key <> 'followup_verified_bonus' OR value ~ '^(0|[1-9][0-9]*)$');
  END IF;
END $$;

-- ---- 5. The two limits the due view needs (and nothing else from app_settings) ----
CREATE OR REPLACE FUNCTION public.activity_followup_limits()
 RETURNS TABLE (max_asks integer, grace_days integer)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT (SELECT value::int FROM public.app_settings WHERE key = 'followup_max_asks'),
         (SELECT value::int FROM public.app_settings WHERE key = 'followup_grace_days')
$function$;
REVOKE EXECUTE ON FUNCTION public.activity_followup_limits() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activity_followup_limits() TO authenticated, service_role;

-- ---- 6. Due view (security_invoker: the base tables' RLS binds) ----
CREATE OR REPLACE VIEW public.user_activity_followups_due WITH (security_invoker = true) AS
SELECT f.id, f.user_id, f.lesson_id, l.lesson_name, l.description AS lesson_description,
       f.asks, lim.max_asks, f.due_at, f.committed_at, f.created_at,
       f.due_at + make_interval(days => lim.grace_days) AS lapses_at
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
REVOKE ALL ON public.user_activity_followups_due FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_activity_followups_due TO authenticated, service_role;

-- ---- 7. Backend functions ----
-- Ledger award, shared by the activity reasons (111's trigger keeps its own copy for completions).
CREATE OR REPLACE FUNCTION public.activity_award(p_user uuid, p_amount integer, p_reason text, p_source uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE v_amount integer := greatest(coalesce(p_amount, 0), 0); v_id uuid;
BEGIN
  INSERT INTO public.moosie_awards (user_id, amount, reason, source_id)
  VALUES (p_user, v_amount, p_reason, p_source::text)
  ON CONFLICT (reason, source_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN 0; END IF;                 -- already paid: pays once
  IF v_amount > 0 THEN
    UPDATE public."user" SET moosies = moosies + v_amount WHERE id = p_user;
  END IF;
  RETURN v_amount;
END;
$function$;

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

  -- The completion (RN may already have written it — accept it; 111's trigger pays 0 for an activity).
  INSERT INTO public.completed_items (user_id, item_id, item_type, lesson_id, questionnaire_id,
                                      item_name, item_description, with_quiz, score)
  VALUES (p_user, l.id, 'lesson', l.id, NULL, coalesce(l.lesson_name, ''), coalesce(l.description, ''),
          coalesce(l.with_quiz, false), 0)
  ON CONFLICT (user_id, lesson_id) WHERE item_type = 'lesson' DO NOTHING;

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
  v_new := true;
  IF p_choice = 'did_it' THEN
    v_paid := public.activity_award(p_user, l.points, 'activity_did_it', f.id);
  END IF;
  RETURN jsonb_build_object('followup', to_jsonb(f), 'created', v_new, 'awarded', v_paid);
END;
$function$;

CREATE OR REPLACE FUNCTION public.activity_followup_answer(p_user uuid, p_followup uuid, p_answer text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  f      public.user_activity_followups%ROWTYPE;
  l      public.lessons%ROWTYPE;
  lim    record;
  v_paid integer := 0;
BEGIN
  IF p_answer IS NULL OR p_answer NOT IN ('did_it', 'not_yet') THEN
    RAISE EXCEPTION 'activity:invalid_answer: answer must be did_it or not_yet';
  END IF;
  SELECT * INTO f FROM public.user_activity_followups WHERE id = p_followup AND user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'activity:followup_not_found: follow-up % not found', p_followup; END IF;
  IF f.status <> 'committed' THEN
    RAISE EXCEPTION 'activity:not_committed: follow-up % is %, not committed', p_followup, f.status;
  END IF;
  SELECT * INTO l FROM public.lessons WHERE id = f.lesson_id;
  SELECT * INTO lim FROM public.activity_followup_limits();

  IF p_answer = 'did_it' THEN                            -- allowed even when lapsed: the user did it
    UPDATE public.user_activity_followups
       SET status = 'done', resolved_at = now(), resolved_by = 'self', updated_at = now()
     WHERE id = f.id RETURNING * INTO f;
    v_paid := public.activity_award(p_user, l.points, 'activity_did_it', f.id);
  ELSE
    IF f.asks >= lim.max_asks OR now() > f.due_at + make_interval(days => lim.grace_days) THEN
      RAISE EXCEPTION 'activity:followup_lapsed: follow-up % has lapsed', p_followup;
    END IF;
    IF l.followup_after_days IS NULL THEN
      RAISE EXCEPTION 'activity:no_followup_configured: activity % has no followup_after_days', l.id;
    END IF;
    UPDATE public.user_activity_followups
       SET asks = asks + 1, due_at = now() + make_interval(days => l.followup_after_days), updated_at = now()
     WHERE id = f.id RETURNING * INTO f;
  END IF;
  RETURN jsonb_build_object('followup', to_jsonb(f), 'awarded', v_paid);
END;
$function$;

-- After a facts write: committed rows, and done-but-unverified rows, whose activity's fact now has the target value,
-- with that CURRENT observation dated after the commitment (committed_at, or created_at for an end-card did_it).
-- Seeded facts count. Records the resolving user_facts row; committed → done by data; pays the bonus once.
CREATE OR REPLACE FUNCTION public.resolve_activity_followups(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  r        record;
  v_bonus  integer := (SELECT value::int FROM public.app_settings WHERE key = 'followup_verified_bonus');
  v_out    jsonb := '[]'::jsonb;
  v_paid   integer;
BEGIN
  FOR r IN
    SELECT f.id, f.status, fl.observation_id
      FROM public.user_activity_followups f
      JOIN public.lessons l ON l.id = f.lesson_id
      JOIN public.user_facts_latest fl
        ON fl.user_id = f.user_id AND fl.fact_key = l.verify_fact_key AND fl.value = l.verify_fact_value
     WHERE f.user_id = p_user
       AND f.verified_at IS NULL
       AND (f.status = 'committed' OR f.status = 'done')
       AND l.verify_fact_key IS NOT NULL
       AND fl.observed_at > coalesce(f.committed_at, f.created_at)
     FOR UPDATE OF f
  LOOP
    UPDATE public.user_activity_followups
       SET verified_at = now(), verified_fact_id = r.observation_id, updated_at = now(),
           status      = 'done',
           resolved_at = CASE WHEN r.status = 'committed' THEN now() ELSE resolved_at END,
           resolved_by = CASE WHEN r.status = 'committed' THEN 'data' ELSE resolved_by END
     WHERE id = r.id;
    v_paid := public.activity_award(p_user, v_bonus, 'activity_verified', r.id);
    v_out := v_out || jsonb_build_object('followup_id', r.id, 'was', r.status, 'fact_id', r.observation_id, 'awarded', v_paid);
  END LOOP;
  RETURN v_out;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.activity_award(uuid, integer, text, uuid)        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.activity_finish(uuid, uuid, text)                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.activity_followup_answer(uuid, uuid, text)        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.resolve_activity_followups(uuid)                  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.activity_award(uuid, integer, text, uuid)        TO service_role;
GRANT  EXECUTE ON FUNCTION public.activity_finish(uuid, uuid, text)                 TO service_role;
GRANT  EXECUTE ON FUNCTION public.activity_followup_answer(uuid, uuid, text)        TO service_role;
GRANT  EXECUTE ON FUNCTION public.resolve_activity_followups(uuid)                  TO service_role;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION (after apply):
-- 1. completed_items: anon / authenticated hold no DELETE or TRUNCATE; no DELETE or ALL policy remains;
--    completed_items_sel / _ins / _upd unchanged.
-- 2. lessons: 3 columns + 4 constraints; every existing row has NULL follow-up columns.
-- 3. user_activity_followups: constraints, RLS on + uaf_sel; authenticated SELECT only; anon nothing.
-- 4. app_settings: the 3 rows + 2 CHECKs. activity_followup_limits() → (2, 14).
-- 5. user_activity_followups_due: security_invoker = true; authenticated + service_role SELECT; anon nothing.
-- 6. The four functions: EXECUTE service_role only (activity_followup_limits: + authenticated).
-- 7. Behaviour, ROLLED BACK: docs/drafts/113-activity-followups/verify.sql.
-- ---------------------------------------------------------------------------
