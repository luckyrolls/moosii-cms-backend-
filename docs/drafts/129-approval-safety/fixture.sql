-- Fixture for the 129 harness. Applied AFTER 128 (tracks.test_group is NOT NULL with no default
-- from 128 onward — the insert trigger supplies it) and BEFORE 129, so the suite can watch the
-- gate appear.
--
-- Shape: one open track and one archived track; under the open one a plain lesson, a PUBLISHED
-- lesson and an ARCHIVED lesson. Cards cover every combination the gate cares about:
--   approved image only · approved image + a newer candidate · candidate only · no images at all
-- Fixed UUIDs so the suite can assert exact sets.

-- ---------------------------------------------------------------- tracks
INSERT INTO public.tracks (id, track_name, created_by, archived_at) VALUES
  ('e1290000-0000-4000-8000-00000000000a', 'A1 open track',     'legacy', NULL),
  ('e1290000-0000-4000-8000-00000000000b', 'A1 archived track', 'legacy', now() - interval '5 days');

-- ---------------------------------------------------------------- lessons
-- L1 open, L2 PUBLISHED, L3 archived lesson (open track), L4 under the archived track.
-- is_published is set LAST, by a direct UPDATE that 126's guard must allow: the segment has to
-- exist and be complete first, or lessons_publish_guard refuses it (HINT publish_not_approved).
INSERT INTO public.lessons (id, lesson_name, track_id, archived_at) VALUES
  ('e1291111-0000-4000-8000-000000000001', 'L1 open',           'e1290000-0000-4000-8000-00000000000a', NULL),
  ('e1291111-0000-4000-8000-000000000002', 'L2 published',      'e1290000-0000-4000-8000-00000000000a', NULL),
  ('e1291111-0000-4000-8000-000000000003', 'L3 archived',       'e1290000-0000-4000-8000-00000000000a', now() - interval '3 days'),
  ('e1291111-0000-4000-8000-000000000004', 'L4 archived track', 'e1290000-0000-4000-8000-00000000000b', NULL);

-- ---------------------------------------------------------------- segments
INSERT INTO public.segments (id, lesson_id, segment_order) VALUES
  ('e1292222-0000-4000-8000-000000000001', 'e1291111-0000-4000-8000-000000000001', 1),  -- S1 the workhorse
  ('e1292222-0000-4000-8000-000000000002', 'e1291111-0000-4000-8000-000000000002', 1),  -- S2 under the published lesson
  ('e1292222-0000-4000-8000-000000000003', 'e1291111-0000-4000-8000-000000000003', 1),  -- S3 archived lesson
  ('e1292222-0000-4000-8000-000000000004', 'e1291111-0000-4000-8000-000000000004', 1),  -- S4 archived track
  ('e1292222-0000-4000-8000-000000000005', 'e1291111-0000-4000-8000-000000000001', 2);  -- S5 CARDLESS

-- ---------------------------------------------------------------- cards
-- ⚠ INSERT THEN SET THE STATE, in that order. `sub_segments_reset_review_trg` (066) fires AFTER
-- INSERT and resets the WHOLE segment to 'draft' — a card INSERT is a structural change, because
-- card roles are position-derived (invariant 2). So inserting a row with
-- review_state='clinically_approved' leaves it 'draft'. `review_state` is NOT in that trigger's
-- column list (066/092: title, content, sequence), so the UPDATE below does not re-fire it.
INSERT INTO public.sub_segments (id, seg_id, sequence, title, content) VALUES
  ('e1293333-0000-4000-8000-000000000001', 'e1292222-0000-4000-8000-000000000001', 1, 'C1', 'c1 body'),
  ('e1293333-0000-4000-8000-000000000002', 'e1292222-0000-4000-8000-000000000001', 2, 'C2', 'c2 body'),
  ('e1293333-0000-4000-8000-000000000003', 'e1292222-0000-4000-8000-000000000001', 3, 'C3', 'c3 body'),
  ('e1293333-0000-4000-8000-000000000004', 'e1292222-0000-4000-8000-000000000002', 1, 'C4', 'c4 body'),
  ('e1293333-0000-4000-8000-000000000005', 'e1292222-0000-4000-8000-000000000002', 2, 'C5', 'c5 body'),
  ('e1293333-0000-4000-8000-000000000006', 'e1292222-0000-4000-8000-000000000003', 1, 'C6', 'c6 body'),
  ('e1293333-0000-4000-8000-000000000007', 'e1292222-0000-4000-8000-000000000004', 1, 'C7', 'c7 body');

-- S1's three cards and S2's two are clinically approved; S3/S4 stay draft (excluded lessons).
UPDATE public.sub_segments SET review_state = 'clinically_approved'
 WHERE id IN ('e1293333-0000-4000-8000-000000000001',
              'e1293333-0000-4000-8000-000000000002',
              'e1293333-0000-4000-8000-000000000003',
              'e1293333-0000-4000-8000-000000000004',
              'e1293333-0000-4000-8000-000000000005');

-- ---------------------------------------------------------------- images
-- storage_path is NOT NULL with no default. `source` defaults to 'generated', which then needs
-- final_prompt / image_prompt / image_generator_name (content_images_generated_has_provenance) —
-- so these are 'uploaded', the shape POST /sub-segments/:id/upload-image writes. Exactly ONE
-- owner column may be set (content_images_one_owner), and at most one 'approved' per sub_segment
-- (content_images_one_approved_per_sub_segment).
--   C1  approved image only
--   C2  approved image + a NEWER candidate   <- must NOT block the gate
--   C3  one REJECTED image, nothing live     <- must NOT block either (only 'candidate' counts)
--   C4, C5 approved image only (under the PUBLISHED lesson)
INSERT INTO public.content_images (id, sub_segment_id, storage_path, status, source, created_at) VALUES
  ('e1294444-0000-4000-8000-000000000001', 'e1293333-0000-4000-8000-000000000001', 'p/c1-approved.png', 'approved',  'uploaded', now() - interval '2 days'),
  ('e1294444-0000-4000-8000-000000000002', 'e1293333-0000-4000-8000-000000000002', 'p/c2-approved.png', 'approved',  'uploaded', now() - interval '2 days'),
  ('e1294444-0000-4000-8000-000000000003', 'e1293333-0000-4000-8000-000000000002', 'p/c2-cand.png',     'candidate', 'uploaded', now() - interval '1 hour'),
  ('e1294444-0000-4000-8000-000000000004', 'e1293333-0000-4000-8000-000000000004', 'p/c4-approved.png', 'approved',  'uploaded', now() - interval '2 days'),
  ('e1294444-0000-4000-8000-000000000005', 'e1293333-0000-4000-8000-000000000005', 'p/c5-approved.png', 'approved',  'uploaded', now() - interval '2 days'),
  ('e1294444-0000-4000-8000-000000000006', 'e1293333-0000-4000-8000-000000000003', 'p/c3-rejected.png','rejected',  'uploaded', now() - interval '1 day');

-- a LESSON-level image (the polymorphic case 129's trigger must ignore). lesson_id goes in the
-- INSERT, not an UPDATE afterwards: content_images_one_owner requires exactly one owner column at
-- all times, so a row with none would never land.
INSERT INTO public.content_images (id, lesson_id, storage_path, status, source, created_at) VALUES
  ('e1294444-0000-4000-8000-000000000007', 'e1291111-0000-4000-8000-000000000001', 'p/l1-cover.png', 'candidate', 'uploaded', now() - interval '1 day');

-- ---------------------------------------------------------------- derive, then publish L2
-- seg_status is DERIVED: never written directly (057 revokes the column). Go through the single
-- writer, like every other caller.
SELECT public.recompute_seg_status(id) FROM public.segments
 WHERE id::text LIKE 'e1292222%';

-- L2 can only be published once its segment is 'complete' (126's lessons_publish_guard). This
-- runs with no JWT, so the guard's super_admin check is skipped and only the structural
-- precondition applies — which is exactly what we want to exercise.
UPDATE public.lessons SET is_published = true WHERE id = 'e1291111-0000-4000-8000-000000000002';

DO $$
DECLARE v_s1 text; v_s2 text; v_s5 text; v_pub boolean; v_cards int;
BEGIN
  SELECT count(*) INTO v_cards FROM public.sub_segments
   WHERE seg_id = 'e1292222-0000-4000-8000-000000000001' AND review_state = 'clinically_approved';
  IF v_cards <> 3 THEN RAISE EXCEPTION 'fixture: S1 should have 3 approved cards, got %', v_cards; END IF;

  SELECT seg_status INTO v_s1 FROM public.segments WHERE id = 'e1292222-0000-4000-8000-000000000001';
  SELECT seg_status INTO v_s2 FROM public.segments WHERE id = 'e1292222-0000-4000-8000-000000000002';
  SELECT seg_status INTO v_s5 FROM public.segments WHERE id = 'e1292222-0000-4000-8000-000000000005';
  SELECT is_published INTO v_pub FROM public.lessons WHERE id = 'e1291111-0000-4000-8000-000000000002';
  -- Pre-129 these are the 056 verdicts: C2's candidate beside an approved image is invisible to
  -- the old rule, and so is C3 having no live image at all.
  IF v_s1 <> 'complete' THEN RAISE EXCEPTION 'fixture: S1 should start complete, got %', v_s1; END IF;
  IF v_s2 <> 'complete' THEN RAISE EXCEPTION 'fixture: S2 should start complete, got %', v_s2; END IF;
  IF v_s5 <> 'pending'  THEN RAISE EXCEPTION 'fixture: S5 is cardless, should be pending, got %', v_s5; END IF;
  IF NOT v_pub          THEN RAISE EXCEPTION 'fixture: L2 should be published'; END IF;
  RAISE NOTICE 'FIXTURE OK: S1/S2 complete, S5 pending (cardless), L2 published';
END $$;
