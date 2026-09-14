-- Seed a restored copy of Moosii's public schema, snapshot the service view, and record what
-- anon can read BEFORE 078. Runs as postgres (BYPASSRLS locally: superuser).
\set ON_ERROR_STOP 1
\set QUIET 1
SET client_min_messages = notice;

INSERT INTO auth.users (id) VALUES
  ('a0000000-0000-0000-0000-000000000001'),   -- ordinary user
  ('a0000000-0000-0000-0000-000000000002'),   -- another ordinary user
  ('a0000000-0000-0000-0000-000000000003'),   -- admin
  ('a0000000-0000-0000-0000-000000000004');   -- super_admin
INSERT INTO public."user" (id, role, daily_reminder_time) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'user',        '09:00'),
  ('a0000000-0000-0000-0000-000000000002', 'user',        '09:00'),
  ('a0000000-0000-0000-0000-000000000003', 'admin',       '09:00'),
  ('a0000000-0000-0000-0000-000000000004', 'super_admin', '09:00');
INSERT INTO public.tracks (id, track_name, weight) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'Default track', 3),
  ('b0000000-0000-0000-0000-000000000002', 'Fact track',    2),
  ('b0000000-0000-0000-0000-000000000003', 'Manual track',  1);
INSERT INTO public.new_user_tracks (track_id) VALUES ('b0000000-0000-0000-0000-000000000001');
INSERT INTO public.children (parent_id, birth_year, birth_month) VALUES
  ('a0000000-0000-0000-0000-000000000001', 2025, 3),
  ('a0000000-0000-0000-0000-000000000002', 2024, 7);
INSERT INTO public.user_mlp_mods (user_id, track_id, action) VALUES
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000003', 'add');
INSERT INTO public.fact_keys (fact_key, kind, label) VALUES ('saving_for_home', 'boolean', 'Saving for a home');
INSERT INTO public.fact_values (fact_key, value, label) VALUES ('saving_for_home', 'true', 'Yes'), ('saving_for_home', 'false', 'No');
INSERT INTO public.fact_track_rules (fact_key, value, track_id) VALUES ('saving_for_home', 'true', 'b0000000-0000-0000-0000-000000000002');
INSERT INTO public.user_facts (user_id, fact_key, value, source, observed_at) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'saving_for_home', 'true', 'platform_api', '2026-09-01');

CREATE TABLE _pre_uat    AS SELECT user_id, track_id FROM user_active_tracks;
CREATE TABLE _pre_reason AS SELECT * FROM user_active_tracks_with_reason;
DO $$ BEGIN
  RAISE NOTICE 'seeded: service view shows % user_active_tracks rows, % with_reason rows',
    (SELECT count(*) FROM _pre_uat), (SELECT count(*) FROM _pre_reason);
END $$;

-- THE HOLE, before 078: anon reading as PostgREST would.
DO $$ DECLARE n_uat int; n_mlp int; n_fin int; BEGIN
  EXECUTE 'SET LOCAL ROLE anon';
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SELECT count(*) INTO n_uat FROM user_active_tracks;
  SELECT count(*) INTO n_mlp FROM user_mlp_data;
  SELECT count(*) INTO n_fin FROM user_mlp_data WHERE financials IS NOT NULL OR parenting_status IS NOT NULL OR gender IS NOT NULL OR child_count > 0;
  EXECUTE 'RESET ROLE';
  RAISE NOTICE 'BEFORE 078 — anon reads: user_active_tracks % rows (every user), user_mlp_data % rows (% with profile/child data)', n_uat, n_mlp, n_fin;
END $$;
DO $$ DECLARE n int; BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated","sub":"a0000000-0000-0000-0000-000000000001"}', true);
  SELECT count(*) INTO n FROM user_active_tracks WHERE user_id <> 'a0000000-0000-0000-0000-000000000001';
  EXECUTE 'RESET ROLE';
  RAISE NOTICE 'BEFORE 078 — ordinary user 1 reads % user_active_tracks rows belonging to OTHER users', n;
END $$;
