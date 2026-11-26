-- Fixture for the 130/131 harness: STALE `complete` segments, built the way the live ones came
-- about. Applied AFTER 129 and BEFORE 130.
--
-- A stale row cannot be produced through any sanctioned path — recompute_seg_status always writes
-- the truth — so the fixture writes `seg_status` DIRECTLY, which is exactly what migration 131
-- then makes impossible. That is also why 131 must be applied after this fixture, and why the
-- fixture is the only place in this harness where seg_status is written by hand. On live Moosii
-- the equivalent write was migration 056's omission: it added review_state DEFAULT 'draft' and
-- never re-derived, leaving rows that were already `complete` saying so with all-draft cards.
--
-- THE SHAPE, mapped to the real rows (measured 2026-11-26):
--   L1  published + REACHABLE, 1 stale segment  → re-derived AND unpublished (the 4 real `mem` ones)
--   L2  published under an ARCHIVED track       → re-derived, NOT unpublished (the 3 real `legacy` ones)
--   L3  unpublished, stale                       → re-derived only
--   L4  published and GENUINELY complete         → must be left completely alone
--   S5  ORPHAN segment (lesson_id NULL), stale   → re-derived (the 12 real orphans)
--   S6  CARDLESS segment stored 'complete'       → re-derived (3 of the real ones are cardless)
-- L1 also carries an APPROVED quiz question, so `lessons.with_quiz` is true before the repair and
-- must re-derive itself to false after it (invariant 10 / migration 063).

-- ---------------------------------------------------------------- tracks
INSERT INTO public.tracks (id, track_name, created_by, archived_at) VALUES
  ('e1300000-0000-4000-8000-00000000000a', 'A3 open track',     'legacy', NULL),
  ('e1300000-0000-4000-8000-00000000000b', 'A3 archived track', 'legacy', NULL);   -- archived LATER

-- ---------------------------------------------------------------- lessons
INSERT INTO public.lessons (id, lesson_name, track_id, archived_at) VALUES
  ('e1301111-0000-4000-8000-000000000001', 'L1 published reachable', 'e1300000-0000-4000-8000-00000000000a', NULL),
  ('e1301111-0000-4000-8000-000000000002', 'L2 published archived',  'e1300000-0000-4000-8000-00000000000b', NULL),
  ('e1301111-0000-4000-8000-000000000003', 'L3 unpublished stale',   'e1300000-0000-4000-8000-00000000000a', NULL),
  ('e1301111-0000-4000-8000-000000000004', 'L4 genuinely complete',  'e1300000-0000-4000-8000-00000000000a', NULL);

-- ---------------------------------------------------------------- segments
INSERT INTO public.segments (id, lesson_id, segment_order) VALUES
  ('e1302222-0000-4000-8000-000000000001', 'e1301111-0000-4000-8000-000000000001', 1),
  ('e1302222-0000-4000-8000-000000000002', 'e1301111-0000-4000-8000-000000000002', 1),
  ('e1302222-0000-4000-8000-000000000003', 'e1301111-0000-4000-8000-000000000003', 1),
  ('e1302222-0000-4000-8000-000000000004', 'e1301111-0000-4000-8000-000000000004', 1),
  ('e1302222-0000-4000-8000-000000000006', 'e1301111-0000-4000-8000-000000000003', 2);   -- S6 cardless
-- S5: the orphan. lesson_id NULL is legal (12 such rows exist live).
INSERT INTO public.segments (id, lesson_id, segment_order) VALUES
  ('e1302222-0000-4000-8000-000000000005', NULL, 1);

-- ---------------------------------------------------------------- cards
-- INSERT first, then set review_state: 066's trigger drafts the WHOLE segment on a card INSERT
-- (invariant 2), so a card cannot be born approved. review_state is not in that trigger's column
-- list, so the UPDATE below does not re-fire it.
INSERT INTO public.sub_segments (id, seg_id, sequence, title, content) VALUES
  ('e1303333-0000-4000-8000-000000000011', 'e1302222-0000-4000-8000-000000000001', 1, 'L1 c1', 'body'),
  ('e1303333-0000-4000-8000-000000000012', 'e1302222-0000-4000-8000-000000000001', 2, 'L1 c2', 'body'),
  ('e1303333-0000-4000-8000-000000000021', 'e1302222-0000-4000-8000-000000000002', 1, 'L2 c1', 'body'),
  ('e1303333-0000-4000-8000-000000000031', 'e1302222-0000-4000-8000-000000000003', 1, 'L3 c1', 'body'),
  ('e1303333-0000-4000-8000-000000000041', 'e1302222-0000-4000-8000-000000000004', 1, 'L4 c1', 'body'),
  ('e1303333-0000-4000-8000-000000000042', 'e1302222-0000-4000-8000-000000000004', 2, 'L4 c2', 'body'),
  ('e1303333-0000-4000-8000-000000000051', 'e1302222-0000-4000-8000-000000000005', 1, 'orphan c1', 'body');

-- ONLY L4's cards are genuinely approved. Everything else stays `draft` — that is the defect.
UPDATE public.sub_segments SET review_state = 'clinically_approved'
 WHERE id IN ('e1303333-0000-4000-8000-000000000041',
              'e1303333-0000-4000-8000-000000000042');

-- ---------------------------------------------------------------- the quiz question on L1
-- answer_status 'approved' so lessons.with_quiz derives TRUE while S1 is `complete` (063). After
-- the repair S1 is pending, so with_quiz must re-derive to false on its own.
INSERT INTO public.quiz_questions (question_id, segment_id, lesson_id, question_text, answer_status) VALUES
  ('e1305555-0000-4000-8000-000000000001', 'e1302222-0000-4000-8000-000000000001',
   'e1301111-0000-4000-8000-000000000001', 'L1 q1', 'approved');

-- ---------------------------------------------------------------- THE STALE WRITE
-- Direct, by hand, as the table owner. Pre-131 this is permitted (and on financial it is
-- permitted for anon/authenticated/service_role too — FINDINGS §6.3). L4 is NOT written here: it
-- earns `complete` honestly through recompute_seg_status below.
UPDATE public.segments SET seg_status = 'complete'
 WHERE id IN ('e1302222-0000-4000-8000-000000000001',   -- L1, draft cards
              'e1302222-0000-4000-8000-000000000002',   -- L2, draft cards
              'e1302222-0000-4000-8000-000000000003',   -- L3, draft cards
              'e1302222-0000-4000-8000-000000000005',   -- the orphan, draft card
              'e1302222-0000-4000-8000-000000000006');  -- cardless

-- L4 through the sanctioned writer, so the fixture contains one row the repair must NOT touch.
SELECT public.recompute_seg_status('e1302222-0000-4000-8000-000000000004');

-- ---------------------------------------------------------------- publish
-- 126's lessons_publish_guard_trg checks lesson_publish_blocker on a publish: the lesson needs a
-- `complete` segment, no pending quiz question and no archival. All three hold NOW — which is
-- precisely the defect this harness exists for: a lesson with every card in draft is publishable
-- today, because the blocker reads seg_status and never looks at card state.
UPDATE public.lessons SET is_published = true
 WHERE id IN ('e1301111-0000-4000-8000-000000000001',
              'e1301111-0000-4000-8000-000000000002',
              'e1301111-0000-4000-8000-000000000004');

-- NOW archive L2's track, so it is published-but-unreachable, like the 3 legacy ones. Archiving
-- after publishing is required: the blocker refuses to publish a lesson under an archived track.
UPDATE public.tracks SET archived_at = now() - interval '2 days'
 WHERE id = 'e1300000-0000-4000-8000-00000000000b';

-- ---------------------------------------------------------------- what the harness should see
DO $$
DECLARE v_stale int; v_pub int; v_wq boolean;
BEGIN
  SELECT count(*) INTO v_stale FROM public.segments s
   WHERE s.seg_status = 'complete'
     AND (NOT EXISTS (SELECT 1 FROM public.sub_segments ss WHERE ss.seg_id = s.id)
          OR EXISTS (SELECT 1 FROM public.sub_segments ss
                      WHERE ss.seg_id = s.id AND ss.review_state IS DISTINCT FROM 'clinically_approved'));
  SELECT count(*) INTO v_pub FROM public.lessons WHERE coalesce(is_published, false);
  SELECT with_quiz INTO v_wq FROM public.lessons WHERE id = 'e1301111-0000-4000-8000-000000000001';
  RAISE NOTICE 'FIXTURE: % stale complete segment(s), % published lesson(s), L1.with_quiz = %',
    v_stale, v_pub, v_wq;
  IF v_stale <> 5 THEN RAISE EXCEPTION 'FIXTURE: expected 5 stale segments, got %', v_stale; END IF;
  IF NOT v_wq THEN RAISE EXCEPTION 'FIXTURE: L1.with_quiz should be true before the repair'; END IF;
END $$;
