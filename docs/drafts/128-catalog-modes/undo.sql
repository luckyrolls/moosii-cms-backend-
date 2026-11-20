-- 128 UNDO — a REHEARSAL. The last line is ROLLBACK, so running this proves the undo works and
-- changes nothing. To use it for real: read the whole file, change ROLLBACK to COMMIT, and run it
-- against the project you mean. (On a live project that is an APPLY, with everything that implies:
-- Mark's go, the file committed as it will run.)
--
-- These are the header's UNDO steps, in order, with the assertions that say they worked. Step 2
-- reads the seed catalog_mode_switches row — backfill_archived_ids / backfill_unarchived_ids —
-- so it names the exact rows 128 touched and cannot catch an archival that happened later.
--
-- NOT undone, deliberately: the content_approvals rows 128 wrote. They are history (append-only),
-- and the undo's own UPDATEs add two more sets of them, which is correct — an undo is itself an
-- archival action and 126's guard audits it.
--
-- SCOPE: this reverses the MIGRATION, not the mode switches performed since. Switching is a
-- deliberate act with its own log, and `mode_archived` does not identify a switcher's archival
-- here — the backfill set it on the mooselist rows WITHOUT touching their archived_at, so
-- "unarchive everything mode_archived" would reveal tracks that were archived before 128 existed.
-- If you want the pre-128 VISIBLE set back as well, switch to the mode 128 seeded (moosii mem,
-- financial live) FIRST, then run this. The final check below compares against the visible set as
-- it stands when this file starts, so it holds either way.

BEGIN;

-- What the visible catalog looked like BEFORE 128, so the final check has something to compare to.
CREATE TEMP TABLE undo_expect AS
SELECT t.id
  FROM public.tracks t
  LEFT JOIN (SELECT backfill_archived_ids AS arch, backfill_unarchived_ids AS unarch
               FROM public.catalog_mode_switches ORDER BY seq LIMIT 1) s ON true
 WHERE (t.archived_at IS NULL
        AND NOT t.id IN (SELECT e::uuid FROM jsonb_array_elements_text(s.unarch) AS e))
    OR t.id IN (SELECT e::uuid FROM jsonb_array_elements_text(s.arch) AS e);

-- ---------------------------------------------------------------- 1. the triggers come off first
-- Before the UPDATEs below, not after: tracks_group_guard_trg would refuse step 2's re-archival
-- (it puts the join-in back in 'legacy' while a mem questionnaire still points at it), and
-- tracks_mode_archived_sync_trg would rewrite mode_archived underneath it.
DROP TRIGGER IF EXISTS questionnaire_group_guard_trg                ON public.questionnaire;
DROP TRIGGER IF EXISTS questionnaire_response_group_guard_trg       ON public.questionnaire_response;
DROP TRIGGER IF EXISTS questionnaire_answer_actions_group_guard_trg ON public.questionnaire_answer_actions;
DROP TRIGGER IF EXISTS track_tag_map_group_guard_trg                ON public.track_tag_map;
DROP TRIGGER IF EXISTS tracks_group_guard_trg                       ON public.tracks;
DROP TRIGGER IF EXISTS tracks_mode_insert_default_trg               ON public.tracks;
DROP TRIGGER IF EXISTS tracks_mode_archived_sync_trg                ON public.tracks;

-- ---------------------------------------------------------------- 2. reverse archived_at
-- (a) the rows the backfill archived as legacy go back to visible
WITH seed AS (SELECT backfill_archived_ids AS arch
                FROM public.catalog_mode_switches ORDER BY seq LIMIT 1)
UPDATE public.tracks t SET archived_at = NULL
 WHERE t.id IN (SELECT e::uuid FROM seed, jsonb_array_elements_text(seed.arch) AS e);

-- (b) the join-in goes back where it was found: archived, legacy-era content
WITH seed AS (SELECT backfill_unarchived_ids AS unarch
                FROM public.catalog_mode_switches ORDER BY seq LIMIT 1)
UPDATE public.tracks t SET archived_at = now(), test_group = 'legacy'
 WHERE t.id IN (SELECT e::uuid FROM seed, jsonb_array_elements_text(seed.unarch) AS e);

-- ---------------------------------------------------------------- 3. the functions
DROP FUNCTION IF EXISTS public.switch_catalog_mode(text, uuid);
DROP FUNCTION IF EXISTS public.set_track_group(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.questionnaire_group_guard();
DROP FUNCTION IF EXISTS public.assert_no_cross_group_links();
DROP FUNCTION IF EXISTS public.tracks_mode_insert_default();
DROP FUNCTION IF EXISTS public.tracks_mode_archived_sync();
DROP FUNCTION IF EXISTS public.current_catalog_mode();

-- ---------------------------------------------------------------- 4. the log
DROP TABLE IF EXISTS public.catalog_mode_switches;

-- ---------------------------------------------------------------- 5. the columns
ALTER TABLE public.tracks DROP COLUMN IF EXISTS mode_archived;
ALTER TABLE public.tracks DROP COLUMN IF EXISTS test_group;

-- ---------------------------------------------------------------- VERIFY
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='tracks'
     AND column_name IN ('test_group','mode_archived');
  IF v_n <> 0 THEN RAISE EXCEPTION 'UNDO: % of 128''s columns are still on tracks', v_n; END IF;

  IF to_regclass('public.catalog_mode_switches') IS NOT NULL THEN
    RAISE EXCEPTION 'UNDO: catalog_mode_switches still exists';
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('switch_catalog_mode','set_track_group','current_catalog_mode',
                       'assert_no_cross_group_links','questionnaire_group_guard',
                       'tracks_mode_insert_default','tracks_mode_archived_sync');
  IF v_n <> 0 THEN RAISE EXCEPTION 'UNDO: % of 128''s functions remain', v_n; END IF;

  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN ('questionnaire_group_guard_trg','questionnaire_response_group_guard_trg',
                    'questionnaire_answer_actions_group_guard_trg','track_tag_map_group_guard_trg',
                    'tracks_group_guard_trg','tracks_mode_insert_default_trg',
                    'tracks_mode_archived_sync_trg');
  IF v_n <> 0 THEN RAISE EXCEPTION 'UNDO: % of 128''s triggers remain', v_n; END IF;

  -- 126 must survive untouched: it is not 128's to remove
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgname='tracks_archive_guard_trg' AND tgrelid='public.tracks'::regclass) THEN
    RAISE EXCEPTION 'UNDO: 126''s tracks_archive_guard_trg was dropped — it is not 128''s to remove';
  END IF;

  -- and the visible catalog is byte-for-byte the pre-128 one
  SELECT count(*) INTO v_n FROM (
    SELECT id FROM public.tracks WHERE archived_at IS NULL
    EXCEPT SELECT id FROM undo_expect
    UNION ALL
    SELECT id FROM undo_expect
    EXCEPT SELECT id FROM public.tracks WHERE archived_at IS NULL) d;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'UNDO: the visible catalog differs from the pre-128 one by % track(s)', v_n;
  END IF;

  RAISE NOTICE 'UNDO OK: 128 fully removed; % track(s) visible, exactly the pre-128 set',
    (SELECT count(*) FROM public.tracks WHERE archived_at IS NULL);
END $$;

-- A REHEARSAL. Change this to COMMIT only when you mean to undo 128 for real.
ROLLBACK;
