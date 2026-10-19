-- Migration 115 — verification. EVERYTHING ROLLS BACK (BEGIN … ROLLBACK); safe on a live project.
-- Run AFTER 115:  psql "<db url>" -X -v ON_ERROR_STOP=1 -f docs/drafts/115-activity-finish/verify.sql
-- Throwaway fixtures inside the transaction: two auth users (live new_user_trigger makes their "user" +
-- user_configurations rows; made here when no trigger exists) and an activity on an existing track.
\set ON_ERROR_STOP 1
BEGIN;

DO $$ BEGIN
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.activity_finish(uuid,uuid,text)'::regprocedure)
     <> 'a46762668442cbcb2e609f19b44892ab' THEN RAISE EXCEPTION 'FAIL activity_finish is not 115''s body'; END IF;
  IF has_function_privilege('anon', 'public.activity_finish(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.activity_finish(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.activity_finish(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL activity_finish EXECUTE grants changed'; END IF;
  RAISE NOTICE 'PASS 115 body in place; EXECUTE still service_role only';
END $$;

DO $$
DECLARE a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); act uuid := gen_random_uuid(); t uuid;
        r jsonb; r2 jsonb; fid uuid; n int; m bigint; upd text;
BEGIN
  INSERT INTO auth.users (id, created_at) VALUES (a, now()), (b, now());
  INSERT INTO public."user" (id, daily_reminder_time) VALUES (a, '09:00'), (b, '09:00') ON CONFLICT (id) DO NOTHING;
  UPDATE public."user" SET moosies = 0, role = 'user' WHERE id IN (a, b);
  SELECT id INTO t FROM public.tracks WHERE archived_at IS NULL ORDER BY id LIMIT 1;
  INSERT INTO public.lessons (id, lesson_name, track_id, points, kind, is_published, followup_after_days)
  VALUES (act, 'verify 115 activity', t, 5, 'activity', true, 7);

  -- later → finish(did_it): resolves once, pays once; repeat pays nothing
  r := public.activity_finish(a, act, 'later');
  fid := (r->'followup'->>'id')::uuid;
  r := public.activity_finish(a, act, 'did_it');
  IF r->'followup'->>'status' <> 'done' OR r->'followup'->>'resolved_by' <> 'self' OR (r->>'awarded')::int <> 5
     OR (r->'followup'->>'id')::uuid <> fid THEN RAISE EXCEPTION 'FAIL later → did_it: %', r; END IF;
  r2 := public.activity_finish(a, act, 'did_it');
  IF (r2->>'awarded')::int <> 0 OR r2->'followup' <> r->'followup' THEN RAISE EXCEPTION 'FAIL repeat did_it: %', r2; END IF;
  SELECT moosies INTO m FROM public."user" WHERE id = a;
  SELECT count(*) INTO n FROM public.moosie_awards WHERE user_id = a AND reason = 'activity_did_it';
  IF m <> 5 OR n <> 1 THEN RAISE EXCEPTION 'FAIL paid: balance %, did_it awards %', m, n; END IF;
  RAISE NOTICE 'PASS later → finish(did_it) → done/self, activity_did_it 5 paid once; repeat did_it pays 0, row unchanged';

  -- progress row written once
  SELECT count(*), max(updated_at)::text INTO n, upd FROM public.user_lesson_progress WHERE user_id = a AND lesson_id = act AND is_completed;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL progress rows %', n; END IF;
  PERFORM public.activity_finish(a, act, 'later');
  IF (SELECT max(updated_at)::text FROM public.user_lesson_progress WHERE user_id = a AND lesson_id = act) IS DISTINCT FROM upd THEN
    RAISE EXCEPTION 'FAIL a repeat touched the progress row'; END IF;
  RAISE NOTICE 'PASS user_lesson_progress {is_completed: true} written once; repeats leave it alone';

  -- not_for_me then did_it stays skipped
  r := public.activity_finish(b, act, 'not_for_me');
  r2 := public.activity_finish(b, act, 'did_it');
  IF r2->'followup'->>'status' <> 'skipped' OR (r2->>'awarded')::int <> 0 OR r2->'followup' <> r->'followup' THEN
    RAISE EXCEPTION 'FAIL skipped is not final: %', r2; END IF;
  SELECT moosies INTO m FROM public."user" WHERE id = b;
  IF m <> 0 THEN RAISE EXCEPTION 'FAIL skipped user paid %', m; END IF;
  RAISE NOTICE 'PASS not_for_me → did_it stays skipped, pays 0, row unchanged (status in the response: %)', r2->'followup'->>'status';
END $$;

ROLLBACK;
\echo 'verify 115: all checks passed — rolled back, nothing kept'
