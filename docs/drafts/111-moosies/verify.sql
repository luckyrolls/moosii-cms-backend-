-- Migration 111 — behaviour verification. EVERYTHING ROLLS BACK (BEGIN … ROLLBACK); safe on a live project.
-- Run AFTER 111:  psql "<db url>" -X -v ON_ERROR_STOP=1 -f docs/drafts/111-moosies/verify.sql
-- Picks one user with a user_configurations row and lessons they have NOT completed. Anything missing (an activity,
-- a questionnaire) is made INSIDE the transaction — temporary kind flip / fixture row, gone at ROLLBACK.
-- Each case asserts: exactly one new ledger row with the expected amount, and the balance moved by exactly that.
-- Any failed assertion RAISEs (→ psql exits non-zero, transaction aborted, nothing kept).
\set ON_ERROR_STOP 1
BEGIN;

DO $$
DECLARE
  v_uid uuid; v_l1 uuid; v_l2 uuid; v_act uuid; v_q uuid; v_track uuid;
  p_l1 int; p_l2 int; p_q int;
BEGIN
  SELECT u.id INTO v_uid FROM public."user" u JOIN public.user_configurations c ON c.user_id = u.id
   ORDER BY u.id LIMIT 1;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'verify: no user with a user_configurations row'; END IF;

  -- two ordinary lessons with points, not completed by v_uid
  SELECT l.id, l.points INTO v_l1, p_l1 FROM public.lessons l
   WHERE l.kind = 'lesson' AND l.points IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.completed_items ci WHERE ci.user_id = v_uid AND ci.lesson_id = l.id)
   ORDER BY l.id LIMIT 1;
  SELECT l.id, l.points INTO v_l2, p_l2 FROM public.lessons l
   WHERE l.kind = 'lesson' AND l.points IS NOT NULL AND l.id <> v_l1
     AND NOT EXISTS (SELECT 1 FROM public.completed_items ci WHERE ci.user_id = v_uid AND ci.lesson_id = l.id)
   ORDER BY l.id LIMIT 1;
  IF v_l2 IS NULL THEN RAISE EXCEPTION 'verify: need two uncompleted lessons with points for %', v_uid; END IF;

  -- an activity: a real one if uncompleted, else a third lesson flipped to kind='activity' (rolled back)
  SELECT l.id INTO v_act FROM public.lessons l
   WHERE l.kind = 'activity'
     AND NOT EXISTS (SELECT 1 FROM public.completed_items ci WHERE ci.user_id = v_uid AND ci.lesson_id = l.id)
   LIMIT 1;
  IF v_act IS NULL THEN
    SELECT l.id INTO v_act FROM public.lessons l
     WHERE l.kind = 'lesson' AND l.id NOT IN (v_l1, v_l2)
       AND NOT EXISTS (SELECT 1 FROM public.completed_items ci WHERE ci.user_id = v_uid AND ci.lesson_id = l.id)
     ORDER BY l.id LIMIT 1;
    UPDATE public.lessons SET kind = 'activity' WHERE id = v_act;
    RAISE NOTICE 'activity: flipped lesson % to kind=activity (rolled back)', v_act;
  END IF;
  IF (SELECT points FROM public.lessons WHERE id = v_act) IS NULL THEN
    UPDATE public.lessons SET points = 5 WHERE id = v_act;      -- prove kind wins over points
  END IF;

  -- a questionnaire with points: an existing one, else a fixture row (rolled back)
  SELECT q.id, q.points INTO v_q, p_q FROM public.questionnaire q WHERE q.points IS NOT NULL ORDER BY q.id LIMIT 1;
  IF v_q IS NULL THEN
    SELECT id INTO v_track FROM public.tracks ORDER BY id LIMIT 1;
    INSERT INTO public.questionnaire (track_id, kind, points) VALUES (v_track, 'checkin', 7) RETURNING id, points INTO v_q, p_q;
    RAISE NOTICE 'questionnaire: fixture % created (rolled back)', v_q;
  END IF;

  PERFORM set_config('v.uid', v_uid::text, true), set_config('v.l1', v_l1::text, true),
          set_config('v.l2', v_l2::text, true),   set_config('v.act', v_act::text, true),
          set_config('v.q', v_q::text, true),     set_config('v.p_l1', p_l1::text, true),
          set_config('v.p_l2', p_l2::text, true), set_config('v.p_q', p_q::text, true);
  RAISE NOTICE 'fixtures: user % · lesson % (% pts) · lesson % (% pts) · activity % · questionnaire % (% pts)',
    v_uid, v_l1, p_l1, v_l2, p_l2, v_act, v_q, p_q;
END $$;

-- Assertion helper: insert ONE completion, then check ledger delta = 1 row of p_amount and balance delta = p_amount.
CREATE FUNCTION pg_temp.check_completion(p_label text, p_type text, p_item uuid, p_amount int) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_uid uuid := current_setting('v.uid')::uuid; b0 bigint; b1 bigint; n0 int; n1 int; v_id bigint; v_amt int;
BEGIN
  SELECT moosies INTO b0 FROM public."user" WHERE id = v_uid;
  SELECT count(*) INTO n0 FROM public.moosie_awards WHERE user_id = v_uid;
  INSERT INTO public.completed_items (user_id, item_id, item_type, lesson_id, questionnaire_id, item_name, score)
  VALUES (v_uid, p_item, p_type,
          CASE WHEN p_type = 'lesson' THEN p_item END,
          CASE WHEN p_type = 'questionnaire' THEN p_item END, 'verify 111', 0)
  RETURNING id INTO v_id;
  SELECT moosies INTO b1 FROM public."user" WHERE id = v_uid;
  SELECT count(*) INTO n1 FROM public.moosie_awards WHERE user_id = v_uid;
  SELECT amount INTO v_amt FROM public.moosie_awards WHERE reason = 'completion' AND source_id = v_id::text;
  IF n1 - n0 <> 1 OR v_amt IS DISTINCT FROM p_amount OR b1 - b0 <> p_amount THEN
    RAISE EXCEPTION 'FAIL %: ledger +% (want 1), amount % (want %), balance +% (want %)',
      p_label, n1 - n0, v_amt, p_amount, b1 - b0, p_amount;
  END IF;
  RAISE NOTICE 'PASS %: completion % → 1 ledger row, amount %, balance % → %', p_label, v_id, v_amt, b0, b1;
END $$;

SELECT pg_temp.check_completion('lesson',          'lesson',        current_setting('v.l1')::uuid,  current_setting('v.p_l1')::int);
SELECT pg_temp.check_completion('activity pays 0', 'lesson',        current_setting('v.act')::uuid, 0);
SELECT pg_temp.check_completion('questionnaire #1','questionnaire', current_setting('v.q')::uuid,   current_setting('v.p_q')::int);
SELECT pg_temp.check_completion('questionnaire #2 (recurrence pays again)', 'questionnaire', current_setting('v.q')::uuid, current_setting('v.p_q')::int);

-- Fallback: an item with NO points pays the user's moosi_to_add (a third lesson, points nulled — rolled back).
DO $$ DECLARE v_l3 uuid; BEGIN
  SELECT l.id INTO v_l3 FROM public.lessons l
   WHERE l.kind = 'lesson' AND l.id NOT IN (current_setting('v.l1')::uuid, current_setting('v.l2')::uuid)
     AND NOT EXISTS (SELECT 1 FROM public.completed_items ci WHERE ci.user_id = current_setting('v.uid')::uuid AND ci.lesson_id = l.id)
   ORDER BY l.id LIMIT 1;
  IF v_l3 IS NULL THEN RAISE EXCEPTION 'verify: need a third uncompleted lesson'; END IF;
  UPDATE public.lessons SET points = NULL WHERE id = v_l3;
  PERFORM set_config('v.l3', v_l3::text, true);
END $$;
SELECT pg_temp.check_completion('no points → moosi_to_add fallback', 'lesson', current_setting('v.l3')::uuid,
  (SELECT moosi_to_add FROM public.user_configurations WHERE user_id = current_setting('v.uid')::uuid));

-- Double insert pays once: (a) a second completion of the same lesson is refused (F29), balance/ledger unchanged;
-- (b) a second ledger row for the same source is refused by UNIQUE (reason, source_id).
DO $$
DECLARE v_uid uuid := current_setting('v.uid')::uuid; b0 bigint; b1 bigint; n0 int; n1 int; v_src text;
BEGIN
  SELECT moosies INTO b0 FROM public."user" WHERE id = v_uid;
  SELECT count(*) INTO n0 FROM public.moosie_awards WHERE user_id = v_uid;
  BEGIN
    INSERT INTO public.completed_items (user_id, item_id, item_type, lesson_id, item_name, score)
    VALUES (v_uid, current_setting('v.l1')::uuid, 'lesson', current_setting('v.l1')::uuid, 'verify 111 dup', 0);
    RAISE EXCEPTION 'FAIL duplicate lesson completion was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS duplicate lesson completion → 23505 (%)', SQLERRM;
  END;
  SELECT source_id INTO v_src FROM public.moosie_awards WHERE user_id = v_uid AND reason = 'completion' ORDER BY created_at LIMIT 1;
  INSERT INTO public.moosie_awards (user_id, amount, reason, source_id) VALUES (v_uid, 99, 'completion', v_src)
  ON CONFLICT (reason, source_id) DO NOTHING;
  SELECT moosies INTO b1 FROM public."user" WHERE id = v_uid;
  SELECT count(*) INTO n1 FROM public.moosie_awards WHERE user_id = v_uid;
  IF b1 <> b0 OR n1 <> n0 THEN RAISE EXCEPTION 'FAIL double insert: balance % → %, ledger % → %', b0, b1, n0, n1; END IF;
  RAISE NOTICE 'PASS double insert pays once: balance % and ledger % unchanged', b1, n1;
  BEGIN
    INSERT INTO public.moosie_awards (user_id, amount, reason, source_id) VALUES (v_uid, 1, 'completion', 'abc');
    RAISE EXCEPTION 'FAIL source_id shape accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS completion source_id must be a decimal id (23514)';
  END;
END $$;

-- RN's path: the completion inserted AS `authenticated` (own row), the trigger still pays (SECURITY DEFINER).
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('v.uid'), 'role', 'authenticated')::text, true);
SELECT set_config('v.b0', (SELECT moosies::text FROM public."user" WHERE id = current_setting('v.uid')::uuid), true);
SET LOCAL ROLE authenticated;
INSERT INTO public.completed_items (user_id, item_id, item_type, lesson_id, item_name, score)
VALUES (current_setting('v.uid')::uuid, current_setting('v.l2')::uuid, 'lesson', current_setting('v.l2')::uuid, 'verify 111 rn', 0);
-- what the app can and cannot do with the ledger
SELECT 'authenticated sees own ledger rows' AS check, count(*) FROM public.moosie_awards;
DO $$ BEGIN
  INSERT INTO public.moosie_awards (user_id, amount, reason, source_id)
  VALUES (current_setting('v.uid')::uuid, 1000, 'completion', '999999999');
  RAISE EXCEPTION 'FAIL authenticated could write the ledger';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS authenticated cannot write moosie_awards (42501)';
END $$;
RESET ROLE;
DO $$
DECLARE v_uid uuid := current_setting('v.uid')::uuid; b1 bigint; v_amt int; v_n int;
BEGIN
  SELECT moosies INTO b1 FROM public."user" WHERE id = v_uid;
  SELECT count(*), max(a.amount) INTO v_n, v_amt FROM public.moosie_awards a
    JOIN public.completed_items ci ON a.reason = 'completion' AND a.source_id = ci.id::text
   WHERE ci.user_id = v_uid AND ci.lesson_id = current_setting('v.l2')::uuid;
  IF v_n <> 1 OR v_amt <> current_setting('v.p_l2')::int OR b1 - current_setting('v.b0')::bigint <> v_amt THEN
    RAISE EXCEPTION 'FAIL authenticated path: % rows, amount %, balance +%', v_n, v_amt, b1 - current_setting('v.b0')::bigint;
  END IF;
  RAISE NOTICE 'PASS authenticated (RN) completion → 1 ledger row, amount %, balance +%', v_amt, v_amt;
END $$;

ROLLBACK;
\echo 'verify 111: all checks passed — rolled back, nothing kept'
