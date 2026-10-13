-- ============================================================================
-- MIGRATION 111: Moosies — ONE server-side award path (F28) + lesson-completion unique key (F29)
--   BOTH PROJECTS (schema + trigger + one-time data reset) — DRAFT (pending apply)
-- ============================================================================
-- WHY (FINDINGS-activity-followups §6; Mark 2026-10-13): every completed_items INSERT awarded TWICE — the
-- AFTER INSERT trigger added user_configurations.moosi_to_add (10) AND moosii-rn added lessons.points /
-- questionnaire.points with a non-atomic read-then-write (useAwardMoosies.ts, useFinishQuestionnaire.ts).
-- Decision: the SERVER is the only award path. RN stops awarding in its own slice, which lands AFTER this one;
-- until it does, an RN completion still gets the client's extra award on top of this one.
--
-- WHAT:
--   1. moosie_awards — the award ledger. One row per award, UNIQUE (reason, source_id), so a source can pay at most
--      once. reason 'completion' → source_id = completed_items.id. 'activity_did_it' / 'activity_verified' are
--      RESERVED for the follow-up slice: allowed by the CHECK, written by nothing yet.
--      ⚠ source_id is TEXT, not the uuid the brief named: completed_items.id is a BIGINT identity on both projects,
--      and the activity reasons will point at uuids. CHECK moosie_awards_source_shape pins the shape per reason
--      (completion → decimal id; activity reasons → uuid), so a wrong-type id is refused structurally.
--      user_id FKs public."user" (where the balance lives; completed_items.user_id targets the same table).
--      RLS on: own row or is_admin() read; NO write policy and no write grant for anon/authenticated — only the
--      trigger (SECURITY DEFINER) and the service role write it.
--   2. trigger_add_moosies() rewritten (same name, so completed_items_insert_trigger keeps firing it):
--        amount = lesson  → 0 when lessons.kind = 'activity', else lessons.points
--                 questionnaire → questionnaire.points
--                 fallback user_configurations.moosi_to_add ONLY when the item has no points (NULL / item not found);
--                 no config → 0; never negative.
--        INSERT the ledger row ON CONFLICT (reason, source_id) DO NOTHING; the balance moves ONLY if that row was
--        inserted — same statement, same transaction as the completion. A recurring check-in pays on every new
--        completed_items row (each has its own id). Activities write a 0 ledger row (their points are reserved
--        for the follow-up slice).
--      SECURITY DEFINER + pinned search_path: the RN app inserts completions as `authenticated`, which can neither
--      write moosie_awards (no policy) nor read unpublished lessons' points (103). EXECUTE revoked from
--      PUBLIC/anon/authenticated (094 rule; a trigger function's EXECUTE is not checked when it fires).
--      Hash-guarded: refuses unless the live body is the legacy one (md5 2121c7c6…) or 111's (10d3d5de…).
--   3. F29: partial unique index completed_items (user_id, lesson_id) WHERE item_type = 'lesson'. Refuses (RAISE with
--      counts) if duplicates exist — wipe vs dedupe is Mark's call. Duplicate check 2026-10-13: 0 groups on both.
--      A second lesson completion now fails 23505 (RN gates on existence first, so only a race hits it).
--   4. ONE-TIME reset (no real users, invariant 3): every user.moosies → 0 and the ledger emptied — only on the run
--      that CREATES the ledger, so a re-run never wipes balances again.
-- NOT CHANGED: completed_items rows, user_mlp / the MLP (invariants 1, 8), streaks, follow-up tables. Clients can
-- still UPDATE their own user.moosies (user_self_update) — locking that column waits for the RN slice (backlog).
-- BOTH PROJECTS: one schema (invariant 4). APPLY per migrations/README.md: financial first, then Moosii; then
-- regenerate database.types.ts (Moosii).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT: no moosie_awards; md5 2121c7c646875d45ac7638cefcea7505; 0 / 0 dups.
--   SELECT to_regclass('public.moosie_awards');
--   SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE proname = 'trigger_add_moosies';
--   SELECT count(*) AS groups, coalesce(sum(n), 0) AS rows FROM (
--     SELECT user_id, lesson_id, count(*) n FROM completed_items WHERE item_type = 'lesson'
--     GROUP BY 1, 2 HAVING count(*) > 1) d;
-- ---------------------------------------------------------------------------

BEGIN;

-- Remember whether THIS run creates the ledger (drives the one-time reset in step 4).
DO $$ BEGIN PERFORM set_config('m111.fresh', (to_regclass('public.moosie_awards') IS NULL)::text, true); END $$;

-- Guard: the trigger body is the legacy one or already 111's.
DO $$ DECLARE cur text; BEGIN
  SELECT md5(replace(prosrc, chr(13), '')) INTO cur FROM pg_proc WHERE oid = 'public.trigger_add_moosies()'::regprocedure;
  IF cur <> '2121c7c646875d45ac7638cefcea7505' AND cur <> '10d3d5defc033fb8b7c658ad2d92d0b7' THEN
    RAISE EXCEPTION '111: trigger_add_moosies body md5 % is neither the legacy one nor 111''s — re-base before applying', cur;
  END IF;
END $$;

-- Guard (F29): no duplicate lesson completions.
DO $$ DECLARE g bigint; r bigint; BEGIN
  SELECT count(*), coalesce(sum(n), 0) INTO g, r FROM (
    SELECT user_id, lesson_id, count(*) AS n FROM public.completed_items
    WHERE item_type = 'lesson' GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF g > 0 THEN
    RAISE EXCEPTION '111: % (user_id, lesson_id) groups / % rows of duplicate lesson completions — wipe or dedupe first', g, r;
  END IF;
END $$;

-- ---- 1. The ledger ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.moosie_awards (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE,
  amount      integer     NOT NULL CONSTRAINT moosie_awards_amount_nonneg CHECK (amount >= 0),
  reason      text        NOT NULL CONSTRAINT moosie_awards_reason_valid
                          CHECK (reason IN ('completion', 'activity_did_it', 'activity_verified')),
  source_id   text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moosie_awards_reason_source_unique UNIQUE (reason, source_id),
  CONSTRAINT moosie_awards_source_shape CHECK (
       (reason = 'completion' AND source_id ~ '^[1-9][0-9]*$')
    OR (reason IN ('activity_did_it', 'activity_verified')
        AND source_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
);
CREATE INDEX IF NOT EXISTS moosie_awards_user_id_idx ON public.moosie_awards (user_id);

COMMENT ON TABLE public.moosie_awards IS
  'Moosies award ledger (111). The ONLY award path: written by trigger_add_moosies on completed_items INSERT '
  '(reason completion, source_id = completed_items.id) — clients must NOT award. UNIQUE (reason, source_id) = '
  'a source pays at most once. user.moosies is the running balance of these rows.';

ALTER TABLE public.moosie_awards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.moosie_awards FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.moosie_awards TO authenticated;
GRANT ALL ON public.moosie_awards TO service_role;
DROP POLICY IF EXISTS moosie_awards_sel ON public.moosie_awards;
CREATE POLICY moosie_awards_sel ON public.moosie_awards FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT is_admin()));

-- ---- 2. The award trigger (same name → completed_items_insert_trigger unchanged) ----
CREATE OR REPLACE FUNCTION public.trigger_add_moosies()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
-- 111: the ONLY Moosies award path. One ledger row per completion; the balance moves only if it was inserted.
DECLARE
  v_kind     text;
  v_points   integer;
  v_amount   integer;
  v_award_id uuid;
BEGIN
  IF NEW.item_type = 'lesson' THEN
    SELECT l.kind, l.points INTO v_kind, v_points
      FROM public.lessons l WHERE l.id = coalesce(NEW.lesson_id, NEW.item_id);
  ELSIF NEW.item_type = 'questionnaire' THEN
    SELECT q.points INTO v_points
      FROM public.questionnaire q WHERE q.id = coalesce(NEW.questionnaire_id, NEW.item_id);
  END IF;

  IF v_kind = 'activity' THEN
    v_amount := 0;                                   -- activity points are reserved for the follow-up slice
  ELSIF v_points IS NOT NULL THEN
    v_amount := v_points;
  ELSE
    SELECT uc.moosi_to_add INTO v_amount             -- fallback only when the item has no points
      FROM public.user_configurations uc WHERE uc.user_id = NEW.user_id;
  END IF;
  v_amount := greatest(coalesce(v_amount, 0), 0);    -- no config → 0 (was: moosies + NULL → NOT NULL violation)

  INSERT INTO public.moosie_awards (user_id, amount, reason, source_id)
  VALUES (NEW.user_id, v_amount, 'completion', NEW.id::text)
  ON CONFLICT (reason, source_id) DO NOTHING
  RETURNING id INTO v_award_id;

  IF v_award_id IS NOT NULL AND v_amount > 0 THEN
    UPDATE public."user" SET moosies = moosies + v_amount WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.trigger_add_moosies() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_add_moosies() TO service_role;

-- ---- 3. F29: one completion per (user, lesson) ----
CREATE UNIQUE INDEX IF NOT EXISTS completed_items_user_lesson_unique
  ON public.completed_items (user_id, lesson_id) WHERE item_type = 'lesson';

-- ---- 4. One-time reset (only on the run that created the ledger) ----
DO $$ BEGIN
  IF current_setting('m111.fresh') = 'true' THEN
    DELETE FROM public.moosie_awards;
    UPDATE public."user" SET moosies = 0 WHERE moosies <> 0;
  END IF;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION (after apply):
-- 1. Structure: moosie_awards with its 3 CHECKs + UNIQUE, RLS on, one SELECT policy; anon has no privilege,
--    authenticated SELECT only. trigger_add_moosies: prosecdef = t, md5 = 111's, EXECUTE not held by anon /
--    authenticated / PUBLIC. completed_items_user_lesson_unique present (partial, item_type = 'lesson').
-- 2. sum(user.moosies) = 0 and moosie_awards empty.
-- 3. Behaviour, ROLLED BACK: docs/drafts/111-moosies/verify.sql — one insert per item type (lesson, activity,
--    questionnaire), a second questionnaire completion, a duplicate lesson completion (23505), and an insert made
--    as `authenticated` (RN's path) — each: exactly one ledger row and the right balance change.
-- ---------------------------------------------------------------------------
