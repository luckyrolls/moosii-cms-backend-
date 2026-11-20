-- Fixture for the 128 harness. Applied AFTER 127 and BEFORE 128, because 128's backfill reads
-- rows and a schema-only dump restores none: without this, PRE-CHECK rightly refuses (no mem
-- seed track) and the backfill would prove nothing.
--
-- Shape-faithful to Moosii, smaller: mooselist tracks all archived, one active "New Parents" as
-- the mem seed, some other active tracks that the backfill must archive as legacy, and some
-- already-archived ones that only need the label.
--
-- Fixed UUIDs, so the behaviour suite can assert on exact sets.

INSERT INTO public.app_settings (key, value)
VALUES ('domain', 'moosii')
ON CONFLICT (key) DO UPDATE SET value = 'moosii';

-- ---------------------------------------------------------------- tracks
-- 4 x mooselist, every one archived (the real curriculum, shelved because the initial mode is mem)
INSERT INTO public.tracks (id, track_name, created_by, archived_at) VALUES
  ('aaaa0001-0000-4000-8000-000000000001', 'LIVE Baby Sleep',      'mooselist', now() - interval '30 days'),
  ('aaaa0001-0000-4000-8000-000000000002', 'LIVE Feeding',         'mooselist', now() - interval '30 days'),
  ('aaaa0001-0000-4000-8000-000000000003', 'LIVE Gross Motor',     'mooselist', now() - interval '30 days'),
  ('aaaa0001-0000-4000-8000-000000000004', 'LIVE Speech',          'mooselist', now() - interval '30 days');

-- the mem seed: the one active test track, by the id 128 hardcodes
INSERT INTO public.tracks (id, track_name, created_by, archived_at) VALUES
  ('2076eb8c-4d5b-4b52-86c9-6b22ecc47192', 'New Parents', 'legacy', NULL);

-- 3 x active, not mooselist, not the seed -> legacy AND NEWLY ARCHIVED by the backfill
INSERT INTO public.tracks (id, track_name, created_by, archived_at) VALUES
  ('bbbb0002-0000-4000-8000-000000000001', 'OLD Parental Wellness', NULL,                  NULL),
  ('bbbb0002-0000-4000-8000-000000000002', 'OLD Single parent',     'markmun99@test',      NULL),
  ('bbbb0002-0000-4000-8000-000000000003', 'OLD test',              'legacy',              NULL);

-- 1 x already archived -> legacy, otherwise untouched
INSERT INTO public.tracks (id, track_name, created_by, archived_at) VALUES
  ('cccc0003-0000-4000-8000-000000000002', 'ARCHIVED Rolling',  'milestone-batch-2026-07', now() - interval '10 days');

-- THE JOIN-IN, by the id 128 hardcodes: live Moosii's "Baby Is Crawling" — archived, from the
-- milestone batch, and the target of a questionnaire hosted on the mem seed track. That is the
-- ONE pre-existing cross-group link, reproduced exactly, so the harness proves the backfill
-- resolves it (retag to mem + unarchive) rather than merely proving a clean graph stays clean.
INSERT INTO public.tracks (id, track_name, created_by, archived_at) VALUES
  ('056884c8-9fd8-4919-b0a1-4b4126b6979c', 'ARCHIVED Crawling (the join-in)',
   'milestone-batch-2026-07', now() - interval '10 days');

-- ---------------------------------------------------------------- the questionnaire graph
-- Host and target both end up 'mem', so 128's PRE-CHECK passes — but NOT trivially: the response
-- points at the join-in track, which is only 'mem' BECAUSE the backfill puts it there. Before
-- 128 that link is mem -> legacy, exactly the live Moosii situation.
-- The suite builds the other cross-group cases itself, inside a rolled-back transaction.
INSERT INTO public.tags (id, tag_name) VALUES
  ('dddd0004-0000-4000-8000-000000000001', 'mem-tag');

INSERT INTO public.track_tag_map (id, tag_id, track_id) VALUES
  ('dddd0004-0000-4000-8000-0000000000a1',
   'dddd0004-0000-4000-8000-000000000001',
   '2076eb8c-4d5b-4b52-86c9-6b22ecc47192');

INSERT INTO public.questionnaire (id, questionnaire_name, track_id) VALUES
  ('eeee0005-0000-4000-8000-000000000001', 'Discovering Mobility',
   '2076eb8c-4d5b-4b52-86c9-6b22ecc47192');

-- -> the JOIN-IN track, not the seed: this is the link that made 128 refuse on Moosii.
INSERT INTO public.questionnaire_response (id, questionnaire_id, track_id, score_min_range, score_max_range) VALUES
  ('eeee0005-0000-4000-8000-0000000000a1', 'eeee0005-0000-4000-8000-000000000001',
   '056884c8-9fd8-4919-b0a1-4b4126b6979c', 3, 5);

INSERT INTO public.questionnaire_questions (question_id, questionnaire_id, question_text) VALUES
  ('ffff0006-0000-4000-8000-000000000001', 'eeee0005-0000-4000-8000-000000000001', 'Is baby crawling?');

INSERT INTO public.questionnaire_answers (id, question_id, answer_text, score) VALUES
  ('ffff0006-0000-4000-8000-0000000000a1', 'ffff0006-0000-4000-8000-000000000001', 'Yes', 5);

INSERT INTO public.questionnaire_answer_actions (id, answer_id, action_type, track_id) VALUES
  ('ffff0006-0000-4000-8000-0000000000b1', 'ffff0006-0000-4000-8000-0000000000a1', 'add_track',
   '2076eb8c-4d5b-4b52-86c9-6b22ecc47192');
