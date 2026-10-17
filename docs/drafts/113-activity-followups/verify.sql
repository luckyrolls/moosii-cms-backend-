-- Migration 113 — verification. EVERYTHING ROLLS BACK (BEGIN … ROLLBACK); safe on a live project.
-- Run AFTER 113:  psql "<db url>" -X -v ON_ERROR_STOP=1 -f docs/drafts/113-activity-followups/verify.sql
-- Builds throwaway fixtures inside the transaction: an auth user (live new_user_trigger makes its "user" +
-- user_configurations rows; made here when no trigger exists), a fact key, an activity lesson on an existing track.
\set ON_ERROR_STOP 1
BEGIN;

-- ---- Structure ----
DO $$ DECLARE n int; BEGIN
  IF has_table_privilege('authenticated', 'public.completed_items', 'DELETE') OR has_table_privilege('anon', 'public.completed_items', 'DELETE')
     OR has_table_privilege('authenticated', 'public.completed_items', 'TRUNCATE') THEN RAISE EXCEPTION 'FAIL completed_items still client-deletable'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'completed_items' AND cmd IN ('DELETE', 'ALL');
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL % DELETE/ALL policies left on completed_items', n; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'completed_items' AND policyname IN ('completed_items_sel','completed_items_ins','completed_items_upd');
  IF n <> 3 THEN RAISE EXCEPTION 'FAIL completed_items sel/ins/upd policies: %', n; END IF;
  SELECT count(*) INTO n FROM public.lessons WHERE followup_after_days IS NOT NULL OR verify_fact_key IS NOT NULL;
  RAISE NOTICE 'PASS F37 + structure: completed_items not client-deletable, 3 policies kept; lessons with follow-up settings: %', n;
  IF has_table_privilege('authenticated', 'public.user_activity_followups', 'INSERT') OR has_table_privilege('authenticated', 'public.user_activity_followups', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.user_activity_followups', 'DELETE') OR has_table_privilege('anon', 'public.user_activity_followups', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.user_activity_followups', 'SELECT') THEN RAISE EXCEPTION 'FAIL user_activity_followups grants'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.user_activity_followups'::regclass) THEN RAISE EXCEPTION 'FAIL RLS off'; END IF;
  IF (SELECT reloptions FROM pg_class WHERE oid = 'public.user_activity_followups_due'::regclass) IS DISTINCT FROM ARRAY['security_invoker=true'] THEN
    RAISE EXCEPTION 'FAIL due view not security_invoker'; END IF;
  IF has_table_privilege('anon', 'public.user_activity_followups_due', 'SELECT') THEN RAISE EXCEPTION 'FAIL anon reads the due view'; END IF;
  IF has_function_privilege('authenticated', 'public.activity_finish(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.activity_followup_answer(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_activity_followups(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.activity_award(uuid,integer,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.activity_followup_limits()', 'EXECUTE') THEN RAISE EXCEPTION 'FAIL function grants'; END IF;
  IF (SELECT row(max_asks, grace_days)::text FROM public.activity_followup_limits()) <> '(2,14)' THEN RAISE EXCEPTION 'FAIL limits'; END IF;
  IF (SELECT value FROM public.app_settings WHERE key = 'followup_verified_bonus') <> '5' THEN RAISE EXCEPTION 'FAIL bonus setting'; END IF;
  RAISE NOTICE 'PASS follow-ups table / view / functions / settings: grants, RLS, invoker, limits (2, 14), bonus 5';
END $$;

-- ---- Fixtures (rolled back) ----
DO $$ DECLARE v_user uuid := gen_random_uuid(); v_act uuid := gen_random_uuid(); v_key text := 'v113_' || substr(md5(random()::text), 1, 8); v_track uuid;
BEGIN
  INSERT INTO auth.users (id, created_at) VALUES (v_user, now());
  INSERT INTO public."user" (id, daily_reminder_time) VALUES (v_user, '09:00') ON CONFLICT (id) DO NOTHING;
  UPDATE public."user" SET role = 'user', moosies = 0 WHERE id = v_user;
  INSERT INTO public.fact_keys (fact_key, kind, label) VALUES (v_key, 'boolean', 'verify 113');
  INSERT INTO public.fact_values (fact_key, value, label) VALUES (v_key, 'true', 'yes'), (v_key, 'false', 'no');
  SELECT id INTO v_track FROM public.tracks WHERE archived_at IS NULL ORDER BY id LIMIT 1;
  INSERT INTO public.lessons (id, lesson_name, track_id, points, kind, is_published, followup_after_days, verify_fact_key, verify_fact_value)
  VALUES (v_act, 'verify 113 activity', v_track, 5, 'activity', true, 3, v_key, 'true');
  PERFORM set_config('v.user', v_user::text, true), set_config('v.act', v_act::text, true), set_config('v.key', v_key, true);
  RAISE NOTICE 'fixtures (rolled back): user % · activity % · fact key %', v_user, v_act, v_key;
END $$;

-- ---- Behaviour ----
DO $$
DECLARE u uuid := current_setting('v.user')::uuid; a uuid := current_setting('v.act')::uuid; k text := current_setting('v.key');
        r jsonb; r2 jsonb; fid uuid; n int; m bigint; factid uuid;
BEGIN
  -- later → committed; idempotent repeat; one completion paying 0
  r := public.activity_finish(u, a, 'later');
  fid := (r->'followup'->>'id')::uuid;
  IF r->'followup'->>'status' <> 'committed' OR (r->>'created')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL later: %', r; END IF;
  r2 := public.activity_finish(u, a, 'did_it');
  IF (r2->>'created')::boolean OR r2->'followup' <> r->'followup' THEN RAISE EXCEPTION 'FAIL idempotent finish: %', r2; END IF;
  SELECT count(*) INTO n FROM public.completed_items WHERE user_id = u AND lesson_id = a;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL completions %', n; END IF;
  RAISE NOTICE 'PASS finish later → committed; repeat returns it unchanged; 1 completion';

  -- due after backdating; not_yet twice → out of the view
  UPDATE public.user_activity_followups SET due_at = now() - interval '1 day' WHERE id = fid;
  IF NOT EXISTS (SELECT 1 FROM public.user_activity_followups_due WHERE id = fid) THEN RAISE EXCEPTION 'FAIL not due'; END IF;
  PERFORM public.activity_followup_answer(u, fid, 'not_yet');
  UPDATE public.user_activity_followups SET due_at = now() - interval '1 day' WHERE id = fid;
  PERFORM public.activity_followup_answer(u, fid, 'not_yet');
  UPDATE public.user_activity_followups SET due_at = now() - interval '1 day' WHERE id = fid;
  IF EXISTS (SELECT 1 FROM public.user_activity_followups_due WHERE id = fid) THEN RAISE EXCEPTION 'FAIL still due after 2 not_yet'; END IF;
  RAISE NOTICE 'PASS due view; two not_yet → lapsed (out of the view)';

  -- evidence before commitment does nothing; after → done by data, fact recorded, bonus once
  INSERT INTO public.user_facts (user_id, fact_key, value, observed_at, source) VALUES (u, k, 'true', now() - interval '30 days', 'seed');
  IF jsonb_array_length(public.resolve_activity_followups(u)) <> 0 THEN RAISE EXCEPTION 'FAIL resolved on pre-commitment evidence'; END IF;
  INSERT INTO public.user_facts (user_id, fact_key, value, observed_at, source) VALUES (u, k, 'true', now() + interval '1 second', 'seed') RETURNING id INTO factid;
  r := public.resolve_activity_followups(u);
  IF jsonb_array_length(r) <> 1 OR (r->0->>'fact_id')::uuid <> factid OR (r->0->>'awarded')::int <> 5 THEN RAISE EXCEPTION 'FAIL resolve: %', r; END IF;
  IF jsonb_array_length(public.resolve_activity_followups(u)) <> 0 THEN RAISE EXCEPTION 'FAIL resolved twice'; END IF;
  SELECT moosies INTO m FROM public."user" WHERE id = u;
  IF m <> 5 THEN RAISE EXCEPTION 'FAIL balance % (want 5: completion 0 + bonus 5)', m; END IF;
  IF (SELECT row(status, resolved_by, verified_fact_id)::text FROM public.user_activity_followups WHERE id = fid) <> row('done', 'data', factid)::text THEN
    RAISE EXCEPTION 'FAIL row after resolve'; END IF;
  RAISE NOTICE 'PASS pre-commitment evidence ignored; seeded fact after it → done by data, fact % recorded, bonus 5 once', factid;
END $$;

-- ---- As the app ----
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('v.user'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN DELETE FROM public.completed_items WHERE user_id = current_setting('v.user')::uuid; RAISE EXCEPTION 'FAIL client DELETE allowed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS client DELETE on completed_items → 42501'; END;
  BEGIN UPDATE public.user_activity_followups SET asks = 0 WHERE user_id = current_setting('v.user')::uuid; RAISE EXCEPTION 'FAIL client UPDATE allowed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS client UPDATE on user_activity_followups → 42501'; END;
  BEGIN PERFORM public.activity_finish(current_setting('v.user')::uuid, current_setting('v.act')::uuid, 'did_it'); RAISE EXCEPTION 'FAIL client EXECUTE allowed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS client EXECUTE of activity_finish → 42501'; END;
  IF (SELECT count(*) FROM public.user_activity_followups) <> 1 THEN RAISE EXCEPTION 'FAIL client sees other rows'; END IF;
  IF (SELECT count(*) FROM public.completed_items WHERE user_id = current_setting('v.user')::uuid) <> 1 THEN RAISE EXCEPTION 'FAIL client cannot read own completion'; END IF;
  RAISE NOTICE 'PASS client reads exactly its own follow-up and completion';
END $$;
RESET ROLE;

ROLLBACK;
\echo 'verify 113: all checks passed — rolled back, nothing kept'
