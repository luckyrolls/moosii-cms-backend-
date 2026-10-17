-- Migration 112 — behaviour verification. EVERYTHING ROLLS BACK (BEGIN … ROLLBACK); safe on a live project.
-- Run AFTER 112:  psql "<db url>" -X -v ON_ERROR_STOP=1 -f docs/drafts/112-moosies-lock/verify.sql
-- Uses one existing user with a user_configurations row; a diagnostic and a check-in are made INSIDE the transaction
-- (fixture rows, gone at ROLLBACK), so the result doesn't depend on that user's history.
\set ON_ERROR_STOP 1
BEGIN;

DO $$
DECLARE v_uid uuid; v_track uuid; v_diag uuid; v_chk uuid; v_lesson uuid;
BEGIN
  SELECT u.id INTO v_uid FROM public."user" u JOIN public.user_configurations c ON c.user_id = u.id ORDER BY u.id LIMIT 1;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'verify: no user with a user_configurations row'; END IF;
  SELECT id INTO v_track FROM public.tracks ORDER BY id LIMIT 1;
  INSERT INTO public.questionnaire (track_id, kind, points) VALUES (v_track, 'diagnostic', 7) RETURNING id INTO v_diag;
  INSERT INTO public.questionnaire (track_id, kind, points) VALUES (v_track, 'checkin', 7) RETURNING id INTO v_chk;
  SELECT l.id INTO v_lesson FROM public.lessons l
   WHERE l.kind = 'lesson' AND l.points IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.completed_items ci WHERE ci.user_id = v_uid AND ci.lesson_id = l.id)
   ORDER BY l.id LIMIT 1;
  IF v_lesson IS NULL THEN RAISE EXCEPTION 'verify: need an uncompleted lesson with points'; END IF;
  PERFORM set_config('v.uid', v_uid::text, true), set_config('v.diag', v_diag::text, true),
          set_config('v.chk', v_chk::text, true),  set_config('v.lesson', v_lesson::text, true);
  RAISE NOTICE 'fixtures: user % · diagnostic % · check-in % (fixtures, rolled back) · lesson %', v_uid, v_diag, v_chk, v_lesson;
END $$;

-- One completion → assert one new ledger row of p_amount and a balance delta of p_amount.
CREATE FUNCTION pg_temp.check_completion(p_label text, p_type text, p_item uuid, p_amount int) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_uid uuid := current_setting('v.uid')::uuid; b0 bigint; b1 bigint; n0 int; n1 int; v_id bigint; v_amt int;
BEGIN
  SELECT moosies INTO b0 FROM public."user" WHERE id = v_uid;
  SELECT count(*) INTO n0 FROM public.moosie_awards WHERE user_id = v_uid;
  INSERT INTO public.completed_items (user_id, item_id, item_type, lesson_id, questionnaire_id, item_name, score)
  VALUES (v_uid, p_item, p_type, CASE WHEN p_type = 'lesson' THEN p_item END,
          CASE WHEN p_type = 'questionnaire' THEN p_item END, 'verify 112', 0)
  RETURNING id INTO v_id;
  SELECT moosies INTO b1 FROM public."user" WHERE id = v_uid;
  SELECT count(*) INTO n1 FROM public.moosie_awards WHERE user_id = v_uid;
  SELECT amount INTO v_amt FROM public.moosie_awards WHERE reason = 'completion' AND source_id = v_id::text;
  IF n1 - n0 <> 1 OR v_amt IS DISTINCT FROM p_amount OR b1 - b0 <> p_amount THEN
    RAISE EXCEPTION 'FAIL %: ledger +% (want 1), amount % (want %), balance +% (want %)', p_label, n1 - n0, v_amt, p_amount, b1 - b0, p_amount;
  END IF;
  RAISE NOTICE 'PASS %: 1 ledger row, amount %, balance % → %', p_label, v_amt, b0, b1;
END $$;

SELECT pg_temp.check_completion('diagnostic first completion pays',    'questionnaire', current_setting('v.diag')::uuid, 7);
SELECT pg_temp.check_completion('diagnostic retake pays 0 (row kept)', 'questionnaire', current_setting('v.diag')::uuid, 0);
SELECT pg_temp.check_completion('diagnostic 3rd completion pays 0',    'questionnaire', current_setting('v.diag')::uuid, 0);
SELECT pg_temp.check_completion('check-in #1 pays',                    'questionnaire', current_setting('v.chk')::uuid,  7);
SELECT pg_temp.check_completion('check-in #2 pays again',              'questionnaire', current_setting('v.chk')::uuid,  7);

-- As the app: a signed-in user on their own row.
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('v.uid'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

-- Forbidden columns → 42501 (column privilege), each in its own subtransaction.
DO $$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['moosies', 'role', 'can_review_editorial', 'can_approve_clinical', 'is_verified', 'email'] LOOP
    BEGIN
      EXECUTE format('UPDATE public."user" SET %I = %I WHERE id = %L', c, c, current_setting('v.uid'));
      RAISE EXCEPTION 'FAIL authenticated UPDATE of % was allowed', c;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS authenticated UPDATE of % → 42501', c;
    END;
  END LOOP;
  BEGIN
    UPDATE public."user" SET moosies = moosies + 1000 WHERE id = current_setting('v.uid')::uuid;
    RAISE EXCEPTION 'FAIL authenticated moosies += 1000 was allowed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS authenticated moosies += 1000 → 42501';
  END;
END $$;

-- Every inventoried client column still updates (1 row each, value written back unchanged).
DO $$
DECLARE c text; n int;
BEGIN
  FOREACH c IN ARRAY ARRAY['display_name', 'name', 'gender', 'parenting_status', 'financials', 'birth_date',
                           'onboarding_complete', 'has_seen_mlp_intro', 'has_seen_lesson_intro', 'has_seen_questionnaire_intro'] LOOP
    EXECUTE format('UPDATE public."user" SET %I = %I WHERE id = %L', c, c, current_setting('v.uid'));
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'FAIL authenticated UPDATE of % touched % rows', c, n; END IF;
    RAISE NOTICE 'PASS authenticated UPDATE of % → 1 row', c;
  END LOOP;
  -- the app's real calls, with real values
  UPDATE public."user" SET display_name = 'verify 112', onboarding_complete = true, has_seen_mlp_intro = true
   WHERE id = current_setting('v.uid')::uuid;
  RAISE NOTICE 'PASS profile + flags update together';
END $$;

-- The award trigger still moves the balance for an app-inserted completion.
SELECT set_config('v.b0', (SELECT moosies::text FROM public."user" WHERE id = current_setting('v.uid')::uuid), true);
INSERT INTO public.completed_items (user_id, item_id, item_type, lesson_id, item_name, score)
VALUES (current_setting('v.uid')::uuid, current_setting('v.lesson')::uuid, 'lesson', current_setting('v.lesson')::uuid, 'verify 112 rn', 0);
RESET ROLE;
DO $$
DECLARE d bigint := (SELECT moosies FROM public."user" WHERE id = current_setting('v.uid')::uuid) - current_setting('v.b0')::bigint;
        p int := (SELECT points FROM public.lessons WHERE id = current_setting('v.lesson')::uuid);
BEGIN
  IF d <> p THEN RAISE EXCEPTION 'FAIL authenticated completion moved balance by % (want %)', d, p; END IF;
  RAISE NOTICE 'PASS authenticated completion → trigger moved balance +%', d;
END $$;

-- Own-row INSERT. Two throwaway auth users (rolled back): CALLER, a plain role='user' account, and TARGET, an auth id
-- with no "user" row. The caller must NOT be a real user picked by id: user_self_insert (unchanged) lets a super_admin
-- insert any row by design, so an admin caller would wrongly "fail" this check (it did on financial, 2026-10-17).
-- Live auth.users has new_user_trigger, which creates each new user's "user" row at once: the caller keeps its row
-- (made here when no trigger exists, e.g. the local stub), the target's is deleted — RN's onboarding insert is the
-- fallback for exactly that state.
DO $$ DECLARE v_caller uuid := gen_random_uuid(); v_new uuid := gen_random_uuid(); BEGIN
  INSERT INTO auth.users (id, created_at) VALUES (v_caller, now()), (v_new, now());
  INSERT INTO public."user" (id, daily_reminder_time) VALUES (v_caller, '09:00') ON CONFLICT (id) DO NOTHING;
  UPDATE public."user" SET role = 'user' WHERE id = v_caller AND role IS DISTINCT FROM 'user';
  DELETE FROM public."user" WHERE id = v_new;
  PERFORM set_config('v.caller', v_caller::text, true), set_config('v.new', v_new::text, true);
  RAISE NOTICE 'own-row insert: throwaway caller % (role user) · target % (no row) — rolled back', v_caller, v_new;
END $$;
-- (a) the plain caller, signed in, inserts a row for the TARGET id → refused by RLS (42501)
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('v.caller'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public."user" (id, email, daily_reminder_time, onboarding_complete)
  VALUES (current_setting('v.new')::uuid, 'm112-squat-' || current_setting('v.new') || '@example.test', '09:00', false);
  RAISE EXCEPTION 'FAIL authenticated inserted a "user" row for another id';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS authenticated INSERT of another user''s row → 42501 (%)', SQLERRM;
END $$;
-- (b) the target, signed in, inserts its OWN row with RN's four columns → OK
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('v.new'), 'role', 'authenticated')::text, true);
INSERT INTO public."user" (id, email, daily_reminder_time, onboarding_complete)
VALUES (current_setting('v.new')::uuid, 'm112-own-' || current_setting('v.new') || '@example.test', '09:00', false);
RESET ROLE;
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public."user" WHERE id = current_setting('v.new')::uuid AND moosies = 0 AND role = 'user';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL own-row insert: % rows with moosies 0 / role user', n; END IF;
  RAISE NOTICE 'PASS authenticated INSERT of its own row → 1 row (moosies 0, role user)';
END $$;

ROLLBACK;
\echo 'verify 112: all checks passed — rolled back, nothing kept'
