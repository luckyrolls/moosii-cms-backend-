-- ============================================================================
-- MIGRATION 130: the stale-`complete` REPAIR — re-derive seg_status, unpublish the 4 reachable
--                lessons that lose their only complete segment.
--
-- *** BOTH PROJECTS. On financial it is a measured NO-OP (0 rows change). ***
-- *** REVIEW REQUIRED: it changes what a parent can open. Do not apply without Mark's explicit
--     go per project. ***
-- ============================================================================
-- WHY. Migration 056 added `sub_segments.review_state DEFAULT 'draft'` and ran NO re-derive loop,
-- so every segment already stored `complete` kept that value with all-draft cards. 25 Moosii
-- segments have lied ever since; financial is clean because its content all postdates 056. Full
-- investigation, cause proven by an exact timestamp boundary: docs/FINDINGS-complete-with-draft-cards.md.
--
-- The readers all gate on `seg_status = 'complete'` alone and never look at card state — the app
-- (moosii-rn `useLesson.ts`), the three RLS SELECT policies (103), `lessons_review_status` (065)
-- and `lesson_publish_blocker` (126). So a stale row is not cosmetic: it serves unreviewed content
-- to a parent and reports itself as `published_reviewed`.
--
-- DECISIONS (Mark, 2026-11-25; D1–D9 in the findings §7):
--   D1 RE-DERIVE ONLY — `recompute_seg_status` is the sanctioned single writer and its output is
--      the truth. Unpublishing is a separate editorial act, which is D2.
--   D2 UNPUBLISH THE 4 REACHABLE `mem` LESSONS here. Each loses its ONLY complete segment, so the
--      app would throw on open; an absent lesson beats an erroring one, and 126's blocker will
--      refuse to re-publish them until they are actually reviewed. The 3 `legacy` published ones
--      are left alone — their tracks are archived, so no parent can reach them.
--   D3 ONE scope:all MLP rebuild AFTER the apply (a seat step, not SQL — see the footer).
--   D4 THE 12 ORPHANS (`lesson_id IS NULL`, 67 cards) are re-derived too. Deleting orphan content
--      is its own decision and is backlogged.
--   D6 TWO MIGRATIONS: this repair, then 131's guard. Each needs a clean undo, and the guard
--      would REFUSE this file's undo.
--   D8 The 9 unapproved quiz questions riding on 8 of these segments are FLAGGED, not touched:
--      126's blocker catches them on any re-publish (`publish_quiz_pending`) and invariant 10
--      keeps the app from showing them.
--
-- MEASURED READ-ONLY, 2026-11-26 (the exact rows are RAISEd by this file at apply time):
--   Moosii     170 segments → 25 change, ALL `complete` → `pending`, 0 the other way;
--              13 lesson-attached + 12 orphans; 17 carry a stale `approved_by`.
--              13 distinct lessons, each with exactly ONE segment, so complete_after = 0 for all.
--              7 are published: 4 reachable `mem` (unpublished here) + 3 `legacy` (left).
--   financial  13 segments → 0 change. Nothing to repair, nothing to unpublish.
--
-- KNOCK-ON EFFECTS, all intended:
--   * `lessons_review_status.content_state` flips to `published_unreviewed` for the 3 legacy
--     lessons (the 4 mem ones become `draft`, being unpublished).
--   * `lessons.with_quiz` is DERIVED from the first `complete` segment (invariant 10, 063) and
--     re-derives itself through 063's trigger on `segments`. 7 lessons carry `with_quiz = true`
--     today and own a re-derived segment; expect all 7 to go false. VERIFIED below, not assumed.
--   * `mlp_item_pool` filters on `is_published`, so the 4 unpublishes DO change the pool — hence
--     D3's rebuild. Re-deriving alone would not have.
--   * NO content_approvals row is written for a re-derive: resets are unaudited today
--     (docs/FINDINGS-reset-audit.md). The snapshot table below is the traceability.
--
-- ⚠ ONE SCHEMA WIDENING, AND IT IS A JUDGEMENT CALL (review this specifically).
--   `content_approvals_actor_required` today is
--       actor_id IS NOT NULL OR action IN ('archive','unarchive')
--   so an `unpublish` row MUST name an actor. A migration has no human actor, and
--   `set_lesson_published` additionally REQUIRES `p_actor_id` and a `can_publish` capability
--   check — so the sanctioned RPC cannot be used from a migration without impersonating a person,
--   which would put a false name in an audit table (invariant 7 exists to prevent exactly that).
--   The three options were: (a) impersonate a super_admin — rejected, it falsifies the audit;
--   (b) write no audit row — rejected, the brief and D2 require one; (c) allow a NULL actor when
--   `actor_role = 'migration'`. This file takes (c), narrowly. A human action still always names
--   its human; only a migration may be anonymous, exactly as 'archive'/'unarchive' already are.
--   The undo restores the original CHECK.
--
-- UNDO (one transaction, and 131's guard must be DROPPED FIRST if it is installed — see 131):
--   1. DROP TRIGGER IF EXISTS segments_status_derived_guard_trg ON public.segments;   -- if 131 is live
--   2. UPDATE public.segments s
--         SET seg_status = k.seg_status_before, approved_by = k.approved_by_before, updated_at = now()
--        FROM public.repair_130_snapshot k
--       WHERE k.kind = 'segment' AND k.entity_id = s.id
--         AND (s.seg_status, s.approved_by) IS DISTINCT FROM (k.seg_status_before, k.approved_by_before);
--      (Moosii: `seg_status` is REVOKEd from every role by 057, so the undo must run as the table
--       owner — i.e. an apply via psql as `postgres`, which is how this repo applies migrations.)
--   3. UPDATE public.lessons l
--         SET is_published = k.is_published_before, published_by = k.published_by_before, updated_at = now()
--        FROM public.repair_130_snapshot k
--       WHERE k.kind = 'lesson' AND k.entity_id = l.id AND k.is_published_before IS DISTINCT FROM l.is_published;
--      This fires 126's `lessons_publish_guard_trg`: `auth.uid()` is NULL under psql so the
--      capability check is skipped, but the CONTENT precondition is NOT — re-publishing a lesson
--      whose cards are still draft RAISES `publish_not_approved`. That is correct and means the
--      undo cannot resurrect a lesson without also undoing step 2 first. Order matters: 2 then 3.
--   4. Restore the audit CHECK and delete this file's own audit rows (they are history of an
--      action being undone; keep them if the undo is itself to be auditable — state which):
--        ALTER TABLE public.content_approvals DROP CONSTRAINT content_approvals_actor_required;
--        ALTER TABLE public.content_approvals ADD  CONSTRAINT content_approvals_actor_required
--          CHECK (actor_id IS NOT NULL OR action = ANY (ARRAY['archive','unarchive']));
--        -- requires deleting the actor-less 'unpublish' rows first, or the ADD fails:
--        DELETE FROM public.content_approvals WHERE actor_role = 'migration' AND actor_id IS NULL;
--   5. DROP TABLE public.repair_130_snapshot;
--   6. Re-create 131's guard if it was dropped in step 1, then ONE scope:all MLP rebuild.
--   Rehearsed in docs/drafts/130-stale-complete/undo.sql.
--
-- RE-RUNNABLE: the snapshot is taken only when the table is empty, the re-derive is idempotent by
-- construction (it writes the derived value), and the unpublish touches only rows still published.
-- A second apply changes nothing and still VERIFIEs.
-- ============================================================================

BEGIN;

-- ============================================================================ PRE-CHECK
DO $$
DECLARE
  v_domain  text;
  v_md5     text;
  v_total   int;
  v_change  int;
  v_up      int;
  v_down    int;
  v_pub     int;
  v_row     record;
BEGIN
  SELECT value INTO v_domain FROM public.app_settings WHERE key = 'domain';
  IF v_domain IS NULL OR v_domain NOT IN ('moosii','financial') THEN
    RAISE EXCEPTION '130 PRE-CHECK: app_settings.domain is %, expected moosii or financial',
      coalesce(v_domain, '(null)');
  END IF;

  -- 129 MUST be live: its gate is part of the derivation this file re-derives TO. Applying 130
  -- against the pre-129 body would leave the 7 image-blocked segments stale again, and the
  -- numbers in the header would not describe what happened. EXACT md5, never a substring (the
  -- 118/120 lesson).
  SELECT md5(replace(pg_get_functiondef('public.recompute_seg_status(uuid)'::regprocedure), chr(13), ''))
    INTO v_md5;
  IF v_md5 <> '017a190fd685972a20924e1a98e16170' THEN
    RAISE EXCEPTION '130 PRE-CHECK: recompute_seg_status is not the 129 body (md5 %). Apply 129 first, or re-base this file.', v_md5;
  END IF;

  -- 131's guard must NOT be installed yet: it would refuse nothing this file does (every write
  -- goes through recompute_seg_status), but the ORDER is a decision (D6) and a surprise here
  -- means the two files were applied out of order.
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname = 'segments_status_derived_guard_trg'
                AND tgrelid = 'public.segments'::regclass) THEN
    RAISE EXCEPTION '130 PRE-CHECK: 131''s guard is already installed — apply the repair BEFORE the guard (D6)';
  END IF;

  SELECT count(*) INTO v_total FROM public.segments;

  -- What is about to change, computed through the SANCTIONED function rather than a hand-written
  -- copy of its logic: recompute_seg_status is called for real below, and this is only a forecast
  -- for the NOTICE. It mirrors the 129 body quoted in the file above.
  WITH d AS (
    SELECT s.id, s.lesson_id, s.seg_status,
           CASE
             WHEN NOT EXISTS (SELECT 1 FROM public.sub_segments ss WHERE ss.seg_id = s.id) THEN 'pending'
             WHEN EXISTS (SELECT 1 FROM public.sub_segments ss
                           WHERE ss.seg_id = s.id AND ss.review_state IS DISTINCT FROM 'clinically_approved') THEN 'pending'
             WHEN EXISTS (SELECT 1 FROM public.sub_segments ss
                           WHERE ss.seg_id = s.id
                             AND NOT EXISTS (SELECT 1 FROM public.content_images ci
                                              WHERE ci.sub_segment_id = ss.id AND ci.status = 'approved')
                             AND EXISTS (SELECT 1 FROM public.content_images ci
                                          WHERE ci.sub_segment_id = ss.id AND ci.status = 'candidate')) THEN 'pending'
             ELSE 'complete' END AS derived
      FROM public.segments s)
  SELECT count(*) FILTER (WHERE seg_status IS DISTINCT FROM derived),
         count(*) FILTER (WHERE seg_status = 'complete' AND derived = 'pending'),
         count(*) FILTER (WHERE seg_status = 'pending'  AND derived = 'complete')
    INTO v_change, v_down, v_up
    FROM d;

  RAISE NOTICE '130 PRE-CHECK: domain=% system=% — % segment(s), % will change (% complete->pending, % pending->complete)',
    v_domain, (pg_control_system()).system_identifier, v_total, v_change, v_down, v_up;

  -- A pending->complete move would mean this file is APPROVING content, which it must never do.
  IF v_up <> 0 THEN
    RAISE EXCEPTION '130 PRE-CHECK: % segment(s) would move pending->complete. This file only ever withdraws a false approval; investigate before applying.', v_up;
  END IF;

  IF v_domain = 'financial' AND v_change <> 0 THEN
    RAISE EXCEPTION '130 PRE-CHECK: financial measured 0 stale segments but % would change — re-measure before applying', v_change;
  END IF;

  -- Blast-radius stop. The measurement said 25 on Moosii; a card approved between the
  -- measurement and the apply can move that by one or two (128 hit exactly that, 37 -> 38), so
  -- the ceiling is loose. An order-of-magnitude surprise aborts instead of rewriting the catalog.
  IF v_change > 40 THEN
    RAISE EXCEPTION '130 PRE-CHECK: % segment(s) would change, far more than the measured 25. Re-measure and re-base before applying.', v_change;
  END IF;

  -- Name every published lesson that is about to lose its last complete segment, so the apply log
  -- shows what a parent will no longer be able to open.
  FOR v_row IN
    WITH d AS (
      SELECT s.id, s.lesson_id, s.seg_status,
             CASE
               WHEN NOT EXISTS (SELECT 1 FROM public.sub_segments ss WHERE ss.seg_id = s.id) THEN 'pending'
               WHEN EXISTS (SELECT 1 FROM public.sub_segments ss
                             WHERE ss.seg_id = s.id AND ss.review_state IS DISTINCT FROM 'clinically_approved') THEN 'pending'
               WHEN EXISTS (SELECT 1 FROM public.sub_segments ss
                             WHERE ss.seg_id = s.id
                               AND NOT EXISTS (SELECT 1 FROM public.content_images ci
                                                WHERE ci.sub_segment_id = ss.id AND ci.status = 'approved')
                               AND EXISTS (SELECT 1 FROM public.content_images ci
                                            WHERE ci.sub_segment_id = ss.id AND ci.status = 'candidate')) THEN 'pending'
               ELSE 'complete' END AS derived
        FROM public.segments s)
    SELECT l.id, l.lesson_name, t.test_group,
           (t.archived_at IS NULL AND l.archived_at IS NULL) AS reachable,
           count(*) FILTER (WHERE d.derived = 'complete') AS complete_after
      FROM d JOIN public.lessons l ON l.id = d.lesson_id
             LEFT JOIN public.tracks t ON t.id = l.track_id
     WHERE coalesce(l.is_published, false)
     GROUP BY 1,2,3,4
    HAVING count(*) FILTER (WHERE d.seg_status IS DISTINCT FROM d.derived) > 0
     ORDER BY 4 DESC, 3, 2
  LOOP
    RAISE NOTICE '130 PRE-CHECK: published %, group %, reachable=%, complete segments after repair=% — %',
      v_row.id, coalesce(v_row.test_group,'(none)'), v_row.reachable, v_row.complete_after, v_row.lesson_name;
  END LOOP;

  SELECT count(*) INTO v_pub FROM public.lessons WHERE coalesce(is_published, false);
  RAISE NOTICE '130 PRE-CHECK: % published lesson(s) before this file', v_pub;
END $$;

-- ============================================================================ (a) THE SNAPSHOT
-- Taken BEFORE anything changes, and typed rather than jsonb so the undo is a plain UPDATE …
-- FROM. It covers EVERY segment, not only the ones expected to move: an exact undo must not
-- depend on the forecast having been right.
CREATE TABLE IF NOT EXISTS public.repair_130_snapshot (
  kind                text        NOT NULL CHECK (kind IN ('segment','lesson')),
  entity_id           uuid        NOT NULL,
  seg_status_before   text        NULL,
  approved_by_before  text        NULL,
  is_published_before boolean     NULL,
  published_by_before text        NULL,
  taken_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, entity_id)
);

COMMENT ON TABLE public.repair_130_snapshot IS
  'Migration 130: the pre-repair state of every segment (seg_status, approved_by) and of every '
  'lesson this file unpublished (is_published, published_by). The ONLY thing the undo needs. '
  'Backend-only: RLS on, no policy. Keep it — dropping it makes 130 irreversible.';

-- Invariant 3 / the RLS posture: every new public table enables RLS in the migration that creates
-- it. No policy at all: this is backend-only, and the service role bypasses RLS anyway.
ALTER TABLE public.repair_130_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.repair_130_snapshot FROM PUBLIC, anon, authenticated;
GRANT ALL  ON TABLE public.repair_130_snapshot TO service_role;

DO $$
DECLARE v_n int;
BEGIN
  IF EXISTS (SELECT 1 FROM public.repair_130_snapshot) THEN
    RAISE NOTICE '130 SNAPSHOT: already taken (% row(s)) — left untouched, this is a re-run',
      (SELECT count(*) FROM public.repair_130_snapshot);
  ELSE
    INSERT INTO public.repair_130_snapshot (kind, entity_id, seg_status_before, approved_by_before)
    SELECT 'segment', s.id, s.seg_status, s.approved_by FROM public.segments s;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '130 SNAPSHOT: % segment(s) recorded', v_n;
  END IF;
END $$;

-- ============================================================================ (b) THE RE-DERIVE
-- Through recompute_seg_status, the SINGLE sanctioned writer (056 + 129). No UPDATE of seg_status
-- appears anywhere in this file, which is also why 131's guard will accept every write it makes.
-- Called for EVERY segment: it is idempotent, and calling it only on the forecast set would make
-- the forecast load-bearing.
DO $$
DECLARE
  v_n     int := 0;
  v_moved int;
  v_row   record;
BEGIN
  FOR v_row IN SELECT id FROM public.segments ORDER BY id LOOP
    PERFORM public.recompute_seg_status(v_row.id);
    v_n := v_n + 1;
  END LOOP;

  SELECT count(*) INTO v_moved
    FROM public.segments s JOIN public.repair_130_snapshot k
      ON k.kind = 'segment' AND k.entity_id = s.id
   WHERE s.seg_status IS DISTINCT FROM k.seg_status_before;

  RAISE NOTICE '130 RE-DERIVE: % segment(s) recomputed, % changed', v_n, v_moved;

  FOR v_row IN
    SELECT s.id, s.seg_status, k.seg_status_before, coalesce(l.lesson_name, '(ORPHAN)') AS nm
      FROM public.segments s
      JOIN public.repair_130_snapshot k ON k.kind = 'segment' AND k.entity_id = s.id
      LEFT JOIN public.lessons l ON l.id = s.lesson_id
     WHERE s.seg_status IS DISTINCT FROM k.seg_status_before
     ORDER BY nm, s.id
  LOOP
    RAISE NOTICE '130 RE-DERIVE: % % -> % — %',
      v_row.id, v_row.seg_status_before, v_row.seg_status, v_row.nm;
  END LOOP;
END $$;

-- ============================================================================ (c) THE AUDIT CHECK
-- See the ⚠ in the header. Widened ONLY for actor_role = 'migration'; a human action still always
-- names its human (invariant 7).
ALTER TABLE public.content_approvals DROP CONSTRAINT IF EXISTS content_approvals_actor_required;
ALTER TABLE public.content_approvals ADD  CONSTRAINT content_approvals_actor_required
  CHECK (
    actor_id IS NOT NULL
    OR action = ANY (ARRAY['archive','unarchive'])
    OR actor_role = 'migration'
  );

COMMENT ON CONSTRAINT content_approvals_actor_required ON public.content_approvals IS
  'An action names its actor, EXCEPT: archive/unarchive (126, which may fire from a trigger with '
  'no auth.uid()) and actor_role = ''migration'' (130, so a migration can audit itself without '
  'impersonating a person). Invariant 7 otherwise stands: the actor is the verified JWT''s user.';

-- ============================================================================ (d) THE UNPUBLISH
-- D2: only lessons that (i) are published, (ii) have NO complete segment left after the re-derive,
-- and (iii) are REACHABLE — their own archived_at and their track's are both NULL. That last
-- condition is what leaves the 3 legacy ones alone: nothing can open them anyway, and unpublishing
-- them would be an editorial decision nobody asked for.
--
-- A direct UPDATE, not set_lesson_published: that RPC requires a human actor and a can_publish
-- capability (126). 126's lessons_publish_guard_trg still runs and is satisfied — auth.uid() is
-- NULL here so the capability branch is skipped, and the content precondition applies to publish
-- only, never to an unpublish.
DO $$
DECLARE
  v_row record;
  v_n   int := 0;
BEGIN
  FOR v_row IN
    SELECT l.id, l.lesson_name, l.is_published, l.published_by, t.test_group
      FROM public.lessons l
      LEFT JOIN public.tracks t ON t.id = l.track_id
     WHERE coalesce(l.is_published, false)
       AND l.archived_at IS NULL
       AND (t.id IS NULL OR t.archived_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.segments s
                        WHERE s.lesson_id = l.id AND s.seg_status = 'complete')
     ORDER BY l.lesson_name
  LOOP
    INSERT INTO public.repair_130_snapshot (kind, entity_id, is_published_before, published_by_before)
    VALUES ('lesson', v_row.id, v_row.is_published, v_row.published_by)
    ON CONFLICT (kind, entity_id) DO NOTHING;

    UPDATE public.lessons
       SET is_published = false, published_by = NULL, updated_at = now()
     WHERE id = v_row.id;

    -- The audit row this file is allowed to write anonymously (see (c)). actor_id NULL is the
    -- honest value: no person did this.
    INSERT INTO public.content_approvals (entity_type, entity_id, action, actor_id, actor_role, reason)
    VALUES ('lesson', v_row.id, 'unpublish', NULL, 'migration',
            'migration 130: every segment re-derived to pending (migration 056 never re-derived; '
            'all cards still awaiting editorial), so the lesson had no reviewed content to serve');

    v_n := v_n + 1;
    RAISE NOTICE '130 UNPUBLISH: % (group %) — %', v_row.id, coalesce(v_row.test_group,'(none)'), v_row.lesson_name;
  END LOOP;

  RAISE NOTICE '130 UNPUBLISH: % lesson(s) unpublished', v_n;
END $$;

-- ============================================================================ VERIFICATION
DO $$
DECLARE
  v_domain  text;
  v_n       int;
  v_snap    int;
  v_segs    int;
  v_unpub   int;
  v_wq      int;
BEGIN
  SELECT value INTO v_domain FROM public.app_settings WHERE key = 'domain';

  -- 1. the snapshot covers every segment (an exact undo depends on it)
  SELECT count(*) INTO v_snap FROM public.repair_130_snapshot WHERE kind = 'segment';
  SELECT count(*) INTO v_segs FROM public.segments;
  IF v_snap <> v_segs THEN
    RAISE EXCEPTION '130 VERIFY: snapshot has % segment row(s) but the table has % — the undo would be incomplete', v_snap, v_segs;
  END IF;

  -- 2. NOTHING disagrees with the derivation any more. This is the whole point of the file.
  WITH d AS (
    SELECT s.id, s.seg_status,
           CASE
             WHEN NOT EXISTS (SELECT 1 FROM public.sub_segments ss WHERE ss.seg_id = s.id) THEN 'pending'
             WHEN EXISTS (SELECT 1 FROM public.sub_segments ss
                           WHERE ss.seg_id = s.id AND ss.review_state IS DISTINCT FROM 'clinically_approved') THEN 'pending'
             WHEN EXISTS (SELECT 1 FROM public.sub_segments ss
                           WHERE ss.seg_id = s.id
                             AND NOT EXISTS (SELECT 1 FROM public.content_images ci
                                              WHERE ci.sub_segment_id = ss.id AND ci.status = 'approved')
                             AND EXISTS (SELECT 1 FROM public.content_images ci
                                          WHERE ci.sub_segment_id = ss.id AND ci.status = 'candidate')) THEN 'pending'
             ELSE 'complete' END AS derived
      FROM public.segments s)
  SELECT count(*) INTO v_n FROM d WHERE seg_status IS DISTINCT FROM derived;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '130 VERIFY: % segment(s) still disagree with the derived value', v_n;
  END IF;

  -- 3. every change was a WITHDRAWAL of a false approval, never a grant
  SELECT count(*) INTO v_n
    FROM public.segments s JOIN public.repair_130_snapshot k
      ON k.kind = 'segment' AND k.entity_id = s.id
   WHERE s.seg_status IS DISTINCT FROM k.seg_status_before
     AND NOT (k.seg_status_before = 'complete' AND s.seg_status = 'pending');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '130 VERIFY: % segment(s) moved in a direction this file must never take', v_n;
  END IF;

  -- 4. the unpublishes: exactly the lessons with no complete segment and reachable, each audited
  SELECT count(*) INTO v_unpub FROM public.repair_130_snapshot WHERE kind = 'lesson';
  SELECT count(*) INTO v_n FROM public.content_approvals
   WHERE action = 'unpublish' AND actor_role = 'migration' AND actor_id IS NULL;
  IF v_n < v_unpub THEN
    RAISE EXCEPTION '130 VERIFY: % lesson(s) unpublished but only % migration audit row(s)', v_unpub, v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.repair_130_snapshot k
    JOIN public.lessons l ON l.id = k.entity_id
   WHERE k.kind = 'lesson' AND coalesce(l.is_published, false);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '130 VERIFY: % lesson(s) in the unpublish set are still published', v_n;
  END IF;

  -- 5. NO OTHER lesson's is_published changed. The snapshot only holds the ones this file touched,
  --    so the test is: every published lesson that is NOT in the snapshot must still have a
  --    complete segment (i.e. this file did not leave a published lesson serving nothing).
  SELECT count(*) INTO v_n
    FROM public.lessons l
   WHERE coalesce(l.is_published, false)
     AND NOT EXISTS (SELECT 1 FROM public.segments s WHERE s.lesson_id = l.id AND s.seg_status = 'complete')
     AND (l.archived_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.tracks t WHERE t.id = l.track_id AND t.archived_at IS NOT NULL);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '130 VERIFY: % REACHABLE published lesson(s) have no complete segment and were not unpublished', v_n;
  END IF;

  -- 6. with_quiz re-derived itself (invariant 10: it is DERIVED and read-only; 063's triggers fire
  --    on segments). Verified, not assumed — the header says to expect it to go false.
  SELECT count(*) INTO v_wq
    FROM public.lessons l
   WHERE l.with_quiz
     AND NOT EXISTS (SELECT 1 FROM public.segments s WHERE s.lesson_id = l.id AND s.seg_status = 'complete');
  IF v_wq <> 0 THEN
    RAISE EXCEPTION '130 VERIFY: % lesson(s) still report with_quiz with no complete segment — 063''s trigger did not fire', v_wq;
  END IF;

  -- 7. financial is a no-op
  IF v_domain = 'financial' THEN
    SELECT count(*) INTO v_n
      FROM public.segments s JOIN public.repair_130_snapshot k
        ON k.kind = 'segment' AND k.entity_id = s.id
     WHERE s.seg_status IS DISTINCT FROM k.seg_status_before;
    IF v_n <> 0 OR v_unpub <> 0 THEN
      RAISE EXCEPTION '130 VERIFY: financial should be a no-op but % segment(s) and % lesson(s) changed', v_n, v_unpub;
    END IF;
  END IF;

  RAISE NOTICE '130 VERIFY ok: domain=% — 0 segments disagree with the derivation, % lesson(s) unpublished (each audited), with_quiz consistent, snapshot covers all % segments',
    v_domain, v_unpub, v_snap;
END $$;

COMMIT;

-- ============================================================================
-- AFTER THE APPLY — a seat step, NOT part of this file (D3):
--   ONE scope:all MLP rebuild, because the unpublishes change `mlp_item_pool` (it filters on
--   is_published). On financial there is nothing to rebuild for (0 unpublishes), but the rebuild
--   is harmless. On Moosii there is no local key for that service's /jobs, so it is fired from the
--   CMS MLP screen or by Mark — report the job id and its outcome in the reconciliation entry.
--   Re-deriving alone would NOT have needed a rebuild: the pool never reads seg_status.
--
-- STILL OPEN after this file, deliberately:
--   * the 9 unapproved quiz questions on 8 of the re-derived segments (D8 — flagged only);
--   * the 12 orphan segments themselves (D4 — re-derived, deletion backlogged);
--   * `lesson_publish_blocker` and the three RLS SELECT policies still key on seg_status rather
--     than card state (D7 — its own slice);
--   * the `sub_segments.review_state` column REVOKE (D5 — ships with the reset-audit slice);
--   * the 7 cards sitting `draft` with an approved image AND a newer candidate (a human pass).
-- ============================================================================
