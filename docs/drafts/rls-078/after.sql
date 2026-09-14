-- Assertions after 078 on the restored Moosii schema. Each role check simulates a PostgREST
-- request: SET LOCAL ROLE + request.jwt.claims (what auth.uid()/auth.role() read).
\set ON_ERROR_STOP 1
\set QUIET 1
SET client_min_messages = notice;

-- ---- 1. catalog --------------------------------------------------------------------------
DO $$ DECLARE v text; BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.is_admin()'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.is_super_admin()'::regprocedure) THEN
    RAISE EXCEPTION 'FAIL admin checks not SECURITY DEFINER'; END IF;
  FOREACH v IN ARRAY ARRAY['user_facts_latest','user_mlp_data','questionnaire_responses_tracks','user_active_tracks','user_active_tracks_with_reason'] LOOP
    IF coalesce(array_to_string((SELECT reloptions FROM pg_class WHERE oid = ('public.' || v)::regclass), ','), '') NOT LIKE '%security_invoker=true%' THEN
      RAISE EXCEPTION 'FAIL % is not security_invoker', v; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'Enable read access for all users'
              AND tablename IN ('children','completed_items','user')) THEN
    RAISE EXCEPTION 'FAIL a blanket true policy survived'; END IF;
  IF to_regprocedure('public.user_fact_track_ids(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'FAIL helper still exists'; END IF;
  IF pg_get_functiondef('user_active_tracks_for_user(uuid)'::regprocedure) LIKE '%user_fact_track_ids%' THEN
    RAISE EXCEPTION 'FAIL function still references the helper'; END IF;
  RAISE NOTICE 'PASS catalog: admin checks SECURITY DEFINER; 5 views security_invoker; 3 blanket policies gone; helper dropped';
END $$;

-- ---- 2. service (postgres, BYPASSRLS): unchanged rows, twins agree --------------------------
DO $$ BEGIN
  IF (SELECT count(*) FROM (SELECT user_id, track_id FROM user_active_tracks EXCEPT SELECT * FROM _pre_uat) a) +
     (SELECT count(*) FROM (SELECT * FROM _pre_uat EXCEPT SELECT user_id, track_id FROM user_active_tracks) b) <> 0
  THEN RAISE EXCEPTION 'FAIL service: user_active_tracks changed'; END IF;
  IF (SELECT count(*) FROM (SELECT * FROM user_active_tracks_with_reason EXCEPT SELECT * FROM _pre_reason) a) +
     (SELECT count(*) FROM (SELECT * FROM _pre_reason EXCEPT SELECT * FROM user_active_tracks_with_reason) b) <> 0
  THEN RAISE EXCEPTION 'FAIL service: with_reason changed'; END IF;
  IF (SELECT count(*) FROM (
        SELECT user_id, track_id FROM user_active_tracks
        EXCEPT SELECT f.user_id, f.track_id FROM "user" u CROSS JOIN LATERAL user_active_tracks_for_user(u.id) f) x) <> 0
  THEN RAISE EXCEPTION 'FAIL service: twins disagree'; END IF;
  RAISE NOTICE 'PASS service/postgres: user_active_tracks (% rows) and with_reason identical to before 078; twins agree', (SELECT count(*) FROM _pre_uat);
END $$;

-- service_role through PostgREST
DO $$ DECLARE n int; BEGIN
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  SELECT count(*) INTO n FROM user_active_tracks;
  EXECUTE 'RESET ROLE';
  IF n <> (SELECT count(*) FROM _pre_uat) THEN RAISE EXCEPTION 'FAIL service_role sees % rows, expected %', n, (SELECT count(*) FROM _pre_uat); END IF;
  RAISE NOTICE 'PASS service_role (backend) sees all % rows', n;
END $$;

-- ---- 3. admin and super_admin: everything (the CMS inspector) -------------------------------
DO $$ DECLARE who text; h_uat text; h_reason text; n int; BEGIN
  FOREACH who IN ARRAY ARRAY['a0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000004'] LOOP
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', who)::text, true);
    SELECT md5(string_agg(user_id::text || track_id::text, ',' ORDER BY user_id, track_id)) INTO h_uat FROM user_active_tracks;
    SELECT md5(string_agg(t::text, ',' ORDER BY t::text)) INTO h_reason FROM user_active_tracks_with_reason t;
    SELECT count(*) INTO n FROM user_active_tracks_for_user('a0000000-0000-0000-0000-000000000001');
    EXECUTE 'RESET ROLE';
    IF h_uat IS DISTINCT FROM (SELECT md5(string_agg(user_id::text || track_id::text, ',' ORDER BY user_id, track_id)) FROM _pre_uat)
      THEN RAISE EXCEPTION 'FAIL admin % user_active_tracks differs from service', who; END IF;
    IF h_reason IS DISTINCT FROM (SELECT md5(string_agg(t::text, ',' ORDER BY t::text)) FROM _pre_reason t)
      THEN RAISE EXCEPTION 'FAIL admin % with_reason differs from service', who; END IF;
    IF n <> (SELECT count(*) FROM _pre_uat WHERE user_id = 'a0000000-0000-0000-0000-000000000001')
      THEN RAISE EXCEPTION 'FAIL admin % function call for user 1 returned %', who, n; END IF;
  END LOOP;
  RAISE NOTICE 'PASS admin and super_admin: user_active_tracks and with_reason identical to service; function call for another user complete (CMS inspector path)';
END $$;

-- ---- 4. ordinary user: own rows only, complete ---------------------------------------------
DO $$ DECLARE h_own text; n_other int; n_fn_self int; n_fn_other int; n_user int; n_children int;
              n_other_mods int; has_default int; has_fact int; n_facts int; BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","sub":"a0000000-0000-0000-0000-000000000001"}', true);
  SELECT md5(string_agg(user_id::text || track_id::text, ',' ORDER BY user_id, track_id)) INTO h_own FROM user_active_tracks;
  SELECT count(*) INTO n_other FROM user_active_tracks WHERE user_id <> 'a0000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO n_fn_self  FROM user_active_tracks_for_user('a0000000-0000-0000-0000-000000000001');
  SELECT count(*) INTO n_fn_other FROM user_active_tracks_for_user('a0000000-0000-0000-0000-000000000002');
  SELECT count(*) INTO n_user FROM "user";
  SELECT count(*) INTO n_children FROM children;
  SELECT count(*) INTO n_other_mods FROM user_mlp_mods;
  SELECT count(*) INTO has_default FROM user_active_tracks WHERE track_id = 'b0000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO has_fact FROM user_active_tracks WHERE track_id = 'b0000000-0000-0000-0000-000000000002';
  SELECT count(*) INTO n_facts FROM user_facts_latest;
  EXECUTE 'RESET ROLE';
  IF n_other <> 0 THEN RAISE EXCEPTION 'FAIL user 1 still sees % rows of other users', n_other; END IF;
  IF h_own IS DISTINCT FROM (SELECT md5(string_agg(user_id::text || track_id::text, ',' ORDER BY user_id, track_id)) FROM _pre_uat WHERE user_id = 'a0000000-0000-0000-0000-000000000001')
    THEN RAISE EXCEPTION 'FAIL user 1 own rows differ from the service view of user 1'; END IF;
  IF n_fn_self <> (SELECT count(*) FROM _pre_uat WHERE user_id = 'a0000000-0000-0000-0000-000000000001')
    THEN RAISE EXCEPTION 'FAIL user 1 function(self) returned %', n_fn_self; END IF;
  IF n_fn_other <> 0 THEN RAISE EXCEPTION 'FAIL user 1 function(user 2) returned % rows', n_fn_other; END IF;
  IF n_user <> 1 OR n_children <> 1 OR n_other_mods <> 0 THEN
    RAISE EXCEPTION 'FAIL user 1 reads user=% children=% user_mlp_mods=% (expect 1/1/0)', n_user, n_children, n_other_mods; END IF;
  IF has_default <> 1 THEN RAISE EXCEPTION 'FAIL user 1 lost the default track (new_user_tracks policy)'; END IF;
  IF has_fact <> 1 OR n_facts <> 1 THEN RAISE EXCEPTION 'FAIL user 1 fact track=% own facts=%', has_fact, n_facts; END IF;
  RAISE NOTICE 'PASS ordinary user: only own rows, identical to the service view of them; default + fact tracks present; function(other user) = 0; reads 1 user row, 1 child, 0 foreign mods, own fact only';
END $$;

-- the OTHER user cannot see user 1's fact, but does see their own manual track
DO $$ DECLARE n_facts int; n_mod int; BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","sub":"a0000000-0000-0000-0000-000000000002"}', true);
  SELECT count(*) INTO n_facts FROM user_facts_latest;
  SELECT count(*) INTO n_mod FROM user_active_tracks WHERE track_id = 'b0000000-0000-0000-0000-000000000003';
  EXECUTE 'RESET ROLE';
  IF n_facts <> 0 THEN RAISE EXCEPTION 'FAIL user 2 sees % facts of user 1', n_facts; END IF;
  IF n_mod <> 1 THEN RAISE EXCEPTION 'FAIL user 2 lost their own manual-add track'; END IF;
  RAISE NOTICE 'PASS another user: sees 0 of user 1''s facts; keeps their own manual-add track';
END $$;

-- admin sees user 1's fact
DO $$ DECLARE n int; BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","sub":"a0000000-0000-0000-0000-000000000003"}', true);
  SELECT count(*) INTO n FROM user_facts_latest;
  EXECUTE 'RESET ROLE';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL admin sees % facts', n; END IF;
  RAISE NOTICE 'PASS admin reads all facts';
END $$;

-- ---- 5. anon: nothing, and no error ----------------------------------------------------------
DO $$ DECLARE a int; b int; c int; d int; e int; f int; BEGIN
  EXECUTE 'SET LOCAL ROLE anon';
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SELECT count(*) INTO a FROM user_active_tracks;
  SELECT count(*) INTO b FROM user_active_tracks_with_reason;
  SELECT count(*) INTO c FROM user_mlp_data;
  SELECT count(*) INTO d FROM user_facts_latest;
  SELECT count(*) INTO e FROM user_active_tracks_for_user('a0000000-0000-0000-0000-000000000001');
  SELECT count(*) INTO f FROM "user";
  EXECUTE 'RESET ROLE';
  IF a + b + c + d + e + f <> 0 THEN
    RAISE EXCEPTION 'FAIL anon reads uat=% with_reason=% mlp_data=% facts=% fn=% user=%', a, b, c, d, e, f; END IF;
  RAISE NOTICE 'PASS anon: user_active_tracks, with_reason, user_mlp_data, user_facts_latest, the function and user all return 0 rows, no error';
END $$;

-- ---- 6. no recursion through is_admin() on a policy-heavy read ------------------------------
DO $$ DECLARE n int; BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","sub":"a0000000-0000-0000-0000-000000000003"}', true);
  SELECT count(*) INTO n FROM "user";
  EXECUTE 'RESET ROLE';
  IF n <> 4 THEN RAISE EXCEPTION 'FAIL admin reads % user rows (expect 4)', n; END IF;
  RAISE NOTICE 'PASS no policy recursion: an admin reads all 4 user rows through is_admin() -> user';
END $$;

\echo '--- ALL 078 ASSERTIONS HELD'
