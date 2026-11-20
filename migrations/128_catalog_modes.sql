-- 128 — CATALOG MODES: one global mode (live | mem | mdm) over a grouped track catalog.
--
-- *** BOTH PROJECTS, DIFFERENT BACKFILL *** branched on app_settings.domain.
-- *** REVIEW REQUIRED: this UPDATEs every track row, and on Moosii it ARCHIVES 15 tracks that
--     are active today (one of them carrying a published lesson). Do not apply without Mark's
--     explicit go for that project. ***
--
-- DECISIONS (Mark, 2026-11-19), all three about Moosii only:
--   * the ONE pre-existing cross-group link is resolved by option (a): "Baby Is Crawling"
--     (056884c8…) JOINS the mem catalog — retagged to 'mem' AND UNARCHIVED, inside the backfill
--     (step 3), which is why the PRE-CHECK gate computes it as mem and finds 0 violations;
--   * the initial Moosii mode is 'mem';
--   * archiving "Single parent challenges" (1 published lesson) as legacy is accepted.
--
-- WHY THIS SHAPE. The app already makes archived content invisible to parents: archival is
-- DERIVED (invariant 6) and filtered in ONE place — the final `JOIN tracks t ... AND
-- t.archived_at IS NULL` in user_active_tracks_for_user and its view twin (045/046, preserved by
-- 074). So a "catalog mode" needs no MLP algorithm change at all (invariant 1 untouched): it is a
-- bulk archive/unarchive plus a rebuild. `mode_archived` is what makes it REVERSIBLE — it records
-- WHO archived a track, the switcher or a human, so switching back unarchives exactly the tracks
-- the switcher archived and never resurrects something a person shelved on purpose.
--
-- THE FOUR GROUPS
--   live   the real curriculum
--   mem    Mark's test tracks
--   mdm    Michelle's test tracks
--   legacy old tracks. NEVER touched by a mode switch, in either direction.
--
-- TWO INVARIANTS, AS CHECKS RATHER THAN RULES (invariant 3: prefer structural safety)
--   mode_archived ⇒ archived_at IS NOT NULL   a switcher-archived track is archived
--   mode_archived ⇒ test_group <> 'legacy'    legacy is never switcher-archived
--
-- TRIGGER ORDER ON tracks MATTERS. Triggers on one event fire in ALPHABETICAL order, so BEFORE
-- UPDATE runs:
--     set_updated_at_trigger → tracks_archive_guard_trg (126) → tracks_mode_archived_sync_trg
-- 126's guard must run FIRST: it refuses a non-super_admin archival and writes the
-- content_approvals audit row. The sync trigger only normalises mode_archived afterwards, so a
-- refused archival never reaches it. Renaming either trigger reorders them — don't.
--
-- SHARED INFRA (invariant 4). `tracks` is written by the CMS DIRECTLY — create and archive, see
-- docs/rls-sweep.md — not only through this backend. That is exactly why the defaulting and
-- normalising rules here are TRIGGERS rather than route code: a CMS-direct INSERT still lands in
-- the right group, and a CMS-direct archive still records itself as manual. The second consumer
-- is the APP, which sees only the result, through user_active_tracks_for_user.
--
-- RE-RUNNABLE: the DDL is IF NOT EXISTS / DROP IF EXISTS + CREATE, and the backfill only touches
-- rows whose test_group is still NULL, so a second run is a no-op that still VERIFIEs.
--
-- UNDO (if 128 has to come off). In ONE transaction, in this order:
--   1. DROP TRIGGER questionnaire_group_guard_trg ON questionnaire;
--      DROP TRIGGER questionnaire_response_group_guard_trg ON questionnaire_response;
--      DROP TRIGGER questionnaire_answer_actions_group_guard_trg ON questionnaire_answer_actions;
--      DROP TRIGGER track_tag_map_group_guard_trg ON track_tag_map;
--      DROP TRIGGER tracks_group_guard_trg ON tracks;
--      DROP TRIGGER tracks_mode_insert_default_trg ON tracks;
--      DROP TRIGGER tracks_mode_archived_sync_trg ON tracks;
--   2. REVERSE what the backfill did to archived_at. The seed catalog_mode_switches row NAMES
--      the exact rows — backfill_archived_ids and backfill_unarchived_ids — so the undo needs no
--      timestamp and cannot catch a later archival by accident:
--        WITH seed AS (SELECT backfill_archived_ids   AS arch,
--                             backfill_unarchived_ids AS unarch
--                        FROM catalog_mode_switches ORDER BY seq LIMIT 1)
--        UPDATE tracks t SET archived_at = NULL
--         WHERE t.id IN (SELECT e::uuid FROM seed, jsonb_array_elements_text(seed.arch) AS e);
--        -- and put the join-in back where it was found (archived, legacy):
--        WITH seed AS (SELECT backfill_unarchived_ids AS unarch
--                        FROM catalog_mode_switches ORDER BY seq LIMIT 1)
--        UPDATE tracks t SET archived_at = now(), test_group = 'legacy'
--         WHERE t.id IN (SELECT e::uuid FROM seed, jsonb_array_elements_text(seed.unarch) AS e);
--      Both UPDATEs fire 126's guard and write one more content_approvals row each, which is
--      correct: the undo is itself an archival action.
--      This reverses the MIGRATION, not the switches performed since — and `mode_archived` must
--      NOT be used to find rows to reveal, because the backfill sets it on the mooselist rows
--      without touching their archived_at, which were already archived before 128 existed. To get
--      the pre-128 VISIBLE set back too, switch to the mode 128 seeded first, then undo.
--      Rehearsed, with these assertions, in docs/drafts/128-catalog-modes/undo.sql.
--   3. DROP FUNCTION switch_catalog_mode(text,uuid), set_track_group(uuid,text,uuid),
--      assert_no_cross_group_links(), current_catalog_mode(), tracks_mode_insert_default(),
--      tracks_mode_archived_sync(), questionnaire_group_guard();
--   4. DROP TABLE catalog_mode_switches;
--   5. ALTER TABLE tracks DROP COLUMN mode_archived, DROP COLUMN test_group;
--   6. Then ONE scope:all MLP rebuild, because step 2 changed which tracks are visible.
-- The content_approvals rows the backfill wrote are history and are NOT deleted (append-only).

BEGIN;

-- ============================================================================ PRE-CHECK
DO $$
DECLARE
  v_domain text;
  v_tracks int;
  v_bad    int;
  v_first  text;
BEGIN
  SELECT value INTO v_domain FROM public.app_settings WHERE key = 'domain';
  IF v_domain IS NULL OR v_domain NOT IN ('moosii','financial') THEN
    RAISE EXCEPTION '128 PRE-CHECK: app_settings.domain is %, expected moosii or financial',
      coalesce(v_domain, '(null)');
  END IF;

  SELECT count(*) INTO v_tracks FROM public.tracks;
  RAISE NOTICE '128 PRE-CHECK: domain=% system=% — % track(s)',
    v_domain, (pg_control_system()).system_identifier, v_tracks;

  -- 126 must be live: the backfill archives THROUGH its guard and relies on its audit row.
  IF to_regclass('public.content_approvals') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
                     WHERE tgname = 'tracks_archive_guard_trg'
                       AND tgrelid = 'public.tracks'::regclass) THEN
    RAISE EXCEPTION '128 PRE-CHECK: 126 is not applied here (tracks_archive_guard_trg missing)';
  END IF;

  IF v_domain = 'moosii' THEN
    SELECT count(*) INTO v_bad FROM public.tracks WHERE created_by = 'mooselist' AND archived_at IS NULL;
    IF v_bad <> 0 THEN
      RAISE EXCEPTION '128 PRE-CHECK: % mooselist track(s) are ACTIVE; the backfill assumes every mooselist row is archived', v_bad;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.tracks
                    WHERE id = '2076eb8c-4d5b-4b52-86c9-6b22ecc47192' AND archived_at IS NULL) THEN
      RAISE EXCEPTION '128 PRE-CHECK: the mem seed track 2076eb8c… (New Parents) is missing or already archived';
    END IF;

    -- The join-in (Mark, 2026-11-19, option a). "Baby Is Crawling" is the target of
    -- "Discovering Mobility"'s response, and that questionnaire is hosted on the mem seed track,
    -- so TM4 requires the target to be mem as well. It joins the mem catalog. If the row has
    -- gone, the decision no longer applies to anything and the gate below would be computing a
    -- group for a track that is not there — refuse rather than quietly drop the exception.
    IF NOT EXISTS (SELECT 1 FROM public.tracks
                    WHERE id = '056884c8-9fd8-4919-b0a1-4b4126b6979c') THEN
      RAISE EXCEPTION '128 PRE-CHECK: the mem join-in track 056884c8… (Baby Is Crawling) is missing — re-derive the cross-group decision before applying';
    END IF;
    SELECT count(*) INTO v_bad FROM public.tracks
     WHERE id = '056884c8-9fd8-4919-b0a1-4b4126b6979c' AND archived_at IS NULL;
    RAISE NOTICE '128 PRE-CHECK: Baby Is Crawling -> mem, currently % active (0 = archived, so the backfill will UNARCHIVE it)', v_bad;

    SELECT count(*) INTO v_bad
      FROM public.tracks
     WHERE archived_at IS NULL
       AND coalesce(created_by, '') <> 'mooselist'
       AND id NOT IN ('2076eb8c-4d5b-4b52-86c9-6b22ecc47192',
                      '056884c8-9fd8-4919-b0a1-4b4126b6979c');
    RAISE NOTICE '128 PRE-CHECK: % active track(s) will be ARCHIVED as legacy by this migration', v_bad;
  END IF;

  -- THE SAME-GROUP GATE (TM4), computed against the groups this migration is ABOUT to assign. A
  -- pre-existing cross-group link is reported HERE, with the offending row, rather than failing
  -- deep inside VERIFY once every track row has already been rewritten.
  --
  -- The CASE below must mirror the backfill EXACTLY, join-in included — it is the backfill's
  -- rules, run ahead of time. That makes it authoritative on a FIRST apply only: once tracks have
  -- been retagged by set_track_group, these computed groups are no longer the real ones and
  -- assert_no_cross_group_links() in VERIFY (which reads test_group itself) is the authority.
  WITH g AS (
    SELECT t.id, t.track_name,
           CASE
             WHEN v_domain = 'financial'                        THEN 'live'
             WHEN t.created_by = 'mooselist'                    THEN 'live'
             WHEN t.id = '2076eb8c-4d5b-4b52-86c9-6b22ecc47192' THEN 'mem'
             WHEN t.id = '056884c8-9fd8-4919-b0a1-4b4126b6979c' THEN 'mem'   -- the join-in
             ELSE 'legacy'
           END AS grp
      FROM public.tracks t),
  host AS (
    SELECT q.id AS qid, q.questionnaire_name AS qname, g.grp
      FROM public.questionnaire q JOIN g ON g.id = q.track_id),
  links AS (
    SELECT 'questionnaire_response.track_id' AS path, h.qname, h.grp AS host_grp,
           tg.track_name, tg.grp AS tgt_grp
      FROM public.questionnaire_response r
      JOIN host h ON h.qid = r.questionnaire_id
      JOIN g tg ON tg.id = r.track_id
    UNION ALL
    SELECT 'questionnaire_response.tag_id', h.qname, h.grp, tg.track_name, tg.grp
      FROM public.questionnaire_response r
      JOIN host h ON h.qid = r.questionnaire_id
      JOIN public.track_tag_map m ON m.tag_id = r.tag_id
      JOIN g tg ON tg.id = m.track_id
    UNION ALL
    SELECT 'questionnaire.defer_topic', h.qname, h.grp, tg.track_name, tg.grp
      FROM public.questionnaire q
      JOIN host h ON h.qid = q.id
      JOIN g tg ON tg.id = q.defer_topic
    UNION ALL
    SELECT 'questionnaire_answer_actions.track_id', h.qname, h.grp, tg.track_name, tg.grp
      FROM public.questionnaire_answer_actions a
      JOIN public.questionnaire_answers ans ON ans.id = a.answer_id
      JOIN public.questionnaire_questions qq ON qq.question_id = ans.question_id
      JOIN host h ON h.qid = qq.questionnaire_id
      JOIN g tg ON tg.id = a.track_id
    UNION ALL
    SELECT 'questionnaire_answer_actions.tag_id', h.qname, h.grp, tg.track_name, tg.grp
      FROM public.questionnaire_answer_actions a
      JOIN public.questionnaire_answers ans ON ans.id = a.answer_id
      JOIN public.questionnaire_questions qq ON qq.question_id = ans.question_id
      JOIN host h ON h.qid = qq.questionnaire_id
      JOIN public.track_tag_map m ON m.tag_id = a.tag_id
      JOIN g tg ON tg.id = m.track_id)
  SELECT count(*),
         min(format('%s: questionnaire %L (%s) -> track %L (%s)', path, qname, host_grp, track_name, tgt_grp))
    INTO v_bad, v_first
    FROM links
   WHERE host_grp <> tgt_grp;

  IF v_bad <> 0 THEN
    RAISE EXCEPTION '128 PRE-CHECK: % pre-existing CROSS-GROUP questionnaire link(s). The same-group rule (TM4) cannot be enforced until they are resolved. First: %. Fix by retagging the target into the host''s group or clearing the link — a decision, not something this migration may make.',
      v_bad, v_first;
  END IF;
  RAISE NOTICE '128 PRE-CHECK: 0 cross-group questionnaire links under the new groups';
END $$;

-- ============================================================================ (a) COLUMNS
-- test_group goes on NULLABLE so the backfill can be an UPDATE — which is what 126's
-- archive_guard needs, being an UPDATE-only trigger. NOT NULL and the CHECKs follow the data.
ALTER TABLE public.tracks ADD COLUMN IF NOT EXISTS test_group    text;
ALTER TABLE public.tracks ADD COLUMN IF NOT EXISTS mode_archived boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tracks.test_group IS
  'Catalog group: live (real curriculum) | mem (Mark) | mdm (Michelle) | legacy (never touched by a mode switch). Migration 128.';
COMMENT ON COLUMN public.tracks.mode_archived IS
  'TRUE when the mode switcher archived this track, so a switch back unarchives it. FALSE for a human archival, which a switch must never undo. Migration 128.';

-- ============================================================================ (b) THE SWITCH LOG
-- The CURRENT MODE IS DERIVED: it is the latest row here. No mutable "current mode" cell exists
-- that could disagree with history — the same reasoning as user_facts (invariant 12).
CREATE TABLE IF NOT EXISTS public.catalog_mode_switches (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- seq, not switched_at, is what orders this log. `now()` is the TRANSACTION timestamp, so two
  -- switches in one transaction share a switched_at and the tie-break would fall to a random
  -- uuid — "the current mode" would then be non-deterministic. The harness caught exactly that.
  seq               bigint      GENERATED BY DEFAULT AS IDENTITY,
  mode              text        NOT NULL CHECK (mode IN ('live','mem','mdm')),
  previous_mode     text        NULL CHECK (previous_mode IS NULL OR previous_mode IN ('live','mem','mdm')),
  actor_id          uuid        NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role        text        NOT NULL,
  switched_at       timestamptz NOT NULL DEFAULT now(),
  tracks_archived   int         NOT NULL DEFAULT 0,
  tracks_unarchived int         NOT NULL DEFAULT 0,
  -- BACKFILL ONLY (NULL on every row switch_catalog_mode writes): the exact track ids this
  -- migration archived and unarchived, so the UNDO in the header names rows rather than guessing
  -- from a timestamp. A later switch needs no such list — its rows are the mode_archived ones.
  backfill_archived_ids   jsonb NULL,
  backfill_unarchived_ids jsonb NULL
);

-- Re-runnability: CREATE TABLE IF NOT EXISTS adds no column to a table that already exists.
ALTER TABLE public.catalog_mode_switches ADD COLUMN IF NOT EXISTS backfill_archived_ids   jsonb;
ALTER TABLE public.catalog_mode_switches ADD COLUMN IF NOT EXISTS backfill_unarchived_ids jsonb;

CREATE INDEX IF NOT EXISTS catalog_mode_switches_seq_idx
  ON public.catalog_mode_switches (seq DESC);

COMMENT ON TABLE public.catalog_mode_switches IS
  'Append-only log of catalog mode switches. The CURRENT MODE is the latest row BY seq (switched_at ties inside one transaction). Migration 128.';

ALTER TABLE public.catalog_mode_switches ENABLE ROW LEVEL SECURITY;
REVOKE ALL  ON TABLE public.catalog_mode_switches FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.catalog_mode_switches TO authenticated;
GRANT ALL    ON TABLE public.catalog_mode_switches TO service_role;

-- Any signed-in user may READ the mode: the CMS displays it, and an app client learns nothing
-- from it that the catalog does not already show. Nobody but the service role writes.
DROP POLICY IF EXISTS catalog_mode_switches_select_authenticated ON public.catalog_mode_switches;
CREATE POLICY catalog_mode_switches_select_authenticated
  ON public.catalog_mode_switches FOR SELECT TO authenticated USING (true);

-- ============================================================================ CURRENT MODE
CREATE OR REPLACE FUNCTION public.current_catalog_mode()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.mode
    FROM public.catalog_mode_switches s
   ORDER BY s.seq DESC
   LIMIT 1
$$;

COMMENT ON FUNCTION public.current_catalog_mode() IS
  'The current catalog mode: the latest catalog_mode_switches row. NULL only before 128 seeds one. Migration 128.';

-- 094: Supabase's default privileges grant EXECUTE on every NEW function to anon/authenticated,
-- and PostgREST exposes all of public at /rest/v1/rpc/*. Every function this file creates is
-- revoked and granted explicitly — the harness's VERIFY caught this one missing.
REVOKE ALL ON FUNCTION public.current_catalog_mode() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_catalog_mode() TO service_role;

-- ============================================================================ (c) BACKFILL
DO $$
DECLARE
  v_domain     text;
  v_live       int := 0;
  v_mem        int := 0;
  v_legacy_new int := 0;
  v_legacy_old int := 0;
  v_joined     int := 0;
  v_mode       text;
  v_arch_ids   jsonb := '[]'::jsonb;
  v_unarch_ids jsonb := '[]'::jsonb;
BEGIN
  SELECT value INTO v_domain FROM public.app_settings WHERE key = 'domain';

  IF v_domain = 'financial' THEN
    -- No mooselist rows and no legacy era here: the whole catalog IS the curriculum, and nothing
    -- is archived by this migration.
    UPDATE public.tracks SET test_group = 'live' WHERE test_group IS NULL;
    GET DIAGNOSTICS v_live = ROW_COUNT;
    v_mode := 'live';
    RAISE NOTICE '128 BACKFILL (financial): % track(s) -> live, 0 archived, 0 unarchived', v_live;

  ELSE
    -- 1. mooselist IS the real curriculum, and every one of those rows is already archived. They
    --    become live + mode_archived, i.e. "the switcher put these away" — which is true, because
    --    the initial mode is mem. archived_at is NOT touched, so 126's guard does not fire and no
    --    audit row is written for them.
    UPDATE public.tracks
       SET test_group = 'live', mode_archived = true
     WHERE test_group IS NULL AND created_by = 'mooselist';
    GET DIAGNOSTICS v_live = ROW_COUNT;

    -- 2. the one active test track Mark is working in.
    UPDATE public.tracks
       SET test_group = 'mem'
     WHERE test_group IS NULL AND id = '2076eb8c-4d5b-4b52-86c9-6b22ecc47192';
    GET DIAGNOSTICS v_mem = ROW_COUNT;

    -- 3. THE JOIN-IN (Mark, 2026-11-19, option a). "Baby Is Crawling" is the target of
    --    "Discovering Mobility"'s response and that questionnaire is hosted on the mem seed
    --    track, so TM4 requires both to sit in the same group. It joins mem — which, mem being
    --    the initial mode, means VISIBLE, so it is unarchived too. mode_archived stays false: no
    --    switcher put it away, and a switch back into mem must not claim it.
    --
    --    Placed HERE on purpose: BEFORE the legacy sweep below (which would otherwise claim it,
    --    since it is the WHERE clause's "everything else") and before the same-group check that
    --    this exists to satisfy — the gate in PRE-CHECK, the trigger in (f) and the final
    --    assert_no_cross_group_links() in VERIFY all see the resolved graph.
    --
    --    archived_at changes, so 126's guard fires: ONE content_approvals row, action
    --    'unarchive', actor NULL, actor_role 'service'.
    UPDATE public.tracks
       SET test_group = 'mem', archived_at = NULL, mode_archived = false
     WHERE test_group IS NULL AND id = '056884c8-9fd8-4919-b0a1-4b4126b6979c';
    GET DIAGNOSTICS v_joined = ROW_COUNT;
    IF v_joined > 0 THEN
      v_unarch_ids := jsonb_build_array('056884c8-9fd8-4919-b0a1-4b4126b6979c');
    END IF;

    -- 4. every OTHER active track is old work that must not show up in any mode: legacy AND
    --    archived, mode_archived FALSE so no future switch ever brings it back. This is the
    --    destructive part of the migration — archived_at changes, so 126's guard fires and writes
    --    one content_approvals row per track (actor NULL, actor_role 'service').
    --    The ids are captured, not just counted: the undo in the header names these exact rows.
    WITH upd AS (
      UPDATE public.tracks
         SET test_group = 'legacy', archived_at = now(), mode_archived = false
       WHERE test_group IS NULL AND archived_at IS NULL
      RETURNING id
    )
    SELECT count(*)::int, coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb)
      INTO v_legacy_new, v_arch_ids
      FROM upd;

    -- 5. everything else was already archived; it only needs the label.
    UPDATE public.tracks SET test_group = 'legacy' WHERE test_group IS NULL;
    GET DIAGNOSTICS v_legacy_old = ROW_COUNT;

    v_mode := 'mem';
    RAISE NOTICE '128 BACKFILL (moosii): % -> live (mode_archived), % -> mem, % -> mem UNARCHIVED (the join-in), % -> legacy NEWLY ARCHIVED, % -> legacy (already archived)',
      v_live, v_mem, v_joined, v_legacy_new, v_legacy_old;
    RAISE NOTICE '128 BACKFILL (moosii): newly archived ids %', v_arch_ids;
  END IF;

  -- The seed switch row. Only when the log is empty, so a re-run does not append a second one.
  IF NOT EXISTS (SELECT 1 FROM public.catalog_mode_switches) THEN
    INSERT INTO public.catalog_mode_switches (mode, previous_mode, actor_id, actor_role,
                                              tracks_archived, tracks_unarchived,
                                              backfill_archived_ids, backfill_unarchived_ids)
    VALUES (v_mode, NULL, NULL, 'migration', v_legacy_new, v_joined, v_arch_ids, v_unarch_ids);
    RAISE NOTICE '128 BACKFILL: initial catalog mode is %', v_mode;
  ELSE
    RAISE NOTICE '128 BACKFILL: catalog_mode_switches already seeded (current mode %), left alone',
      public.current_catalog_mode();
  END IF;
END $$;

-- Constraints go on AFTER the data, so a violation surfaces as a failed ALTER naming the
-- constraint rather than as a mid-backfill row error.
ALTER TABLE public.tracks ALTER COLUMN test_group SET NOT NULL;

ALTER TABLE public.tracks DROP CONSTRAINT IF EXISTS tracks_test_group_valid;
ALTER TABLE public.tracks ADD  CONSTRAINT tracks_test_group_valid
  CHECK (test_group IN ('live','mem','mdm','legacy'));

ALTER TABLE public.tracks DROP CONSTRAINT IF EXISTS tracks_mode_archived_implies_archived;
ALTER TABLE public.tracks ADD  CONSTRAINT tracks_mode_archived_implies_archived
  CHECK (NOT mode_archived OR archived_at IS NOT NULL);

ALTER TABLE public.tracks DROP CONSTRAINT IF EXISTS tracks_mode_archived_not_legacy;
ALTER TABLE public.tracks ADD  CONSTRAINT tracks_mode_archived_not_legacy
  CHECK (NOT mode_archived OR test_group <> 'legacy');

-- ============================================================================ (d) INSERT DEFAULT
-- The CMS inserts tracks directly, so the default cannot live in route code. A new track joins
-- the CURRENT mode's group unless the writer names one; a track created into a group that is not
-- the active mode is born archived, exactly as a switch would have left it. Never defaults to
-- 'legacy' — legacy is only ever chosen deliberately.
CREATE OR REPLACE FUNCTION public.tracks_mode_insert_default()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mode text := coalesce(public.current_catalog_mode(), 'live');
BEGIN
  IF NEW.test_group IS NULL THEN
    NEW.test_group := v_mode;
  END IF;

  IF NEW.test_group <> 'legacy' AND NEW.test_group <> v_mode THEN
    NEW.archived_at   := coalesce(NEW.archived_at, now());
    NEW.mode_archived := true;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.tracks_mode_insert_default() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tracks_mode_insert_default() TO service_role;

DROP TRIGGER IF EXISTS tracks_mode_insert_default_trg ON public.tracks;
CREATE TRIGGER tracks_mode_insert_default_trg
  BEFORE INSERT ON public.tracks
  FOR EACH ROW EXECUTE FUNCTION public.tracks_mode_insert_default();

-- ============================================================================ (e) MANUAL ARCHIVE
-- A human archiving or unarchiving a track (CMS, psql, SQL editor) leaves mode_archived alone.
-- That must read as MANUAL, or the next switch into this track's group would quietly bring it
-- back. So: if archived_at changed and mode_archived did not, force false.
--
-- The switcher itself always writes BOTH columns in one UPDATE, so mode_archived does change and
-- this trigger leaves its value intact. Named to sort AFTER tracks_archive_guard_trg (126) —
-- see the header; the guard must get first refusal.
CREATE OR REPLACE FUNCTION public.tracks_mode_archived_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.archived_at IS DISTINCT FROM OLD.archived_at
     AND NEW.mode_archived IS NOT DISTINCT FROM OLD.mode_archived THEN
    NEW.mode_archived := false;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.tracks_mode_archived_sync() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tracks_mode_archived_sync() TO service_role;

DROP TRIGGER IF EXISTS tracks_mode_archived_sync_trg ON public.tracks;
CREATE TRIGGER tracks_mode_archived_sync_trg
  BEFORE UPDATE OF archived_at ON public.tracks
  FOR EACH ROW EXECUTE FUNCTION public.tracks_mode_archived_sync();

-- ============================================================================ (f) SAME GROUP
-- TM4: a questionnaire may only point at tracks in its OWN group. Otherwise answering a
-- questionnaire in mem mode could enrol a parent into a live track, and a mode switch would leave
-- a plan referring to tracks nobody can see.
--
-- FIVE PATHS reach a track from a questionnaire:
--   questionnaire_response.track_id
--   questionnaire_response.tag_id               -> track_tag_map -> tracks
--   questionnaire_answer_actions.track_id       (via questionnaire_answers -> questionnaire_questions)
--   questionnaire_answer_actions.tag_id         -> track_tag_map -> tracks
--   questionnaire.defer_topic                   (named "topic", but it is an FK to tracks)
--
-- ONE function re-checks the WHOLE graph rather than the rows a particular trigger touched. At
-- this scale (3 questionnaires, 2 responses, 2 actions, 8 tag rows on Moosii) that costs
-- nothing, and it cannot miss a path the way five scoped queries could — a change to
-- tracks.test_group or to track_tag_map invalidates links that do not mention the changed row at
-- all. If the graph ever grows enough for this to matter, scope it then, with measurements.
CREATE OR REPLACE FUNCTION public.assert_no_cross_group_links()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n     int;
  v_first text;
BEGIN
  WITH host AS (
    SELECT q.id AS qid, q.questionnaire_name AS qname, t.test_group AS grp
      FROM public.questionnaire q JOIN public.tracks t ON t.id = q.track_id),
  links AS (
    SELECT 'questionnaire_response.track_id' AS path, h.qname, h.grp AS host_grp,
           t.track_name, t.test_group AS tgt_grp
      FROM public.questionnaire_response r
      JOIN host h ON h.qid = r.questionnaire_id
      JOIN public.tracks t ON t.id = r.track_id
    UNION ALL
    SELECT 'questionnaire_response.tag_id', h.qname, h.grp, t.track_name, t.test_group
      FROM public.questionnaire_response r
      JOIN host h ON h.qid = r.questionnaire_id
      JOIN public.track_tag_map m ON m.tag_id = r.tag_id
      JOIN public.tracks t ON t.id = m.track_id
    UNION ALL
    SELECT 'questionnaire.defer_topic', h.qname, h.grp, t.track_name, t.test_group
      FROM public.questionnaire q
      JOIN host h ON h.qid = q.id
      JOIN public.tracks t ON t.id = q.defer_topic
    UNION ALL
    SELECT 'questionnaire_answer_actions.track_id', h.qname, h.grp, t.track_name, t.test_group
      FROM public.questionnaire_answer_actions a
      JOIN public.questionnaire_answers ans ON ans.id = a.answer_id
      JOIN public.questionnaire_questions qq ON qq.question_id = ans.question_id
      JOIN host h ON h.qid = qq.questionnaire_id
      JOIN public.tracks t ON t.id = a.track_id
    UNION ALL
    SELECT 'questionnaire_answer_actions.tag_id', h.qname, h.grp, t.track_name, t.test_group
      FROM public.questionnaire_answer_actions a
      JOIN public.questionnaire_answers ans ON ans.id = a.answer_id
      JOIN public.questionnaire_questions qq ON qq.question_id = ans.question_id
      JOIN host h ON h.qid = qq.questionnaire_id
      JOIN public.track_tag_map m ON m.tag_id = a.tag_id
      JOIN public.tracks t ON t.id = m.track_id)
  SELECT count(*),
         min(format('%s: questionnaire %L (%s) -> track %L (%s)', path, qname, host_grp, track_name, tgt_grp))
    INTO v_n, v_first
    FROM links
   WHERE host_grp <> tgt_grp;

  IF v_n <> 0 THEN
    RAISE EXCEPTION 'cross-group questionnaire link (% in total). %', v_n, v_first
      USING ERRCODE = 'check_violation', HINT = 'cross_group_link';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.assert_no_cross_group_links() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_no_cross_group_links() TO service_role;

CREATE OR REPLACE FUNCTION public.questionnaire_group_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_no_cross_group_links();
  RETURN NULL;   -- AFTER trigger: the return value is ignored
END $$;

REVOKE ALL ON FUNCTION public.questionnaire_group_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.questionnaire_group_guard() TO service_role;

-- AFTER triggers, because the check reads the row being written: a BEFORE trigger would not see
-- it. STATEMENT level, since the function checks the whole graph once either way.
DROP TRIGGER IF EXISTS questionnaire_group_guard_trg ON public.questionnaire;
CREATE TRIGGER questionnaire_group_guard_trg
  AFTER INSERT OR UPDATE OF track_id, defer_topic ON public.questionnaire
  FOR EACH STATEMENT EXECUTE FUNCTION public.questionnaire_group_guard();

DROP TRIGGER IF EXISTS questionnaire_response_group_guard_trg ON public.questionnaire_response;
CREATE TRIGGER questionnaire_response_group_guard_trg
  AFTER INSERT OR UPDATE OF track_id, tag_id, questionnaire_id ON public.questionnaire_response
  FOR EACH STATEMENT EXECUTE FUNCTION public.questionnaire_group_guard();

DROP TRIGGER IF EXISTS questionnaire_answer_actions_group_guard_trg ON public.questionnaire_answer_actions;
CREATE TRIGGER questionnaire_answer_actions_group_guard_trg
  AFTER INSERT OR UPDATE OF track_id, tag_id, answer_id ON public.questionnaire_answer_actions
  FOR EACH STATEMENT EXECUTE FUNCTION public.questionnaire_group_guard();

DROP TRIGGER IF EXISTS track_tag_map_group_guard_trg ON public.track_tag_map;
CREATE TRIGGER track_tag_map_group_guard_trg
  AFTER INSERT OR UPDATE OF tag_id, track_id ON public.track_tag_map
  FOR EACH STATEMENT EXECUTE FUNCTION public.questionnaire_group_guard();

DROP TRIGGER IF EXISTS tracks_group_guard_trg ON public.tracks;
CREATE TRIGGER tracks_group_guard_trg
  AFTER UPDATE OF test_group ON public.tracks
  FOR EACH STATEMENT EXECUTE FUNCTION public.questionnaire_group_guard();

-- ============================================================================ (g) THE RPCs
-- switch_catalog_mode — ONE transaction, so the catalog is never half-switched.
CREATE OR REPLACE FUNCTION public.switch_catalog_mode(p_mode text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev       text := public.current_catalog_mode();
  v_archived   int  := 0;
  v_unarchived int  := 0;
  v_role       text;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('live','mem','mdm') THEN
    RAISE EXCEPTION 'switch_catalog_mode: mode must be live, mem or mdm, got %', coalesce(p_mode,'(null)')
      USING ERRCODE = 'check_violation', HINT = 'bad_mode';
  END IF;

  -- Capability, as in 127: p_actor or nothing. A no-JWT call (psql, service role with no actor)
  -- passes because there is no actor to judge; the ROUTE is what requires super_admin of a human.
  IF p_actor IS NOT NULL THEN
    SELECT u.role INTO v_role FROM public."user" u WHERE u.id = p_actor;
    IF v_role IS DISTINCT FROM 'super_admin' THEN
      RAISE EXCEPTION 'switch_catalog_mode: actor % is not a super_admin', p_actor
        USING ERRCODE = 'check_violation', HINT = 'catalog_mode_not_permitted';
    END IF;
  END IF;

  IF v_prev IS NOT DISTINCT FROM p_mode THEN
    -- Already there. No row appended, so the log stays a record of real changes.
    RETURN jsonb_build_object('mode', p_mode, 'previous_mode', v_prev, 'changed', false,
                              'tracks_archived', 0, 'tracks_unarchived', 0);
  END IF;

  -- 1. bring back what the SWITCHER put away for this group. mode_archived is the whole test:
  --    a track a human archived has mode_archived false and is left alone.
  UPDATE public.tracks
     SET archived_at = NULL, mode_archived = false
   WHERE test_group = p_mode AND mode_archived;
  GET DIAGNOSTICS v_unarchived = ROW_COUNT;

  -- 2. put away the other managed groups. 'legacy' is excluded by name — it is never touched by a
  --    switch, in either direction — and a track that is already archived is left exactly as it
  --    is, so a manual archival keeps its mode_archived = false.
  UPDATE public.tracks
     SET archived_at = now(), mode_archived = true
   WHERE test_group NOT IN ('legacy', p_mode) AND archived_at IS NULL;
  GET DIAGNOSTICS v_archived = ROW_COUNT;

  INSERT INTO public.catalog_mode_switches (mode, previous_mode, actor_id, actor_role,
                                            tracks_archived, tracks_unarchived)
  VALUES (p_mode, v_prev, p_actor, coalesce(auth.role(), 'service'), v_archived, v_unarchived);

  RETURN jsonb_build_object('mode', p_mode, 'previous_mode', v_prev, 'changed', true,
                            'tracks_archived', v_archived, 'tracks_unarchived', v_unarchived);
END $$;

REVOKE ALL ON FUNCTION public.switch_catalog_mode(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.switch_catalog_mode(text, uuid) TO service_role;

-- set_track_group — retag one track (TM17). The archival consequence follows from the group it
-- lands in, so a retag can never leave a track visible in the wrong mode.
CREATE OR REPLACE FUNCTION public.set_track_group(p_track uuid, p_group text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mode     text := coalesce(public.current_catalog_mode(), 'live');
  v_old      text;
  v_was_arch boolean;
  v_was_mode boolean;
  v_role     text;
  v_now      timestamptz;
  v_mode_arch boolean;
BEGIN
  IF p_group IS NULL OR p_group NOT IN ('live','mem','mdm','legacy') THEN
    RAISE EXCEPTION 'set_track_group: group must be live, mem, mdm or legacy, got %', coalesce(p_group,'(null)')
      USING ERRCODE = 'check_violation', HINT = 'bad_group';
  END IF;

  SELECT t.test_group, t.archived_at IS NOT NULL, t.mode_archived
    INTO v_old, v_was_arch, v_was_mode
    FROM public.tracks t WHERE t.id = p_track;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  IF p_actor IS NOT NULL THEN
    SELECT u.role INTO v_role FROM public."user" u WHERE u.id = p_actor;
    IF v_role IS DISTINCT FROM 'super_admin' THEN
      RAISE EXCEPTION 'set_track_group: actor % is not a super_admin', p_actor
        USING ERRCODE = 'check_violation', HINT = 'catalog_mode_not_permitted';
    END IF;
  END IF;

  IF p_group = 'legacy' THEN
    -- Out of the rotation for good: archived, and NOT switcher-archived, so no switch revives it.
    UPDATE public.tracks
       SET test_group = 'legacy', archived_at = coalesce(archived_at, now()), mode_archived = false
     WHERE id = p_track;

  ELSIF p_group = v_mode THEN
    -- Into the ACTIVE group: visible, but only if it was put away by the switcher or was shelved
    -- as legacy. A track a human archived inside a live group stays archived — their decision.
    IF v_was_mode OR (v_old = 'legacy' AND v_was_arch) THEN
      UPDATE public.tracks
         SET test_group = p_group, archived_at = NULL, mode_archived = false
       WHERE id = p_track;
    ELSE
      UPDATE public.tracks SET test_group = p_group WHERE id = p_track;
    END IF;

  ELSE
    -- Into a managed group that is NOT the active mode: archived as the switcher would have left
    -- it, so switching into that group later brings it back.
    UPDATE public.tracks
       SET test_group = p_group, archived_at = coalesce(archived_at, now()), mode_archived = true
     WHERE id = p_track;
  END IF;

  SELECT t.archived_at, t.mode_archived INTO v_now, v_mode_arch
    FROM public.tracks t WHERE t.id = p_track;

  RETURN jsonb_build_object(
    'found', true, 'track_id', p_track, 'mode', v_mode,
    'previous_group', v_old, 'test_group', p_group,
    'changed', v_old IS DISTINCT FROM p_group,
    'archived', v_now IS NOT NULL, 'mode_archived', v_mode_arch);
END $$;

REVOKE ALL ON FUNCTION public.set_track_group(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_track_group(uuid, text, uuid) TO service_role;

-- ============================================================================ VERIFICATION
DO $$
DECLARE
  v_domain text;
  v_n int;
  v_mode text;
  v_name text;   -- loop variable, kept separate from v_mode
BEGIN
  SELECT value INTO v_domain FROM public.app_settings WHERE key = 'domain';

  -- columns + constraints
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='tracks' AND column_name='test_group' AND is_nullable='NO';
  IF v_n <> 1 THEN RAISE EXCEPTION '128 VERIFY: tracks.test_group missing or nullable'; END IF;

  FOREACH v_name IN ARRAY ARRAY['tracks_test_group_valid','tracks_mode_archived_implies_archived','tracks_mode_archived_not_legacy'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid='public.tracks'::regclass AND conname=v_name) THEN
      RAISE EXCEPTION '128 VERIFY: constraint % is missing', v_name;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_n FROM public.tracks WHERE test_group NOT IN ('live','mem','mdm','legacy');
  IF v_n <> 0 THEN RAISE EXCEPTION '128 VERIFY: % track(s) with an unknown test_group', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.tracks WHERE mode_archived AND archived_at IS NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION '128 VERIFY: % mode_archived track(s) are not archived', v_n; END IF;

  SELECT count(*) INTO v_n FROM public.tracks WHERE mode_archived AND test_group = 'legacy';
  IF v_n <> 0 THEN RAISE EXCEPTION '128 VERIFY: % legacy track(s) are mode_archived', v_n; END IF;

  -- the log, and exactly one seed row
  IF to_regclass('public.catalog_mode_switches') IS NULL THEN
    RAISE EXCEPTION '128 VERIFY: catalog_mode_switches is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.catalog_mode_switches'::regclass) THEN
    RAISE EXCEPTION '128 VERIFY: catalog_mode_switches has RLS off';
  END IF;
  SELECT count(*) INTO v_n FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='catalog_mode_switches'
     AND grantee IN ('anon','authenticated')
     AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
  IF v_n <> 0 THEN RAISE EXCEPTION '128 VERIFY: % client write grant(s) on catalog_mode_switches', v_n; END IF;

  v_mode := public.current_catalog_mode();
  IF v_mode IS NULL THEN RAISE EXCEPTION '128 VERIFY: no catalog mode is set'; END IF;
  IF v_domain = 'financial' AND v_mode <> 'live' THEN
    RAISE EXCEPTION '128 VERIFY: financial should start in live, found %', v_mode;
  END IF;
  IF v_domain = 'moosii' AND v_mode <> 'mem' THEN
    RAISE EXCEPTION '128 VERIFY: moosii should start in mem, found %', v_mode;
  END IF;

  -- the ACTIVE group must be visible, and no other managed group may be
  SELECT count(*) INTO v_n FROM public.tracks
   WHERE test_group NOT IN ('legacy', v_mode) AND archived_at IS NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '128 VERIFY: % track(s) outside the active mode (%) are still active', v_n, v_mode;
  END IF;

  -- the seed row must NAME the rows it moved, or the undo in the header has nothing to work from
  SELECT count(*) INTO v_n FROM public.catalog_mode_switches s
   WHERE s.actor_role = 'migration'
     AND (s.backfill_archived_ids IS NULL
          OR s.backfill_unarchived_ids IS NULL
          OR jsonb_array_length(s.backfill_archived_ids)   <> s.tracks_archived
          OR jsonb_array_length(s.backfill_unarchived_ids) <> s.tracks_unarchived);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '128 VERIFY: % seed row(s) whose backfill id list disagrees with its counts', v_n;
  END IF;

  -- the join-in: mem, visible, and NOT switcher-owned (nothing archived it, so nothing may
  -- un-archive it on a switch back)
  IF v_domain = 'moosii' THEN
    SELECT count(*) INTO v_n FROM public.tracks
     WHERE id = '056884c8-9fd8-4919-b0a1-4b4126b6979c'
       AND test_group = 'mem' AND archived_at IS NULL AND NOT mode_archived;
    IF v_n <> 1 THEN
      RAISE EXCEPTION '128 VERIFY: the join-in track 056884c8… is not mem + visible + manual';
    END IF;
  END IF;

  -- functions: SECURITY DEFINER, pinned search_path, service_role only (094)
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public'
     AND p.proname IN ('current_catalog_mode','switch_catalog_mode','set_track_group',
                       'assert_no_cross_group_links','questionnaire_group_guard',
                       'tracks_mode_insert_default','tracks_mode_archived_sync')
     AND (NOT p.prosecdef
          OR p.proconfig IS NULL
          OR NOT ('search_path=public, pg_temp' = ANY(p.proconfig))
          OR has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
          OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE'));
  IF v_n <> 0 THEN RAISE EXCEPTION '128 VERIFY: % function(s) not SECURITY DEFINER + pinned + service_role-only', v_n; END IF;

  -- triggers, including the order the header depends on
  FOREACH v_name IN ARRAY ARRAY['tracks_mode_insert_default_trg','tracks_mode_archived_sync_trg',
                                'tracks_group_guard_trg'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.tracks'::regclass AND tgname=v_name) THEN
      RAISE EXCEPTION '128 VERIFY: trigger % is missing on tracks', v_name;
    END IF;
  END LOOP;
  IF 'tracks_archive_guard_trg' >= 'tracks_mode_archived_sync_trg' THEN
    RAISE EXCEPTION '128 VERIFY: trigger names no longer sort archive_guard before mode_archived_sync';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['questionnaire_group_guard_trg','questionnaire_response_group_guard_trg',
                                'questionnaire_answer_actions_group_guard_trg','track_tag_map_group_guard_trg'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = v_name AND NOT tgisinternal) THEN
      RAISE EXCEPTION '128 VERIFY: trigger % is missing', v_name;
    END IF;
  END LOOP;

  -- and the rule itself holds on the data as it now stands
  PERFORM public.assert_no_cross_group_links();

  RAISE NOTICE '128 VERIFY OK: domain=% mode=% — groups live %, mem %, mdm %, legacy % (% archived, % unarchived by the backfill); cross-group links 0',
    v_domain, public.current_catalog_mode(),
    (SELECT count(*) FROM public.tracks WHERE test_group='live'),
    (SELECT count(*) FROM public.tracks WHERE test_group='mem'),
    (SELECT count(*) FROM public.tracks WHERE test_group='mdm'),
    (SELECT count(*) FROM public.tracks WHERE test_group='legacy'),
    (SELECT tracks_archived   FROM public.catalog_mode_switches ORDER BY seq LIMIT 1),
    (SELECT tracks_unarchived FROM public.catalog_mode_switches ORDER BY seq LIMIT 1);
END $$;

COMMIT;
