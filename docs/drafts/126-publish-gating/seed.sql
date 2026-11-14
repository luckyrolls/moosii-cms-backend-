-- Fixture for the migration-126 harness. Run AFTER restoring the Moosii schema dump, BEFORE 126.
--
-- Actors   ...0001 super_admin (gains can_publish when 126 runs)
--          ...0002 plain admin, no capabilities
--          ...0003 admin with can_approve_clinical only
-- Lessons  L1 clean (approved, no quiz)      L2 one incomplete segment
--          L3 approved + PENDING quiz        L4 approved, in an ARCHIVED track
--          L5 no segment at all              L6 approved + APPROVED quiz
--          L7 already published WITH a pending quiz -- the shape of the 5 live Moosii rows
\set ON_ERROR_STOP on

INSERT INTO auth.users (id) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001'),
  ('aaaaaaaa-0000-4000-8000-000000000002'),
  ('aaaaaaaa-0000-4000-8000-000000000003');

-- daily_reminder_time is NOT NULL with no default on `user`
INSERT INTO public."user" (id, role, can_review_editorial, can_approve_clinical, daily_reminder_time) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001','super_admin', true,  true,  '09:00'),
  ('aaaaaaaa-0000-4000-8000-000000000002','admin',       false, false, '09:00'),
  ('aaaaaaaa-0000-4000-8000-000000000003','admin',       false, true,  '09:00');

INSERT INTO public.tracks (id, track_name) VALUES
  ('bbbbbbbb-0000-4000-8000-000000000001','Live Track'),
  ('bbbbbbbb-0000-4000-8000-000000000002','Archived Track'),
  ('bbbbbbbb-0000-4000-8000-000000000003','Second Live Track');
UPDATE public.tracks SET archived_at = now() WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002';

INSERT INTO public.lessons (id, lesson_name, track_id, is_published) VALUES
  ('cccccccc-0000-4000-8000-000000000001','L1 clean',        'bbbbbbbb-0000-4000-8000-000000000001', false),
  ('cccccccc-0000-4000-8000-000000000002','L2 incomplete',   'bbbbbbbb-0000-4000-8000-000000000001', false),
  ('cccccccc-0000-4000-8000-000000000003','L3 quiz pending', 'bbbbbbbb-0000-4000-8000-000000000001', false),
  ('cccccccc-0000-4000-8000-000000000004','L4 archived trk', 'bbbbbbbb-0000-4000-8000-000000000002', false),
  ('cccccccc-0000-4000-8000-000000000005','L5 no segment',   'bbbbbbbb-0000-4000-8000-000000000001', false),
  ('cccccccc-0000-4000-8000-000000000006','L6 quiz ok',      'bbbbbbbb-0000-4000-8000-000000000001', false),
  ('cccccccc-0000-4000-8000-000000000007','L7 legacy pub',   'bbbbbbbb-0000-4000-8000-000000000001', true);

INSERT INTO public.segments (id, lesson_id, segment_order) VALUES
  ('dddddddd-0000-4000-8000-000000000001','cccccccc-0000-4000-8000-000000000001',1),
  ('dddddddd-0000-4000-8000-000000000002','cccccccc-0000-4000-8000-000000000002',1),
  ('dddddddd-0000-4000-8000-000000000003','cccccccc-0000-4000-8000-000000000003',1),
  ('dddddddd-0000-4000-8000-000000000004','cccccccc-0000-4000-8000-000000000004',1),
  ('dddddddd-0000-4000-8000-000000000006','cccccccc-0000-4000-8000-000000000006',1),
  ('dddddddd-0000-4000-8000-000000000007','cccccccc-0000-4000-8000-000000000007',1);

INSERT INTO public.sub_segments (id, seg_id, sequence, title, content) VALUES
  ('eeeeeeee-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000001',1,'c','c'),
  ('eeeeeeee-0000-4000-8000-000000000002','dddddddd-0000-4000-8000-000000000002',1,'c','c'),
  ('eeeeeeee-0000-4000-8000-000000000003','dddddddd-0000-4000-8000-000000000003',1,'c','c'),
  ('eeeeeeee-0000-4000-8000-000000000004','dddddddd-0000-4000-8000-000000000004',1,'c','c'),
  ('eeeeeeee-0000-4000-8000-000000000006','dddddddd-0000-4000-8000-000000000006',1,'c','c'),
  ('eeeeeeee-0000-4000-8000-000000000007','dddddddd-0000-4000-8000-000000000007',1,'c','c');

-- review_state is set AFTER the insert on purpose: sub_segments_reset_review_trg fires on INSERT
-- and forces the whole segment back to 'draft', so a review_state supplied in the INSERT is
-- discarded. review_state is not in that trigger's column list, so this UPDATE is not reset.
UPDATE public.sub_segments SET review_state = 'clinically_approved'
 WHERE id::text LIKE 'eeeeeeee%' AND id <> 'eeeeeeee-0000-4000-8000-000000000002';

SELECT recompute_seg_status(id) FROM public.segments WHERE id::text LIKE 'dddddddd%';

INSERT INTO public.quiz_questions (question_id, segment_id, lesson_id, question_text, answer_status) VALUES
  ('ffffffff-0000-4000-8000-000000000003','dddddddd-0000-4000-8000-000000000003','cccccccc-0000-4000-8000-000000000003','q','pending'),
  ('ffffffff-0000-4000-8000-000000000006','dddddddd-0000-4000-8000-000000000006','cccccccc-0000-4000-8000-000000000006','q','approved'),
  ('ffffffff-0000-4000-8000-000000000007','dddddddd-0000-4000-8000-000000000007','cccccccc-0000-4000-8000-000000000007','q','pending');

SELECT left(l.lesson_name,16) AS lesson, l.is_published AS pub,
       coalesce(s.seg_status,'(none)') AS seg_status,
       (SELECT count(*) FROM quiz_questions q WHERE q.segment_id = s.id AND q.answer_status <> 'approved') AS pending_quiz,
       (t.archived_at IS NOT NULL) AS trk_arch
  FROM lessons l LEFT JOIN segments s ON s.lesson_id = l.id LEFT JOIN tracks t ON t.id = l.track_id
 WHERE l.id::text LIKE 'cccccccc%' ORDER BY l.lesson_name;
