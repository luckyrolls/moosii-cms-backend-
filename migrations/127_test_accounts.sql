-- MIGRATION 127: test accounts -- the is_test_account flag, its audit trail, and the two-depth reset.
--
-- *** BOTH PROJECTS *** (one schema, invariant 4). Row counts differ -- see PRE-CHECK and VERIFY.
--
-- STATUS: DRAFT (pending apply). Do not apply without a go. FINANCIAL first, then MOOSII on a
-- second go, per CLAUDE.md's apply gate.
--
-- RE-RUNNABLE, unlike 126: every step is IF NOT EXISTS / CREATE OR REPLACE / DROP+CREATE, and the
-- seed only writes when the flag actually changes. A second apply is a no-op that still VERIFIEs.
--
-- DECISIONS (Mark, 2026-11-17; evidence in docs/FINDINGS-test-mode.md)
--   * `is_test_account` is a COLUMN on public."user", not a separate table -- because migration 112
--     revoked table-level INSERT/UPDATE from anon and authenticated and granted exactly ten UPDATE
--     columns, so a NEW column is unwritable by any client the moment it is added, and the refusal
--     is 42501 at the PRIVILEGE layer. Confirmed empirically on both projects 2026-11-17
--     (FINDINGS-test-mode.md section C7). Grant NOTHING here; VERIFY asserts it.
--   * Reset has two depths. 'activity' wipes what the parent DID; 'full' also wipes onboarding so
--     the account re-onboards as new.
--   * Reset NEVER touches identity or authority. Expressed as a COLUMN DENYLIST, not "never touch
--     the user row" -- `onboarding_complete`, the three intro flags and the `moosies` balance all
--     live ON that row, so a row-level rule would make 'full' impossible (section B1).
--   * Flagging and resetting are super_admin only. The first test accounts are Mark's and
--     Michelle's own super_admin CMS logins, so the check is on the ACTOR'S ROLE and never on
--     `auth.uid() = NEW.id`: a super_admin must be able to flag their own login.
--
-- WHY RLS IS NOT THE GUARD (the trap this file must not fall into)
-- The live UPDATE policy on public."user" is ONE policy, `user_self_update`, whose qual is
-- `(id = auth.uid()) OR is_super_admin() OR (auth.role() = 'service_role')` (read from both
-- projects 2026-11-17). Policies OR, so RLS BY ITSELF PERMITS AN ACCOUNT TO WRITE ITS OWN ROW --
-- including a new flag. Adding a strict policy beside it would change nothing (CLAUDE.md, RLS
-- traps). The column grant is the lock; the trigger below is a second, independent layer; the
-- route is a third. No policy is added to "user" here, deliberately.
--
-- WHAT THIS DOES NOT DO: no CMS (slice 3), no catalog modes or track columns (slice 2), no
-- questionnaire RLS fix (TM9), no mark_mlp_stale (TM11), no TRUNCATE revoke (TM15).
--
-- MLP / card_positions: untouched. No prompt row, no prompt block (invariant 2); `mlp_item_pool`,
-- `user_active_tracks_for_user` and `generateFullMLP` are not referenced (invariants 1 and 8). The
-- reset DELETES a user's `user_mlp` / `user_mlp_v2` rows and the BACKEND then rebuilds that ONE
-- user (`rebuild_user_mlp`, never scope:all) -- see api-contract.md section 10.

BEGIN;

-- ================================================================ PRE-CHECK
DO $$
DECLARE
  v_domain  text;
  v_n       int;
  v_emails  text[] := ARRAY['markmun99@gmail.com','mdawnmunroe@gmail.com'];
BEGIN
  SELECT value INTO v_domain FROM public.app_settings WHERE key = 'domain';
  RAISE NOTICE '127 PRE-CHECK: domain=% system=%', v_domain, (pg_control_system()).system_identifier;

  -- 1. 126 must be live: can_publish is in the reset's denylist, and the seed relies on
  --    is_super_admin() existing with 126's role CHECK in place.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='user' AND column_name='can_publish') THEN
    RAISE EXCEPTION '127: "user".can_publish is missing -- apply 126 before this file';
  END IF;
  IF to_regprocedure('public.is_super_admin()') IS NULL THEN
    RAISE EXCEPTION '127: public.is_super_admin() is missing -- this schema is older than this file expects';
  END IF;

  -- 2. step (f) SET NOT NULL must be satisfiable. Measured 0 NULLs on both projects 2026-11-17;
  --    fail loudly rather than erroring mid-ALTER if that has changed.
  SELECT count(*) INTO v_n FROM public."user" WHERE onboarding_complete IS NULL;
  IF v_n > 0 THEN
    RAISE EXCEPTION '127: % "user" row(s) have onboarding_complete IS NULL -- backfill to false before applying', v_n;
  END IF;
  RAISE NOTICE '127 PRE-CHECK: onboarding_complete -- % row(s) total, 0 null, % true, % false',
    (SELECT count(*) FROM public."user"),
    (SELECT count(*) FROM public."user" WHERE onboarding_complete),
    (SELECT count(*) FROM public."user" WHERE onboarding_complete = false);

  -- 3. how many of the seed accounts exist HERE (financial may legitimately have 0-2)
  SELECT count(*) INTO v_n FROM public."user" WHERE email = ANY(v_emails);
  RAISE NOTICE '127 PRE-CHECK: % of the 2 seed account(s) exist on this project and will be flagged', v_n;

  -- 4. every seed account must have its auth.users row, because test_account_events FKs there
  SELECT count(*) INTO v_n
    FROM public."user" u WHERE u.email = ANY(v_emails)
     AND NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id);
  IF v_n > 0 THEN
    RAISE EXCEPTION '127: % seed account(s) have no auth.users row -- investigate before applying', v_n;
  END IF;
END $$;

-- ================================================================ (a) the flag
-- No GRANT. 112 left anon/authenticated with NO table-level INSERT or UPDATE on "user" and only
-- column-level grants, so an ungranted column cannot be written by any client. VERIFY asserts this
-- rather than assuming it.
ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS is_test_account boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public."user".is_test_account IS
  'Migration 127. A demo/QA account that reset_test_account may wipe. Settable ONLY by a '
  'super_admin through the backend (PATCH /users/:id/test-account); unwritable by any client '
  'because no column grant exists (112) and test_account_flag_guard refuses a non-super_admin JWT.';

-- ================================================================ (b) the flag guard
-- Second layer, independent of the column grant. Same shape as 126's archive_guard: the capability
-- is checked only when there IS a JWT to judge. A NULL auth.uid() means the service role, psql or
-- the SQL editor -- on the RPC path set_test_account already checked p_actor, and a direct SQL
-- session is trusted by construction (and is how this file's own seed runs).
CREATE OR REPLACE FUNCTION public.test_account_flag_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF NEW.is_test_account IS NOT DISTINCT FROM OLD.is_test_account THEN
    RETURN NEW;   -- not a flag change
  END IF;

  -- Role-based, never identity-based: a super_admin flagging their OWN login is the intended
  -- first use, so `auth.uid() = NEW.id` must not be a refusal.
  IF v_actor IS NOT NULL AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'user %: changing is_test_account requires super_admin', NEW.id
      USING ERRCODE = 'check_violation', HINT = 'test_account_not_permitted';
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.test_account_flag_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.test_account_flag_guard() TO service_role;

DROP TRIGGER IF EXISTS test_account_flag_guard_trg ON public."user";
CREATE TRIGGER test_account_flag_guard_trg
  BEFORE UPDATE OF is_test_account ON public."user"
  FOR EACH ROW EXECUTE FUNCTION public.test_account_flag_guard();

-- ================================================================ (c) the audit trail
-- Backend-only writes; super_admin read (the CMS list shows who flagged and reset what, and when).
-- actor_id is NULLABLE because a migration or SQL-editor action genuinely has no actor -- the same
-- admission 126 made for archive/unarchive; actor_role then records 'migration' or 'service' so
-- such a row is never mistaken for an unattributed user action.
CREATE TABLE IF NOT EXISTS public.test_account_events (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action     text        NOT NULL,
  actor_id   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role text        NOT NULL,
  detail     jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT test_account_events_action_check
    CHECK (action = ANY (ARRAY['flag','unflag','reset_activity','reset_full']))
);

CREATE INDEX IF NOT EXISTS test_account_events_user_idx    ON public.test_account_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS test_account_events_created_idx ON public.test_account_events (created_at DESC);

COMMENT ON TABLE public.test_account_events IS
  'Migration 127. Append-only audit of test-account flagging and resets. Written only by '
  'set_test_account / reset_test_account, in the same transaction as the change they record.';

-- Every public table has RLS on (102). Supabase default privileges GRANT ALL on a new table to
-- anon and authenticated, so revoke first and hand back only what the read policy needs.
ALTER TABLE public.test_account_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.test_account_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.test_account_events TO authenticated;
GRANT ALL    ON TABLE public.test_account_events TO service_role;

DROP POLICY IF EXISTS test_account_events_select_super_admin ON public.test_account_events;
CREATE POLICY test_account_events_select_super_admin ON public.test_account_events
  FOR SELECT TO authenticated
  USING ((SELECT public.is_super_admin()));
-- No INSERT / UPDATE / DELETE policy, and no grant for them: no client can write this table.

-- ================================================================ (d) set_test_account
CREATE OR REPLACE FUNCTION public.set_test_account(p_user uuid, p_flag boolean, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_was  boolean;
  v_role text;
BEGIN
  -- Unknown user is a 404, decided before anything else, so "not found" is never reported as a
  -- refusal and a refusal never leaks whether the account exists.
  SELECT u.is_test_account, u.role INTO v_was, v_role FROM public."user" u WHERE u.id = p_user;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- CAPABILITY. Checked against p_actor, the verified JWT's user -- never the body (invariant 7).
  -- Under the service role auth.uid() is NULL, so the table trigger skips its own check on this
  -- path and this is the only place the actor can be judged. A NULL p_actor is the SQL-editor /
  -- migration case and passes by design, exactly as 126's guards do.
  IF p_actor IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public."user" a WHERE a.id = p_actor AND a.role = 'super_admin') THEN
    RAISE EXCEPTION 'set_test_account: actor % is not a super_admin', p_actor
      USING ERRCODE = 'check_violation', HINT = 'test_account_not_permitted';
  END IF;

  IF v_was IS NOT DISTINCT FROM p_flag THEN
    -- Idempotent: no write, no audit row, and the caller is told it was already in that state.
    RETURN jsonb_build_object('found', true, 'is_test_account', p_flag, 'changed', false);
  END IF;

  UPDATE public."user" SET is_test_account = p_flag WHERE id = p_user;

  -- Same transaction as the UPDATE: if this insert fails the flag change rolls back with it.
  INSERT INTO public.test_account_events (user_id, action, actor_id, actor_role, detail)
  VALUES (p_user,
          CASE WHEN p_flag THEN 'flag' ELSE 'unflag' END,
          p_actor,
          coalesce((SELECT a.role FROM public."user" a WHERE a.id = p_actor), coalesce(auth.role(), 'service')),
          jsonb_build_object('previous', v_was));

  RETURN jsonb_build_object('found', true, 'is_test_account', p_flag, 'changed', true);
END $$;

REVOKE ALL ON FUNCTION public.set_test_account(uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_test_account(uuid, boolean, uuid) TO service_role;

-- ================================================================ (e) reset_test_account
-- Deletes leaf-first per FINDINGS-test-mode.md section B2. Live catalog, both projects 2026-11-17:
-- 22 FKs point at per-user tables and NOT ONE IS RESTRICT (19 CASCADE into "user", 3 CASCADE into
-- user_update_events, plus user_activity_followups.verified_fact_id -> user_facts SET NULL), and
-- there is NO DELETE TRIGGER on any of these tables. So nothing here can raise 23503, and nothing
-- fires behind our back -- which is also why `"user".moosies` must be zeroed EXPLICITLY: the only
-- award trigger (completed_items_insert_trigger -> trigger_add_moosies, 111) fires on INSERT, so
-- deleting completed_items does not reverse the balance.
--
-- Every table is guarded with to_regclass so the one file runs on both projects despite
-- financial-only tables (demo_outcome_*) and Moosii-only legacy tables.
CREATE OR REPLACE FUNCTION public.reset_test_account(p_user uuid, p_depth text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_flag     boolean;
  v_kids     uuid[];
  v_deleted  jsonb := '{}'::jsonb;
  v_n        bigint;
  v_tbl      text;
  v_col      text;
  v_pair     text[];
  -- ACTIVITY depth: what the parent DID. {table, user-keyed column}
  v_activity text[][] := ARRAY[
    ['moosie_awards','user_id'],
    ['completed_items','user_id'],
    ['user_lesson_progress','user_id'],
    ['user_segement_track','user_id'],
    ['starred_items','user id'],
    ['user_activity_followups','user_id'],
    ['user_questionnaire_progress','user_id'],
    ['questionnaire_user_answers','user_id'],
    ['user_mlp','user_id'],
    ['user_mlp_v2','user_id'],
    ['user_mlp_bs_backup','user_id'],
    ['user_mlp_mods','user_id'],
    ['user_track_activations','user_id'],
    ['user_template_history','user_id'],
    ['notifications','user_id'],
    ['notification_log','user_id'],
    ['user_tag','user_id'],
    ['quiz_user_progress', NULL]          -- NULL column = known to have no user key; skipped, reported
  ];
  -- FULL depth, additionally: onboarding. `children` is handled separately, after its child rows.
  v_onboarding text[][] := ARRAY[
    ['user_demographic_responses','user_id'],
    ['user_configurations','user_id'],
    ['user_settings','user_id'],
    ['user_tracks','user_id'],
    ['user_track_weights','user_id']
  ];
BEGIN
  IF p_depth IS NULL OR p_depth NOT IN ('activity','full') THEN
    RAISE EXCEPTION 'reset_test_account: depth must be activity or full, got %', coalesce(p_depth,'(null)')
      USING ERRCODE = 'check_violation', HINT = 'bad_depth';
  END IF;

  SELECT u.is_test_account INTO v_flag FROM public."user" u WHERE u.id = p_user;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- THE SAFETY INTERLOCK. A reset is only ever possible against a deliberately flagged account.
  IF NOT coalesce(v_flag, false) THEN
    RAISE EXCEPTION 'reset_test_account: user % is not a test account', p_user
      USING ERRCODE = 'check_violation', HINT = 'not_test_account';
  END IF;

  -- CAPABILITY, as in set_test_account: p_actor or nothing.
  IF p_actor IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public."user" a WHERE a.id = p_actor AND a.role = 'super_admin') THEN
    RAISE EXCEPTION 'reset_test_account: actor % is not a super_admin', p_actor
      USING ERRCODE = 'check_violation', HINT = 'test_account_not_permitted';
  END IF;

  SELECT coalesce(array_agg(c.id), '{}'::uuid[]) INTO v_kids
    FROM public.children c WHERE c.parent_id = p_user;

  -- ---- 1. the classify subtree, explicitly: signals -> detections -> events ----------------
  -- user_update_signals has no user key at all (only event_id), and the detections are keyed by
  -- BOTH user_id and child_id. Deleting the events would cascade all three (016/025/081), but we
  -- delete them by hand so the counts are reported and nothing depends on cascade (invariant 5's
  -- lesson). Child-keyed rows are removed by child_id as well, because child_milestones and the
  -- detections carry NO FK to children -- deleting a child would orphan them, not fail.
  IF to_regclass('public.user_update_signals') IS NOT NULL THEN
    DELETE FROM public.user_update_signals s
     WHERE s.event_id IN (SELECT e.id FROM public.user_update_events e
                           WHERE e.user_id = p_user OR e.child_id = ANY(v_kids));
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('user_update_signals', v_n);
  END IF;

  FOREACH v_tbl IN ARRAY ARRAY['distress_detections','health_detections'] LOOP
    IF to_regclass('public.' || quote_ident(v_tbl)) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I WHERE user_id = $1 OR child_id = ANY($2)', v_tbl)
        USING p_user, v_kids;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_deleted := v_deleted || jsonb_build_object(v_tbl, v_n);
    END IF;
  END LOOP;

  IF to_regclass('public.user_update_events') IS NOT NULL THEN
    DELETE FROM public.user_update_events e WHERE e.user_id = p_user OR e.child_id = ANY(v_kids);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('user_update_events', v_n);
  END IF;

  -- child_milestones: child-keyed only, no FK (019). "Milestone facts" in the brief's wording.
  IF to_regclass('public.child_milestones') IS NOT NULL THEN
    DELETE FROM public.child_milestones m WHERE m.child_id = ANY(v_kids);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('child_milestones', v_n);
  END IF;

  -- ---- 2. the plain user-keyed activity tables, leaf-first ---------------------------------
  FOREACH v_pair SLICE 1 IN ARRAY v_activity LOOP
    v_tbl := v_pair[1];
    v_col := v_pair[2];
    IF to_regclass('public.' || quote_ident(v_tbl)) IS NULL THEN
      CONTINUE;                                        -- absent on this project
    END IF;
    IF v_col IS NULL THEN
      -- quiz_user_progress has NO user column (FINDINGS-test-mode.md section B1): it cannot be
      -- reset per user and must not be emptied wholesale. Reported so the gap stays visible.
      v_deleted := v_deleted || jsonb_build_object(v_tbl, 'skipped_no_user_column');
      CONTINUE;
    END IF;
    EXECUTE format('DELETE FROM public.%I WHERE %I = $1', v_tbl, v_col) USING p_user;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object(v_tbl, v_n);
  END LOOP;

  -- ---- 3. facts, by SOURCE ------------------------------------------------------------------
  -- One table, six provenances (101, 104). 'derived' and 'manual' are what the parent produced.
  -- 'seed' is the demo outcome story and is NEVER deleted at either depth; 'platform_api' (the
  -- partner intake) and 'estimated' survive an activity reset because they are not parent actions.
  -- user_activity_followups.verified_fact_id is ON DELETE SET NULL, and the followups are already
  -- gone by now anyway, so no ordering hazard either way.
  IF to_regclass('public.user_facts') IS NOT NULL THEN
    DELETE FROM public.user_facts f
     WHERE f.user_id = p_user
       AND f.source IN ('derived','manual');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('user_facts_derived_manual', v_n);
  END IF;

  -- ---- 4. the moosies balance --------------------------------------------------------------
  -- moosie_awards rows were deleted in step 2. The ledger is the source of truth and
  -- "user".moosies is its running total (111), so it must be zeroed explicitly -- the award
  -- trigger fires on INSERT only and nothing reverses it on DELETE. `moosies` is deliberately NOT
  -- in the denylist below.
  UPDATE public."user" SET moosies = 0 WHERE id = p_user AND moosies <> 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_deleted := v_deleted || jsonb_build_object('user_moosies_zeroed', v_n);

  -- ---- 5. FULL depth only ------------------------------------------------------------------
  IF p_depth = 'full' THEN
    FOREACH v_pair SLICE 1 IN ARRAY v_onboarding LOOP
      v_tbl := v_pair[1];
      v_col := v_pair[2];
      IF to_regclass('public.' || quote_ident(v_tbl)) IS NULL THEN CONTINUE; END IF;
      EXECUTE format('DELETE FROM public.%I WHERE %I = $1', v_tbl, v_col) USING p_user;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_deleted := v_deleted || jsonb_build_object(v_tbl, v_n);
    END LOOP;

    -- facts that are not parent actions, but are onboarding-shaped. 'seed' still excluded.
    IF to_regclass('public.user_facts') IS NOT NULL THEN
      DELETE FROM public.user_facts f
       WHERE f.user_id = p_user
         AND f.source IN ('platform_api','estimated');
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_deleted := v_deleted || jsonb_build_object('user_facts_platform_estimated', v_n);
    END IF;

    -- children LAST of the deletes: their child-keyed rows went in step 1, and those tables carry
    -- no FK to children, so this order is about not leaving orphans rather than about 23503.
    DELETE FROM public.children c WHERE c.parent_id = p_user;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('children', v_n);

    -- The "user" row: onboarding columns only.
    --
    -- DENYLIST, never written by this function at either depth:
    --   id, email, role, can_review_editorial, can_approve_clinical, can_publish, is_verified,
    --   auth_provider, is_test_account.
    -- That is what keeps Mark's and Michelle's super_admin CMS logins intact through a reset.
    --
    -- onboarding_complete is set to FALSE and never NULL: moosii-rn coerces a NULL to `true`
    -- (`onboarding_complete ?? true`, src/hooks/useUserProfile.ts:42), so a NULL here would read as
    -- "already onboarded" and silently turn a full reset into an activity one. Step (f) below makes
    -- that structurally impossible as well.
    --
    -- NOT NULL columns must go back to their DEFAULT, never to NULL. Measured on both projects
    -- 2026-11-17: `birth_date` is NOT NULL DEFAULT now() and `name` is nullable DEFAULT ''. The
    -- first version of this function nulled birth_date and raised 23502 on every real account --
    -- caught by docs/drafts/127-test-accounts (the fixture has a profile; an empty table would
    -- have hidden it). `SET col = DEFAULT` keeps this correct even if a default changes later.
    --
    -- daily_reminder_time is deliberately LEFT ALONE: NOT NULL with NO default, so there is
    -- nothing to reset it to. Notification preferences, fcm_token and user_offset are
    -- device/consent settings, not onboarding, and are also left.
    UPDATE public."user" SET
        onboarding_complete          = false,   -- explicit false, never NULL (see above)
        has_seen_mlp_intro           = false,
        has_seen_lesson_intro        = false,
        has_seen_questionnaire_intro = false,
        birth_date      = DEFAULT,              -- NOT NULL DEFAULT now()
        name            = DEFAULT,              -- DEFAULT ''::text
        display_name    = NULL,
        gender          = NULL,
        birth_month     = NULL,
        birth_year      = NULL,
        parenting_status = NULL,
        financials      = NULL,
        image_url       = NULL,
        image_blur_hash = NULL,
        phone           = NULL,
        region          = NULL
      WHERE id = p_user;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted || jsonb_build_object('user_onboarding_cleared', v_n);
  END IF;

  -- ---- 6. audit, same transaction ----------------------------------------------------------
  INSERT INTO public.test_account_events (user_id, action, actor_id, actor_role, detail)
  VALUES (p_user,
          'reset_' || p_depth,
          p_actor,
          coalesce((SELECT a.role FROM public."user" a WHERE a.id = p_actor), coalesce(auth.role(), 'service')),
          v_deleted);

  RETURN jsonb_build_object('found', true, 'depth', p_depth, 'deleted', v_deleted);
END $$;

REVOKE ALL ON FUNCTION public.reset_test_account(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_test_account(uuid, text, uuid) TO service_role;

-- ================================================================ (f) onboarding_complete NOT NULL
-- 0 NULLs on both projects (2026-11-17) and the column already DEFAULTs false, so only NOT NULL is
-- missing. With this, moosii-rn's `?? true` coercion becomes unreachable for existing rows.
ALTER TABLE public."user" ALTER COLUMN onboarding_complete SET NOT NULL;

-- ================================================================ (g) seed the first two flags
-- Runs as Mark in the SQL editor / psql, where auth.uid() IS NULL, so test_account_flag_guard
-- passes without a super_admin JWT (its documented no-JWT case). Guarded on `NOT is_test_account`
-- so a re-apply writes nothing and logs nothing.
DO $$
DECLARE
  v_emails text[] := ARRAY['markmun99@gmail.com','mdawnmunroe@gmail.com'];
  v_id     uuid;
  v_n      int := 0;
BEGIN
  FOR v_id IN SELECT u.id FROM public."user" u
               WHERE u.email = ANY(v_emails) AND NOT u.is_test_account
  LOOP
    UPDATE public."user" SET is_test_account = true WHERE id = v_id;
    INSERT INTO public.test_account_events (user_id, action, actor_id, actor_role, detail)
    VALUES (v_id, 'flag', NULL, 'migration', jsonb_build_object('source', 'migration_127'));
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE '127 SEED: flagged % account(s) this run', v_n;
END $$;

-- ================================================================ VERIFICATION
DO $$
DECLARE
  v_n int;
BEGIN
  -- (a) the column
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='user' AND column_name='is_test_account'
     AND is_nullable='NO' AND column_default='false';
  IF v_n <> 1 THEN RAISE EXCEPTION '127 VERIFY: is_test_account missing or not NOT NULL DEFAULT false'; END IF;

  -- the lock: no client may write it
  IF has_column_privilege('authenticated', 'public."user"', 'is_test_account', 'UPDATE') THEN
    RAISE EXCEPTION '127 VERIFY: authenticated can UPDATE is_test_account -- a grant leaked in';
  END IF;
  IF has_column_privilege('anon', 'public."user"', 'is_test_account', 'UPDATE') THEN
    RAISE EXCEPTION '127 VERIFY: anon can UPDATE is_test_account -- a grant leaked in';
  END IF;
  IF has_column_privilege('authenticated', 'public."user"', 'is_test_account', 'INSERT') THEN
    RAISE EXCEPTION '127 VERIFY: authenticated can INSERT is_test_account';
  END IF;

  -- (b) the trigger
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='test_account_flag_guard_trg'
                  AND tgrelid='public."user"'::regclass) THEN
    RAISE EXCEPTION '127 VERIFY: test_account_flag_guard_trg is missing';
  END IF;

  -- (c) the audit table: exists, RLS on, exactly one policy (SELECT), no client write grant
  IF to_regclass('public.test_account_events') IS NULL THEN
    RAISE EXCEPTION '127 VERIFY: test_account_events is missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.test_account_events'::regclass) THEN
    RAISE EXCEPTION '127 VERIFY: test_account_events does not have RLS enabled';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='test_account_events';
  IF v_n <> 1 THEN RAISE EXCEPTION '127 VERIFY: test_account_events has % policies, expected exactly 1', v_n; END IF;
  SELECT count(*) INTO v_n FROM information_schema.role_table_grants
   WHERE table_schema='public' AND table_name='test_account_events'
     AND grantee IN ('anon','authenticated')
     AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
  IF v_n <> 0 THEN RAISE EXCEPTION '127 VERIFY: test_account_events grants % write privilege(s) to a client role', v_n; END IF;

  -- (d)(e) the two RPCs: service_role only (094)
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.oid IN ('public.set_test_account(uuid,boolean,uuid)'::regprocedure,
                   'public.reset_test_account(uuid,text,uuid)'::regprocedure)
     AND has_function_privilege('service_role', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_n <> 2 THEN RAISE EXCEPTION '127 VERIFY: the two RPCs are not service_role-only (% of 2 correct)', v_n; END IF;

  -- both are SECURITY DEFINER with a pinned search_path
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.oid IN ('public.set_test_account(uuid,boolean,uuid)'::regprocedure,
                   'public.reset_test_account(uuid,text,uuid)'::regprocedure,
                   'public.test_account_flag_guard()'::regprocedure)
     AND p.prosecdef AND p.proconfig IS NOT NULL;
  IF v_n <> 3 THEN RAISE EXCEPTION '127 VERIFY: not all 3 functions are SECURITY DEFINER with search_path set'; END IF;

  -- (f) NOT NULL
  IF NOT (SELECT attnotnull FROM pg_attribute
           WHERE attrelid='public."user"'::regclass AND attname='onboarding_complete') THEN
    RAISE EXCEPTION '127 VERIFY: onboarding_complete is still nullable';
  END IF;

  -- (g) the seed: every flagged account is one of the two, and each has a flag event
  SELECT count(*) INTO v_n FROM public."user"
   WHERE is_test_account AND email <> ALL (ARRAY['markmun99@gmail.com','mdawnmunroe@gmail.com']);
  IF v_n <> 0 THEN RAISE EXCEPTION '127 VERIFY: % account(s) flagged outside the seed list', v_n; END IF;

  SELECT count(*) INTO v_n FROM public."user" u
   WHERE u.is_test_account
     AND NOT EXISTS (SELECT 1 FROM public.test_account_events e
                      WHERE e.user_id = u.id AND e.action = 'flag');
  IF v_n <> 0 THEN RAISE EXCEPTION '127 VERIFY: % flagged account(s) have no flag event', v_n; END IF;

  RAISE NOTICE '127 VERIFY OK: is_test_account ungranted + guarded, test_account_events RLS-on write-closed, both RPCs service_role-only, onboarding_complete NOT NULL, % account(s) flagged',
    (SELECT count(*) FROM public."user" WHERE is_test_account);
END $$;

COMMIT;
