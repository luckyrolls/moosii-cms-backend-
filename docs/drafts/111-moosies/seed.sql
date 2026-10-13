-- Local-only fixtures for verify.sql on an EMPTY schema-only restore (live projects already have rows).
INSERT INTO auth.users (id) VALUES ('00000000-0000-4000-8000-0000000000a1');
INSERT INTO public."user" (id, daily_reminder_time, moosies) VALUES ('00000000-0000-4000-8000-0000000000a1', '09:00', 40);
INSERT INTO public.user_configurations (user_id, daily_limit, mlp_limit, moosi_to_add, monthly_fee, yearly_fee, free_trial_days)
VALUES ('00000000-0000-4000-8000-0000000000a1', 3, 10, 10, 0, 0, 0);
INSERT INTO public.tracks (id, track_name) VALUES ('00000000-0000-4000-8000-0000000000b1', 'local track');
INSERT INTO public.lessons (id, lesson_name, track_id, points) VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'L1', '00000000-0000-4000-8000-0000000000b1', 5),
  ('00000000-0000-4000-8000-0000000000c2', 'L2', '00000000-0000-4000-8000-0000000000b1', 6),
  ('00000000-0000-4000-8000-0000000000c3', 'L3', '00000000-0000-4000-8000-0000000000b1', NULL),
  ('00000000-0000-4000-8000-0000000000c4', 'A1', '00000000-0000-4000-8000-0000000000b1', 5);
UPDATE public.lessons SET kind = 'activity' WHERE id = '00000000-0000-4000-8000-0000000000c4';
