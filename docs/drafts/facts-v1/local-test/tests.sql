-- Exercises the facts-v1 drafts after 069-076 are applied. PASS/FAIL lines are NOTICEs;
-- an assertion that does not hold RAISEs and stops the run (ON_ERROR_STOP).
\set ON_ERROR_STOP 1
\set QUIET 1
SET client_min_messages = notice;

-- ---- 075 seeds ---------------------------------------------------------------
DO $$ BEGIN
  IF (SELECT count(*) FROM fact_keys) <> 6 OR (SELECT count(*) FROM fact_values) <> 13 THEN
    RAISE EXCEPTION 'FAIL 075 expected 6 keys / 13 values';
  END IF;
  RAISE NOTICE 'PASS 075 seeds: 6 keys, 13 values';
END $$;

-- ---- 069 "no amounts" --------------------------------------------------------
DO $$ DECLARE v text; BEGIN
  FOREACH v IN ARRAY ARRAY['1200', '$40', '0.82', ' 12', '-5', 'Low', 'twelve percent'] LOOP
    BEGIN
      INSERT INTO fact_values (fact_key, value, label) VALUES ('credit_utilization_band', v, 'x');
      RAISE EXCEPTION 'FAIL 069 accepted value %', quote_literal(v);
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  BEGIN
    INSERT INTO fact_keys (fact_key, kind, label) VALUES ('1abc', 'enum', 'x');
    RAISE EXCEPTION 'FAIL 069 accepted key 1abc';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 069 rejects 7 amount/shape values and a numeric-leading key';
END $$;

-- ---- 070 observation log ------------------------------------------------------
DO $$ BEGIN
  BEGIN
    INSERT INTO user_facts (user_id, fact_key, value, source)
    VALUES (gen_random_uuid(), 'credit_utilization_band', 'enormous', 'manual');
    RAISE EXCEPTION 'FAIL 070 accepted unknown pair';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO user_facts (user_id, fact_key, value, source)
    VALUES (gen_random_uuid(), 'credit_utilization_band', '0.82', 'manual');
    RAISE EXCEPTION 'FAIL 070 accepted an amount';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO user_facts (user_id, fact_key, value, source)
    VALUES (gen_random_uuid(), 'has_direct_deposit', 'true', 'partner_x');
    RAISE EXCEPTION 'FAIL 070 accepted unknown source';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 070 rejects unknown pair (23503), amount (23514), unknown source (23514)';
END $$;

-- clearing keeps history; 071 returns the newer value only
INSERT INTO user_facts (user_id, fact_key, value, source, observed_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'has_emergency_buffer', 'true',  'manual', '2026-01-01'),
  ('00000000-0000-0000-0000-0000000000a1', 'has_emergency_buffer', 'false', 'manual', '2026-01-02');
-- a LATE-ARRIVING older observation must not win
INSERT INTO user_facts (user_id, fact_key, value, source, observed_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'has_emergency_buffer', 'true',  'manual', '2025-12-31');
DO $$ BEGIN
  IF (SELECT count(*) FROM user_facts WHERE user_id = '00000000-0000-0000-0000-0000000000a1') <> 3
     OR (SELECT string_agg(value, ',') FROM user_facts_latest
          WHERE user_id = '00000000-0000-0000-0000-0000000000a1') <> 'false' THEN
    RAISE EXCEPTION 'FAIL 071 latest-wins';
  END IF;
  RAISE NOTICE 'PASS 070/071 history kept (3 rows); latest = false; a late older observation does not win';
END $$;

-- ---- 074 arm ------------------------------------------------------------------
-- Twins must agree for every user. Reused below after every change.
CREATE OR REPLACE FUNCTION pg_temp.twin_diff() RETURNS bigint LANGUAGE sql AS $$
  WITH users AS (SELECT user_id FROM user_mlp_data
                 UNION SELECT user_id FROM user_facts),
  fn AS (SELECT f.user_id, f.track_id FROM users u
           CROSS JOIN LATERAL user_active_tracks_for_user(u.user_id) f),
  vw AS (SELECT user_id, track_id FROM user_active_tracks)
  SELECT (SELECT count(*) FROM (SELECT * FROM vw EXCEPT SELECT * FROM fn) a)
       + (SELECT count(*) FROM (SELECT * FROM fn EXCEPT SELECT * FROM vw) b);
$$;
CREATE OR REPLACE FUNCTION pg_temp.has_track(u uuid, t uuid) RETURNS text LANGUAGE sql AS $$
  SELECT (EXISTS (SELECT 1 FROM user_active_tracks_for_user(u) WHERE track_id = t))::text || '/' ||
         (EXISTS (SELECT 1 FROM user_active_tracks WHERE user_id = u AND track_id = t))::text;
$$;

DO $$ BEGIN
  IF (SELECT count(*) FROM (SELECT user_id, track_id FROM user_active_tracks
                            EXCEPT SELECT user_id, track_id FROM _snap_045) d) <> 0
     OR (SELECT count(*) FROM (SELECT user_id, track_id FROM _snap_045
                            EXCEPT SELECT user_id, track_id FROM user_active_tracks) d) <> 0 THEN
    RAISE EXCEPTION 'FAIL 074 no-op: resolution changed with zero rules';
  END IF;
  IF pg_temp.twin_diff() <> 0 THEN RAISE EXCEPTION 'FAIL 074 twins differ with zero rules'; END IF;
  RAISE NOTICE 'PASS 074 no-op: zero rules -> resolution identical to the 045 snapshot; twins agree';
END $$;
DO $$ BEGIN
  IF (SELECT count(*) FROM (SELECT * FROM user_active_tracks_with_reason EXCEPT SELECT * FROM _snap_reason) d) <> 0
     OR (SELECT count(*) FROM (SELECT * FROM _snap_reason EXCEPT SELECT * FROM user_active_tracks_with_reason) d) <> 0 THEN
    RAISE EXCEPTION 'FAIL 074 with_reason changed with zero rules';
  END IF;
  RAISE NOTICE 'PASS 074 with_reason no-op: zero rules -> row-for-row identical to the live-definition snapshot';
END $$;

-- sole source: rule saving_for_home=true -> Fact track; u2 gains it, then loses it on clearing
INSERT INTO fact_track_rules (fact_key, value, track_id)
VALUES ('saving_for_home', 'true', '10000000-0000-0000-0000-000000000002');
INSERT INTO user_facts (user_id, fact_key, value, source, observed_at)
VALUES ('00000000-0000-0000-0000-0000000000a2', 'saving_for_home', 'true', 'platform_api', '2026-02-01');
DO $$ BEGIN
  IF pg_temp.has_track('00000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-000000000002') <> 'true/true'
     OR pg_temp.twin_diff() <> 0 THEN RAISE EXCEPTION 'FAIL 074 grant'; END IF;
  RAISE NOTICE 'PASS 074 grant: matching fact adds the track in BOTH function and view';
END $$;
DO $$ DECLARE r record; BEGIN
  SELECT active_reason, reason_detail INTO r FROM user_active_tracks_with_reason
   WHERE user_id = '00000000-0000-0000-0000-0000000000a2' AND track_id = '10000000-0000-0000-0000-000000000002';
  IF r.active_reason IS DISTINCT FROM 'fact_match' OR r.reason_detail IS DISTINCT FROM 'Fact: saving_for_home = true' THEN
    RAISE EXCEPTION 'FAIL 074 with_reason label: % / %', r.active_reason, r.reason_detail;
  END IF;
  RAISE NOTICE 'PASS 074 with_reason labels the fact-granted track fact_match / "Fact: saving_for_home = true"';
END $$;
INSERT INTO user_facts (user_id, fact_key, value, source, observed_at)
VALUES ('00000000-0000-0000-0000-0000000000a2', 'saving_for_home', 'false', 'platform_api', '2026-02-02');
DO $$ BEGIN
  IF pg_temp.has_track('00000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-000000000002') <> 'false/false'
     OR pg_temp.twin_diff() <> 0 THEN RAISE EXCEPTION 'FAIL 074 clear (sole source)'; END IF;
  RAISE NOTICE 'PASS 074 clear, sole source: the track LEAVES from both (README §4 "FALSE as a blanket claim")';
END $$;

-- other arm also grants: has_direct_deposit=true -> Default track (also a default track)
INSERT INTO fact_track_rules (fact_key, value, track_id)
VALUES ('has_direct_deposit', 'true', '10000000-0000-0000-0000-000000000001');
INSERT INTO user_facts (user_id, fact_key, value, source, observed_at) VALUES
  ('00000000-0000-0000-0000-0000000000a2', 'has_direct_deposit', 'true',  'platform_api', '2026-02-03'),
  ('00000000-0000-0000-0000-0000000000a2', 'has_direct_deposit', 'false', 'platform_api', '2026-02-04');
DO $$ BEGIN
  IF pg_temp.has_track('00000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-000000000001') <> 'true/true'
  THEN RAISE EXCEPTION 'FAIL 074 clear (other arm)'; END IF;
  RAISE NOTICE 'PASS 074 clear, other arm grants too: the track STAYS';
END $$;

-- archived target stays inert
INSERT INTO fact_track_rules (fact_key, value, track_id)
VALUES ('wants_debt_payoff_plan', 'true', '10000000-0000-0000-0000-000000000003');
INSERT INTO user_facts (user_id, fact_key, value, source, observed_at)
VALUES ('00000000-0000-0000-0000-0000000000a2', 'wants_debt_payoff_plan', 'true', 'platform_api', '2026-02-05');
DO $$ BEGIN
  IF pg_temp.has_track('00000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-000000000003') <> 'false/false'
  THEN RAISE EXCEPTION 'FAIL 074 archived'; END IF;
  RAISE NOTICE 'PASS 074 archived target track is invisible in both';
END $$;

-- admin delete wins over a live fact
INSERT INTO user_facts (user_id, fact_key, value, source, observed_at)
VALUES ('00000000-0000-0000-0000-0000000000a3', 'saving_for_home', 'true', 'platform_api', '2026-03-01');
INSERT INTO user_mlp_mods (user_id, track_id, action, created_at)
VALUES ('00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000002', 'add', '2026-03-01');
INSERT INTO user_facts (user_id, fact_key, value, source, observed_at)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'saving_for_home', 'true', 'platform_api', '2026-03-01');
INSERT INTO user_mlp_mods (user_id, track_id, action, created_at)
VALUES ('00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000002', 'delete', '2026-03-02');
DO $$ BEGIN
  IF pg_temp.has_track('00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000002') <> 'false/false'
     OR pg_temp.has_track('00000000-0000-0000-0000-0000000000a3', '10000000-0000-0000-0000-000000000002') <> 'true/true'
     OR pg_temp.twin_diff() <> 0 THEN RAISE EXCEPTION 'FAIL 074 admin delete'; END IF;
  RAISE NOTICE 'PASS 074 an admin delete mod beats a live fact; twins agree after every step';
END $$;

-- ---- 072 / 073 ----------------------------------------------------------------
DO $$ BEGIN
  BEGIN
    INSERT INTO fact_track_rules (fact_key, value, track_id)
    VALUES ('credit_utilization_band', 'nonsense', '10000000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'FAIL 072 accepted unknown value';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    DELETE FROM lessons  WHERE track_id = '10000000-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'unreachable';
  EXCEPTION WHEN foreign_key_violation THEN NULL;   -- segments FK, stub noise; skip
  END;
  BEGIN
    DELETE FROM tracks WHERE id = '10000000-0000-0000-0000-000000000003';
    RAISE EXCEPTION 'FAIL 072 deleted a rule-targeted track';
  EXCEPTION WHEN foreign_key_violation OR restrict_violation THEN
    RAISE NOTICE 'PROBE ON DELETE RESTRICT refusal SQLSTATE = %', SQLSTATE;
  END;
  RAISE NOTICE 'PASS 072 unknown value 23503; deleting a rule-targeted track is refused';
END $$;

DO $$ BEGIN
  BEGIN
    INSERT INTO fact_entry_map (fact_key, value, lesson_id, segment_id) VALUES
      ('wants_debt_payoff_plan', 'true', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FAIL 073 two targets';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO fact_entry_map (fact_key, value) VALUES ('wants_debt_payoff_plan', 'true');
    RAISE EXCEPTION 'FAIL 073 no target';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO fact_entry_map (fact_key, value, lesson_id)
  VALUES ('wants_debt_payoff_plan', 'true', '20000000-0000-0000-0000-000000000001');
  BEGIN
    INSERT INTO fact_entry_map (fact_key, value, segment_id)
    VALUES ('wants_debt_payoff_plan', 'true', '30000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FAIL 073 second entry point for one pair';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'PASS 073 exactly-one target; one entry point per pair';
END $$;

-- ---- ROLE / GRANT behaviour (071 REVOKE) ----------------------------------------
\echo '--- PROBE: as authenticated'
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM 1 FROM user_facts_latest LIMIT 1;
  RAISE NOTICE 'PROBE authenticated SELECT user_facts_latest: ALLOWED';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PROBE authenticated SELECT user_facts_latest: DENIED (%)', SQLERRM;
END $$;
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM user_active_tracks
   WHERE user_id = '00000000-0000-0000-0000-0000000000a3' AND track_id = '10000000-0000-0000-0000-000000000002';
  RAISE NOTICE 'PROBE authenticated SELECT user_active_tracks (view): OK, fact track visible = %', n;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 071 fact arm hidden from an authenticated view reader'; END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PROBE authenticated SELECT user_active_tracks (view): DENIED (%)', SQLERRM;
END $$;
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM user_active_tracks_with_reason
   WHERE user_id = '00000000-0000-0000-0000-0000000000a3' AND active_reason = 'fact_match';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 074 with_reason fact_match hidden from authenticated (CMS inspector path)'; END IF;
  RAISE NOTICE 'PASS 074 authenticated with_reason read (the CMS inspector path) shows fact_match';
END $$;
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM user_active_tracks_for_user('00000000-0000-0000-0000-0000000000a3')
   WHERE track_id = '10000000-0000-0000-0000-000000000002';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 074 authenticated function call lost the fact track'; END IF;
  RAISE NOTICE 'PASS 074 authenticated CALL of user_active_tracks_for_user works and includes the fact track (via helper)';
END $$;
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM user_fact_track_ids('00000000-0000-0000-0000-0000000000a3');
  RAISE NOTICE 'PROBE authenticated user_fact_track_ids(): % track id(s); the helper returns ids only', n;
END $$;
RESET ROLE;
SET ROLE anon;
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM user_active_tracks_for_user('00000000-0000-0000-0000-0000000000a3')
   WHERE track_id = '10000000-0000-0000-0000-000000000002';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 074 anon function call changed'; END IF;
  RAISE NOTICE 'PASS 074 anon CALL behaves as today (still works — 077 is where anon loses it)';
END $$;
DO $$ BEGIN
  PERFORM 1 FROM user_facts_latest LIMIT 1;
  RAISE EXCEPTION 'FAIL anon can read user_facts_latest';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS anon SELECT user_facts_latest refused';
END $$;
RESET ROLE;
SET ROLE service_role;
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM user_active_tracks_for_user('00000000-0000-0000-0000-0000000000a3');
  RAISE NOTICE 'PROBE service_role user_active_tracks_for_user(): OK, % rows', n;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PROBE service_role user_active_tracks_for_user(): DENIED (%)', SQLERRM;
END $$;
RESET ROLE;

-- ---- Contract probes: one multi-row INSERT per POST /facts call ----------------------
\echo '--- PROBE: batch semantics'
-- same key twice in one call, observed_at omitted (both default to the same now())
DO $$ BEGIN
  INSERT INTO user_facts (user_id, fact_key, value, source) VALUES
    ('00000000-0000-0000-0000-0000000000a3', 'has_direct_deposit', 'true',  'platform_api'),
    ('00000000-0000-0000-0000-0000000000a3', 'has_direct_deposit', 'false', 'platform_api');
  RAISE NOTICE 'PROBE dup key, no ON CONFLICT: BOTH INSERTED';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PROBE dup key, no ON CONFLICT: whole statement rejected (23505)';
END $$;
DO $$ DECLARE kept text; n int; BEGIN
  WITH ins AS (
    INSERT INTO user_facts (user_id, fact_key, value, source) VALUES
      ('00000000-0000-0000-0000-0000000000a3', 'has_direct_deposit', 'true',  'platform_api'),
      ('00000000-0000-0000-0000-0000000000a3', 'has_direct_deposit', 'false', 'platform_api')
    ON CONFLICT (user_id, fact_key, observed_at) DO NOTHING RETURNING value)
  SELECT count(*), string_agg(value, ',') INTO n, kept FROM ins;
  RAISE NOTICE 'PROBE dup key, ON CONFLICT DO NOTHING: % written, kept value = % — the other is silently "skipped"', n, kept;
  RAISE EXCEPTION USING ERRCODE = 'P0002';   -- roll back the probe rows
EXCEPTION WHEN no_data_found THEN NULL;
END $$;
-- redelivery at the SAME observed_at but a DIFFERENT value
INSERT INTO user_facts (user_id, fact_key, value, source, observed_at)
VALUES ('00000000-0000-0000-0000-0000000000a3', 'has_emergency_buffer', 'true', 'platform_api', '2026-04-01');
DO $$ DECLARE n int; BEGIN
  WITH ins AS (
    INSERT INTO user_facts (user_id, fact_key, value, source, observed_at)
    VALUES ('00000000-0000-0000-0000-0000000000a3', 'has_emergency_buffer', 'false', 'platform_api', '2026-04-01')
    ON CONFLICT (user_id, fact_key, observed_at) DO NOTHING RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  RAISE NOTICE 'PROBE same instant, different value, DO NOTHING: % written — a CONTRADICTION counted as "skipped"', n;
END $$;
-- redelivery of a call WITHOUT observed_at
DO $$ DECLARE n int; BEGIN
  INSERT INTO user_facts (user_id, fact_key, value, source)
  VALUES ('00000000-0000-0000-0000-0000000000a3', 'new_subscription_recent', 'true', 'platform_api');
  PERFORM pg_sleep(0.01);
  RAISE NOTICE 'first delivery written';
END $$;
DO $$ DECLARE n int; BEGIN
  WITH ins AS (
    INSERT INTO user_facts (user_id, fact_key, value, source)
    VALUES ('00000000-0000-0000-0000-0000000000a3', 'new_subscription_recent', 'true', 'platform_api')
    ON CONFLICT (user_id, fact_key, observed_at) DO NOTHING RETURNING 1)
  SELECT count(*) INTO n FROM ins;
  RAISE NOTICE 'PROBE redelivery without observed_at: % written — NOT idempotent (new now())', n;
END $$;

-- ---- ON UPDATE CASCADE rewrites history ----------------------------------------------
\echo '--- PROBE: renaming a vocabulary value'
INSERT INTO user_facts (user_id, fact_key, value, source, observed_at)
VALUES ('00000000-0000-0000-0000-0000000000a3', 'credit_utilization_band', 'moderate', 'platform_api', '2026-05-01');
DO $$ BEGIN
  UPDATE fact_values SET value = 'medium' WHERE fact_key = 'credit_utilization_band' AND value = 'moderate';
  RAISE EXCEPTION 'FAIL 070 renaming an in-use value rewrote history';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'PASS 070 renaming an in-use value is refused (%) — history is immutable', SQLSTATE;
END $$;
DO $$ BEGIN
  UPDATE fact_values SET value = 'low_band' WHERE fact_key = 'credit_utilization_band' AND value = 'low';
  RAISE NOTICE 'PASS 070 renaming an UNUSED value still works';
  RAISE EXCEPTION USING ERRCODE = 'P0002';
EXCEPTION WHEN no_data_found THEN NULL;
END $$;

-- ---- D1 option (b) compiles and cascades ---------------------------------------------
DO $$ BEGIN
  DELETE FROM user_facts WHERE user_id NOT IN (SELECT id FROM auth.users);
  ALTER TABLE user_facts ADD CONSTRAINT user_facts_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;
  DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-0000000000a3';
  IF EXISTS (SELECT 1 FROM user_facts WHERE user_id = '00000000-0000-0000-0000-0000000000a3') THEN
    RAISE EXCEPTION 'FAIL D1(b) cascade';
  END IF;
  RAISE NOTICE 'PASS D1 option (b) FK to auth.users compiles and cascades on user delete';
  RAISE EXCEPTION USING ERRCODE = 'P0002';
EXCEPTION WHEN no_data_found THEN NULL;
END $$;

-- ---- 076 --------------------------------------------------------------------------
DO $$ BEGIN
  INSERT INTO user_external_ids (partner, external_user_id, user_id)
  VALUES ('demo', 'ext-1', '00000000-0000-0000-0000-000000000001'),
         ('other', 'ext-1', gen_random_uuid());
  BEGIN
    INSERT INTO user_external_ids (partner, external_user_id, user_id) VALUES ('demo', 'ext-1', gen_random_uuid());
    RAISE EXCEPTION 'FAIL 076 dup ext id';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO user_external_ids (partner, external_user_id, user_id)
    VALUES ('demo', 'ext-2', '00000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FAIL 076 two ids for one user';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO user_external_ids (partner, external_user_id, user_id) VALUES ('demo', '   ', gen_random_uuid());
    RAISE EXCEPTION 'FAIL 076 blank';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO user_external_ids (partner, external_user_id, user_id) VALUES ('Bad Partner', 'x', gen_random_uuid());
    RAISE EXCEPTION 'FAIL 076 partner shape';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'PASS 076 both uniqueness directions, per-partner namespaces, shape CHECKs';
  RAISE EXCEPTION USING ERRCODE = 'P0002';
EXCEPTION WHEN no_data_found THEN NULL;
END $$;

\echo '--- ALL ASSERTIONS HELD'
