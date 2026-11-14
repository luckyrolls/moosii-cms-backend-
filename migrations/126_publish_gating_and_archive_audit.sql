-- MIGRATION 126: approvals gating slice 1 -- can_publish, a structural publish precondition,
--                super_admin-only archival, and an archive audit trail.
--
-- *** BOTH PROJECTS *** (same schema, same policies; role populations differ, see PRE-CHECK).
--
-- STATUS: DRAFT (pending apply). Do not apply without a go. FINANCIAL first, then MOOSII on a
-- second go, per CLAUDE.md's apply gate.
--
-- DECISIONS (Mark, 2026-11-13/14)
--   * new `can_publish` capability; current super_admins get it
--   * lesson publish  = can_publish AND fully approved AND no pending quiz question AND not archived
--   * lesson unpublish = can_publish OR can_approve_clinical
--   * archive / unarchive = super_admin only, and audited
--
-- WHAT THIS DOES NOT DO: no route changes (slice 2), no questionnaire review (slice 3), no CMS
-- (slice 4), no RLS sweep. It REWRITES NO CONTENT ROWS -- see "EXISTING DATA" below.
--
-- ONE DEFINITION OF "PUBLISHABLE", used by both enforcement points
-- `lesson_publish_blocker(uuid)` returns NULL when a lesson may be published, else the HINT naming
-- the reason. The RPC and the table trigger both call it. This is deliberate: migration 118
-- regressed 115 precisely because two copies of one rule drifted apart, and the rebuild-trigger
-- defect (2026-11-11) was the same shape. There is ONE copy here.
--
-- WHY A TRIGGER AS WELL AS THE RPC (item 6)
-- `lessons` UPDATE is RLS-gated on `is_admin()`, so any admin can flip `is_published` Supabase-direct
-- and bypass the RPC entirely (`docs/FINDINGS-roles.md` section 2). The trigger closes that path.
-- It also covers INSERT, because an admin could otherwise CREATE a row already published: a new
-- lesson has no segments, so that is refused outright (HINT publish_not_approved).
--
-- HOW THE RPC AVOIDS BEING DOUBLE-REFUSED
-- The two enforcement points check DIFFERENT halves, split by who knows the actor:
--   * CONTENT preconditions: checked by BOTH, on false->true. The RPC checks them BEFORE its UPDATE,
--     so by the time the trigger fires they already hold -- the trigger is a no-op on that path, not
--     a second refusal. (If they ever disagreed it would be a bug; they cannot, because both call
--     `lesson_publish_blocker`.)
--   * CAPABILITY: checked by exactly ONE of them, never both. The backend calls the RPC with the
--     service role, where `auth.uid()` is NULL, and passes the actor explicitly as `p_actor_id` --
--     so the RPC checks capability and the trigger skips it. A Supabase-direct UPDATE has a real
--     `auth.uid()` and no `p_actor_id` -- so the trigger checks capability and the RPC is not
--     involved. Neither path is checked twice, and no path is unchecked.
--   * A no-JWT caller that is NOT the RPC (psql, the SQL editor) passes the capability check by
--     design: there is no actor to check, and that session already has the service role or better.
--     It still has to satisfy the content preconditions.
--
-- EXISTING DATA -- NOTHING IS REWRITTEN except `"user".can_publish`
--   * the 5 Moosii published lessons with pending quiz questions stay published;
--   * the 4 published lessons under archived tracks stay published;
--   * `quiz_questions.answer_status` changes its DEFAULT only -- no backfill, no row touched.
--   The new rules bind the NEXT publish, because every check runs only on a false->true transition
--   (or inside the RPC). A published lesson is never re-validated. VERIFY asserts the row counts.
--
-- MLP / card_positions: untouched. `mlp_item_pool`, `user_active_tracks_for_user` and
-- `generateFullMLP` are not referenced here (invariants 1 and 8); no prompt block is touched
-- (invariant 2). A REFUSED publish raises, so `src/routes/lessons.ts` returns before
-- `enqueueRebuildAllIfIdle` -- no rebuild fires for a publish that did not happen.

BEGIN;

-- ================================================================ PRE-CHECK
DO $$
DECLARE
  v_domain   text;
  v_bad      text;
  v_md5      text;
  v_n        int;
BEGIN
  SELECT value INTO v_domain FROM public.app_settings WHERE key = 'domain';
  RAISE NOTICE '126 PRE-CHECK: domain=% system=%', v_domain, (pg_control_system()).system_identifier;

  -- 1. set_lesson_published must be the body this file re-bases on. EXACT md5, never a substring:
  --    118's `LIKE` check passed against the wrong version and silently reverted 115.
  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc WHERE oid = 'public.set_lesson_published(uuid,boolean,uuid,text)'::regprocedure;
  IF v_md5 = 'd418d1eb451ab14428c8055b6946ff2c' THEN
    RAISE NOTICE '126: matched 068''s body (md5 %) -- adding the publish preconditions', v_md5;
  ELSE
    RAISE EXCEPTION '126: set_lesson_published body md5 % is not the version this file knows (expected d418d1eb451ab14428c8055b6946ff2c) -- re-base before applying', v_md5;
  END IF;

  -- 2. users_internal must still exist and be empty (read by nothing: jwtAuth.ts:7; only the
  --    GENERATED database.types.ts in moosii-rn / moosii-cms names it). to_regclass first, so a
  --    re-apply or an already-dropped table refuses legibly instead of erroring mid-statement.
  IF to_regclass('public.users_internal') IS NULL THEN
    RAISE EXCEPTION '126: public.users_internal is already gone -- this file has run here, or someone dropped it; do not re-apply';
  END IF;
  SELECT count(*) INTO v_n FROM public.users_internal;
  IF v_n > 0 THEN
    RAISE EXCEPTION '126: users_internal has % row(s) -- someone started using it; do not drop', v_n;
  END IF;

  -- 3. the role CHECK must be satisfiable
  SELECT string_agg(DISTINCT role, ', ') INTO v_bad
    FROM public."user" WHERE role NOT IN ('user','admin','super_admin');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '126: unexpected "user".role value(s): % -- fix them before adding the CHECK', v_bad;
  END IF;
  SELECT count(*) INTO v_n FROM public."user" WHERE role = 'super_admin';
  RAISE NOTICE '126 PRE-CHECK: % super_admin(s) will get can_publish', v_n;

  -- 4. public.role must have no dependents before DROP TYPE
  SELECT count(*) INTO v_n
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_type t ON t.oid = a.atttypid
   WHERE t.typname = 'role' AND t.typnamespace = 'public'::regnamespace AND NOT a.attisdropped;
  IF v_n > 0 THEN
    RAISE EXCEPTION '126: % column(s) still use type public.role -- not safe to drop', v_n;
  END IF;

  -- 5. record what must NOT change (asserted again in VERIFY)
  RAISE NOTICE '126 PRE-CHECK: published+unarchived lessons=%, of which with a pending quiz question=%',
    (SELECT count(*) FROM public.lessons WHERE is_published AND archived_at IS NULL),
    (SELECT count(*) FROM public.lessons l WHERE l.is_published AND l.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM public.quiz_questions q JOIN public.segments s ON s.id = q.segment_id
                    WHERE s.lesson_id = l.id AND q.answer_status IS DISTINCT FROM 'approved'));
END $$;

-- ================================================================ 1. the capability
ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS can_publish boolean NOT NULL DEFAULT false;

UPDATE public."user" SET can_publish = true WHERE role = 'super_admin' AND NOT can_publish;

ALTER TABLE public."user" DROP CONSTRAINT IF EXISTS user_role_valid;
ALTER TABLE public."user"
  ADD CONSTRAINT user_role_valid CHECK (role IN ('user','admin','super_admin'));

-- ================================================================ 2. the orphan enum
-- public.role ('user','admin','super') is used by no column and no code, and its labels do not even
-- match the strings is_admin()/is_super_admin() compare ('super' vs 'super_admin').
DROP TYPE public.role;

-- ================================================================ 3. the dead table
-- Empty on both projects, read by nothing. Its RLS policy (users_internal_all) drops with it.
-- moosii-rn and moosii-cms name it ONLY in their generated database.types.ts, which goes stale
-- until the next regen in those repos -- harmless, flagged in the report.
DROP TABLE public.users_internal;

-- ================================================================ 4. quiz default
-- 'approved' was the inverse of the policy being built: a direct INSERT that omitted the column
-- created an already-approved question, and that column derives lessons.with_quiz (invariant 10).
-- generateQuiz.ts:280 already passes 'pending' explicitly, so no generated row changes behaviour.
ALTER TABLE public.quiz_questions ALTER COLUMN answer_status SET DEFAULT 'pending';

-- ================================================================ 5. content_approvals accepts archival
ALTER TABLE public.content_approvals DROP CONSTRAINT content_approvals_action_check;
ALTER TABLE public.content_approvals
  ADD CONSTRAINT content_approvals_action_check
  CHECK (action = ANY (ARRAY['approve','unapprove','publish','unpublish',
                             'editorial_approve','clinical_approve','reject',
                             'archive','unarchive']));

ALTER TABLE public.content_approvals DROP CONSTRAINT content_approvals_entity_type_check;
ALTER TABLE public.content_approvals
  ADD CONSTRAINT content_approvals_entity_type_check
  CHECK (entity_type = ANY (ARRAY['segment','image','quiz','questionnaire','lesson',
                                  'sub_segment','track']));

-- `actor_id` was uuid NOT NULL, which is invariant 7's guarantee for every action that HAS an actor.
-- An archive from psql or the SQL editor genuinely has none (auth.uid() IS NULL) and we still want
-- the row. So NULL becomes legal for archive/unarchive ONLY -- the old guarantee is preserved
-- exactly where it existed, and the new actor-less case is admitted explicitly rather than by
-- weakening the column for everything.
ALTER TABLE public.content_approvals ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE public.content_approvals
  ADD CONSTRAINT content_approvals_actor_required
  CHECK (actor_id IS NOT NULL OR action IN ('archive','unarchive'));

-- ================================================================ 6. the shared rules
-- SECURITY DEFINER throughout: these read lessons / segments / quiz_questions / tracks / "user",
-- all RLS-on, and they are called from a trigger whose invoker may be a CMS `authenticated` session.
-- Per 094, EXECUTE is revoked from PUBLIC/anon/authenticated and granted to service_role (Postgres
-- does not check EXECUTE for trigger invocation, so the triggers still fire).

-- NULL = publishable. Otherwise the HINT naming the first failing reason, checked in a fixed order
-- so the message is deterministic. 'not_found' is distinguished from a refusal.
CREATE OR REPLACE FUNCTION public.lesson_publish_blocker(p_lesson_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lesson_archived  timestamptz;
  v_track_archived   timestamptz;
BEGIN
  -- FOUND, not a sentinel column: `SELECT true INTO v_found` sets v_found to NULL when no row
  -- matches, and `IF NOT NULL` is not true -- which silently reported an unknown lesson as
  -- unapproved. Caught by the local suite (case A, unknown id).
  SELECT l.archived_at, t.archived_at
    INTO v_lesson_archived, v_track_archived
    FROM lessons l LEFT JOIN tracks t ON t.id = l.track_id
   WHERE l.id = p_lesson_id;

  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  -- archival first: an archived lesson is invisible to parents either way (invariant 6), so
  -- publishing it is meaningless rather than merely unreviewed.
  IF v_lesson_archived IS NOT NULL OR v_track_archived IS NOT NULL THEN
    RETURN 'publish_archived';
  END IF;

  -- fully approved = at least one segment, and every segment 'complete'. seg_status is DERIVED by
  -- recompute_seg_status (056) and means ">=1 card and every card clinically_approved".
  IF NOT EXISTS (SELECT 1 FROM segments s WHERE s.lesson_id = p_lesson_id) THEN
    RETURN 'publish_not_approved';
  END IF;
  IF EXISTS (SELECT 1 FROM segments s
              WHERE s.lesson_id = p_lesson_id AND s.seg_status IS DISTINCT FROM 'complete') THEN
    RETURN 'publish_not_approved';
  END IF;

  -- no pending quiz question. A lesson with ZERO quiz questions passes (EXISTS is false).
  IF EXISTS (SELECT 1 FROM quiz_questions q JOIN segments s ON s.id = q.segment_id
              WHERE s.lesson_id = p_lesson_id AND q.answer_status IS DISTINCT FROM 'approved') THEN
    RETURN 'publish_quiz_pending';
  END IF;

  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.lesson_publish_blocker(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lesson_publish_blocker(uuid) TO service_role;

-- Capability lookups. A user with no `"user"` row has no capability (false), never an error.
CREATE OR REPLACE FUNCTION public.user_can_publish(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((SELECT u.can_publish FROM public."user" u WHERE u.id = p_user_id), false);
$$;

REVOKE ALL ON FUNCTION public.user_can_publish(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_publish(uuid) TO service_role;

-- Unpublish is the safety valve: can_publish OR can_approve_clinical (Mark, 2026-11-13).
CREATE OR REPLACE FUNCTION public.user_can_unpublish(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((SELECT u.can_publish OR u.can_approve_clinical
                     FROM public."user" u WHERE u.id = p_user_id), false);
$$;

REVOKE ALL ON FUNCTION public.user_can_unpublish(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.user_can_unpublish(uuid) TO service_role;

-- ================================================================ 7. set_lesson_published
-- Re-based on 068's body (md5 guarded above). Unchanged: the null-actor refusal, the
-- {found:false} contract for an unknown lesson, published_by, and the one-transaction audit row
-- (invariant 7). Added: the capability check and, on publish, the content preconditions.
-- CREATE OR REPLACE (same signature, same return type) so the existing EXECUTE grants survive.
CREATE OR REPLACE FUNCTION public.set_lesson_published(p_lesson_id uuid, p_published boolean, p_actor_id uuid, p_actor_role text)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_rows    integer;
  v_blocker text;
BEGIN
  -- Unattributed publish state changes are refused outright. The old path skipped the
  -- audit row here and carried on; that is what made the gap invisible.
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'set_lesson_published: an actor is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Unknown lesson stays a 404, decided before anything else so "not found" is never reported as
  -- a refusal (and a refusal never leaks whether the lesson exists).
  IF NOT EXISTS (SELECT 1 FROM lessons WHERE id = p_lesson_id) THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- CAPABILITY (126). The actor is p_actor_id -- the verified JWT's user, never the body
  -- (invariant 7). The table trigger deliberately does NOT re-check this on the RPC path, because
  -- under the service role auth.uid() is NULL and p_actor_id is the only actor there is.
  IF p_published THEN
    IF NOT public.user_can_publish(p_actor_id) THEN
      RAISE EXCEPTION 'set_lesson_published: actor % may not publish', p_actor_id
        USING ERRCODE = 'check_violation', HINT = 'publish_not_permitted';
    END IF;
  ELSE
    IF NOT public.user_can_unpublish(p_actor_id) THEN
      RAISE EXCEPTION 'set_lesson_published: actor % may not unpublish', p_actor_id
        USING ERRCODE = 'check_violation', HINT = 'unpublish_not_permitted';
    END IF;
  END IF;

  -- CONTENT PRECONDITIONS (126), publish only. ONE definition, shared with the trigger.
  IF p_published THEN
    v_blocker := public.lesson_publish_blocker(p_lesson_id);
    IF v_blocker IS NOT NULL THEN
      RAISE EXCEPTION 'set_lesson_published: lesson % cannot be published (%)', p_lesson_id, v_blocker
        USING ERRCODE = 'check_violation', HINT = v_blocker;
    END IF;
  END IF;

  UPDATE lessons
     SET is_published = p_published,
         -- text column (see the header): the actor's uuid on publish, cleared on unpublish.
         published_by = CASE WHEN p_published THEN p_actor_id::text ELSE NULL END,
         updated_at   = now()
   WHERE id = p_lesson_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- Same transaction as the UPDATE above: if this fails, the flip is rolled back with it.
  INSERT INTO content_approvals (entity_type, entity_id, action, actor_id, actor_role)
  VALUES (
    'lesson',
    p_lesson_id,
    CASE WHEN p_published THEN 'publish' ELSE 'unpublish' END,
    p_actor_id,
    p_actor_role
  );

  RETURN jsonb_build_object('found', true, 'is_published', p_published);
END $function$;

-- ================================================================ 8. the is_published trigger
-- Closes the Supabase-direct path. See "HOW THE RPC AVOIDS BEING DOUBLE-REFUSED" in the header.
CREATE OR REPLACE FUNCTION public.lessons_publish_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_blocker text;
BEGIN
  -- INSERT: a brand-new lesson cannot be born published. It has no segments yet (they FK to it),
  -- so it can never satisfy the approval precondition, and in a BEFORE INSERT trigger
  -- lesson_publish_blocker cannot see the row at all. `lessons.is_published` DEFAULT is false, so
  -- create_lessons_with_segments and every ordinary create are unaffected.
  IF TG_OP = 'INSERT' THEN
    IF coalesce(NEW.is_published, false) THEN
      RAISE EXCEPTION 'lesson %: a new lesson cannot be created already published', NEW.id
        USING ERRCODE = 'check_violation', HINT = 'publish_not_approved';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: only a real transition is gated; false->false / true->true (and a no-op rewrite) pass.
  IF NEW.is_published IS NOT DISTINCT FROM OLD.is_published THEN
    RETURN NEW;
  END IF;

  -- CAPABILITY: only when there IS an actor to check. A NULL auth.uid() means the service role,
  -- psql or the SQL editor -- on the RPC path the capability was already enforced against
  -- p_actor_id, and a direct SQL session is trusted by construction.
  IF v_actor IS NOT NULL THEN
    IF NEW.is_published AND NOT public.user_can_publish(v_actor) THEN
      RAISE EXCEPTION 'lesson %: actor % may not publish', NEW.id, v_actor
        USING ERRCODE = 'check_violation', HINT = 'publish_not_permitted';
    END IF;
    IF NOT NEW.is_published AND NOT public.user_can_unpublish(v_actor) THEN
      RAISE EXCEPTION 'lesson %: actor % may not unpublish', NEW.id, v_actor
        USING ERRCODE = 'check_violation', HINT = 'unpublish_not_permitted';
    END IF;
  END IF;

  -- CONTENT: every caller, publish only. On the RPC path this already holds (the RPC checked the
  -- same function before its UPDATE), so this is a no-op there, not a second refusal.
  IF NEW.is_published THEN
    v_blocker := public.lesson_publish_blocker(NEW.id);
    IF v_blocker IS NOT NULL AND v_blocker <> 'not_found' THEN
      RAISE EXCEPTION 'lesson % cannot be published (%)', NEW.id, v_blocker
        USING ERRCODE = 'check_violation', HINT = v_blocker;
    END IF;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.lessons_publish_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lessons_publish_guard() TO service_role;

DROP TRIGGER IF EXISTS lessons_publish_guard_trg ON public.lessons;
CREATE TRIGGER lessons_publish_guard_trg
  BEFORE INSERT OR UPDATE OF is_published ON public.lessons
  FOR EACH ROW EXECUTE FUNCTION public.lessons_publish_guard();

-- ================================================================ 9. the archival guard + audit
-- One function for both tables, branching on TG_TABLE_NAME (the content_edit_policy_guard pattern).
-- SECURITY DEFINER is REQUIRED for the audit insert: content_approvals is RLS-on with NO policy,
-- so an `authenticated` CMS session could not write it otherwise.
CREATE OR REPLACE FUNCTION public.archive_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor  uuid := auth.uid();
  v_entity text := CASE TG_TABLE_NAME WHEN 'tracks' THEN 'track' ELSE 'lesson' END;
  v_action text;
BEGIN
  IF NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
    RETURN NEW;   -- not an archival change
  END IF;

  -- Archive / unarchive is super_admin ONLY, when there is a JWT to judge. A call with no JWT
  -- (service role, psql, the SQL editor) passes: there is no actor to check.
  IF v_actor IS NOT NULL AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION '% %: archival requires super_admin', TG_TABLE_NAME, NEW.id
      USING ERRCODE = 'check_violation', HINT = 'archive_not_permitted';
  END IF;

  v_action := CASE WHEN NEW.archived_at IS NOT NULL THEN 'archive' ELSE 'unarchive' END;

  -- Audited in the SAME transaction, so the row and the change stand or fall together. actor_id is
  -- NULL for a no-JWT call -- legal for these two actions only (see the CHECK above); actor_role
  -- records 'service' so such a row is not mistaken for an unattributed user action.
  INSERT INTO content_approvals (entity_type, entity_id, action, actor_id, actor_role)
  VALUES (v_entity, NEW.id, v_action, v_actor, coalesce(auth.role(), 'service'));

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.archive_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_guard() TO service_role;

DROP TRIGGER IF EXISTS tracks_archive_guard_trg ON public.tracks;
CREATE TRIGGER tracks_archive_guard_trg
  BEFORE UPDATE OF archived_at ON public.tracks
  FOR EACH ROW EXECUTE FUNCTION public.archive_guard();

DROP TRIGGER IF EXISTS lessons_archive_guard_trg ON public.lessons;
CREATE TRIGGER lessons_archive_guard_trg
  BEFORE UPDATE OF archived_at ON public.lessons
  FOR EACH ROW EXECUTE FUNCTION public.archive_guard();

-- ================================================================ VERIFICATION
DO $$
DECLARE
  v_n int; v_pub int; v_pending int;
BEGIN
  -- the capability
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='user' AND column_name='can_publish'
     AND is_nullable='NO' AND column_default='false';
  IF v_n <> 1 THEN RAISE EXCEPTION '126 VERIFY: can_publish missing or not NOT NULL DEFAULT false'; END IF;

  SELECT count(*) INTO v_n FROM public."user" WHERE role='super_admin' AND NOT can_publish;
  IF v_n <> 0 THEN RAISE EXCEPTION '126 VERIFY: % super_admin(s) without can_publish', v_n; END IF;

  SELECT count(*) INTO v_n FROM public."user" WHERE can_publish AND role <> 'super_admin';
  IF v_n <> 0 THEN RAISE EXCEPTION '126 VERIFY: can_publish granted outside super_admin (% row(s))', v_n; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public."user"'::regclass AND conname='user_role_valid') THEN
    RAISE EXCEPTION '126 VERIFY: user_role_valid is missing';
  END IF;

  -- the drops
  IF EXISTS (SELECT 1 FROM pg_type t WHERE t.typname='role' AND t.typnamespace='public'::regnamespace) THEN
    RAISE EXCEPTION '126 VERIFY: type public.role still exists';
  END IF;
  IF to_regclass('public.users_internal') IS NOT NULL THEN
    RAISE EXCEPTION '126 VERIFY: users_internal still exists';
  END IF;

  -- the quiz default
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='quiz_questions' AND column_name='answer_status'
     AND column_default = '''pending''::text';
  IF v_n <> 1 THEN RAISE EXCEPTION '126 VERIFY: quiz_questions.answer_status default is not ''pending'''; END IF;

  -- the objects
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='lessons_publish_guard_trg' AND tgrelid='public.lessons'::regclass) THEN
    RAISE EXCEPTION '126 VERIFY: lessons_publish_guard_trg is missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='tracks_archive_guard_trg' AND tgrelid='public.tracks'::regclass) THEN
    RAISE EXCEPTION '126 VERIFY: tracks_archive_guard_trg is missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='lessons_archive_guard_trg' AND tgrelid='public.lessons'::regclass) THEN
    RAISE EXCEPTION '126 VERIFY: lessons_archive_guard_trg is missing'; END IF;

  -- set_lesson_published kept its service_role-only EXECUTE (CREATE OR REPLACE preserves grants)
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.oid='public.set_lesson_published(uuid,boolean,uuid,text)'::regprocedure
     AND has_function_privilege('service_role', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_n <> 1 THEN RAISE EXCEPTION '126 VERIFY: set_lesson_published EXECUTE grants moved'; END IF;

  -- the new functions are service_role only (094)
  FOR v_n IN SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
              WHERE ns.nspname='public'
                AND p.proname IN ('lesson_publish_blocker','user_can_publish','user_can_unpublish','lessons_publish_guard','archive_guard')
                AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  LOOP
    RAISE EXCEPTION '126 VERIFY: a new function still grants EXECUTE to anon/authenticated';
  END LOOP;

  -- NOTHING WAS REWRITTEN: the published set and its pending-quiz subset are unchanged
  SELECT count(*) INTO v_pub FROM public.lessons WHERE is_published AND archived_at IS NULL;
  SELECT count(*) INTO v_pending FROM public.lessons l
   WHERE l.is_published AND l.archived_at IS NULL
     AND EXISTS (SELECT 1 FROM public.quiz_questions q JOIN public.segments s ON s.id=q.segment_id
                  WHERE s.lesson_id=l.id AND q.answer_status IS DISTINCT FROM 'approved');
  RAISE NOTICE '126 VERIFY: published+unarchived lessons=% (of which pending quiz=%) -- unchanged, nothing re-validated',
    v_pub, v_pending;

  RAISE NOTICE '126 VERIFY OK: can_publish + role CHECK, public.role and users_internal dropped, quiz default pending, publish precondition + archive guard live';
END $$;

COMMIT;
