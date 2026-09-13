-- Minimal Supabase-shaped stubs for exercising the facts-v1 drafts. NOT the real schema:
-- only the columns 069-076 and the 045 function/view actually touch.
\set ON_ERROR_STOP 1

-- Supabase roles. service_role bypasses RLS; anon/authenticated do not.
-- Roles are cluster-wide, so they survive a DROP DATABASE between runs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Supabase's default: every new public table/view/function is granted to all three roles,
-- which is what makes an explicit REVOKE meaningful.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);

CREATE TABLE tracks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_name text, priority integer, weight integer NOT NULL DEFAULT 1,
  archived_at timestamptz
);
CREATE TABLE lessons  (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                       track_id uuid REFERENCES tracks(id) ON DELETE RESTRICT);
CREATE TABLE segments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                       lesson_id uuid REFERENCES lessons(id));

CREATE TABLE demographic_questions (id uuid PRIMARY KEY, is_active boolean);
CREATE TABLE demographic_answers   (id uuid PRIMARY KEY, is_active boolean);
CREATE TABLE demographic_track_rules (answer_id uuid, track_id uuid REFERENCES tracks(id) ON DELETE RESTRICT);
CREATE TABLE user_demographic_responses (user_id uuid, question_id uuid, answer_id uuid);
CREATE TABLE user_mlp_data (user_id uuid);   -- a view in production; a table is enough here
CREATE TABLE new_user_tracks (track_id uuid REFERENCES tracks(id) ON DELETE RESTRICT);
CREATE TABLE questionnaire_responses_tracks (user_id uuid, track_id uuid, tag_id uuid,
                                             add boolean, action_at timestamptz);
CREATE TABLE track_tag_map (tag_id uuid, track_id uuid);
CREATE TABLE user_mlp_mods (user_id uuid, track_id uuid, action text,
                            created_at timestamptz NOT NULL DEFAULT now());

-- Fixtures -------------------------------------------------------------------
INSERT INTO tracks (id, track_name, priority, weight, archived_at) VALUES
  ('10000000-0000-0000-0000-000000000001', 'Default track',       1, 3, NULL),
  ('10000000-0000-0000-0000-000000000002', 'Fact track',          1, 2, NULL),
  ('10000000-0000-0000-0000-000000000003', 'Archived fact track', 1, 1, now()),
  ('10000000-0000-0000-0000-000000000004', '* All Tracks',        1, 1, NULL);
INSERT INTO new_user_tracks VALUES ('10000000-0000-0000-0000-000000000001');
INSERT INTO auth.users VALUES
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000a3');
INSERT INTO user_mlp_data VALUES
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000a3');
INSERT INTO lessons (id, track_id) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002');
INSERT INTO segments (id, lesson_id) VALUES
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001');
