-- Migration 126 behaviour suite. Run AFTER 126 on the harness. Every case is inside a transaction
-- that is rolled back, so the fixture survives and the cases do not interfere.
--
-- Two traps this suite had to learn the hard way, both PostgreSQL semantics rather than 126 bugs:
--   * `now()` is the TRANSACTION timestamp, so archiving the same row twice in one transaction sets
--     the IDENTICAL value -- IS NOT DISTINCT -- and is correctly treated as a no-op. Use
--     clock_timestamp() or separate rows.
--   * `request.jwt.claims` is NOT cleared by RESET ROLE. Every case clears it explicitly, or the
--     next "no JWT" case silently inherits the previous actor.
\set ON_ERROR_STOP on
\pset format unaligned
\pset fieldsep ' | '

\echo ==================== A. the shared rule: lesson_publish_blocker ====================
SELECT 'L1 clean'        AS lesson, coalesce(public.lesson_publish_blocker('cccccccc-0000-4000-8000-000000000001'),'(publishable)') AS blocker
UNION ALL SELECT 'L2 incomplete',   coalesce(public.lesson_publish_blocker('cccccccc-0000-4000-8000-000000000002'),'(publishable)')
UNION ALL SELECT 'L3 quiz pending', coalesce(public.lesson_publish_blocker('cccccccc-0000-4000-8000-000000000003'),'(publishable)')
UNION ALL SELECT 'L4 archived trk', coalesce(public.lesson_publish_blocker('cccccccc-0000-4000-8000-000000000004'),'(publishable)')
UNION ALL SELECT 'L5 no segment',   coalesce(public.lesson_publish_blocker('cccccccc-0000-4000-8000-000000000005'),'(publishable)')
UNION ALL SELECT 'L6 quiz ok',      coalesce(public.lesson_publish_blocker('cccccccc-0000-4000-8000-000000000006'),'(publishable)')
UNION ALL SELECT 'L7 legacy pub',   coalesce(public.lesson_publish_blocker('cccccccc-0000-4000-8000-000000000007'),'(publishable)')
UNION ALL SELECT 'unknown id',      coalesce(public.lesson_publish_blocker('00000000-0000-4000-8000-000000000000'),'(publishable)');

\echo
\echo ==================== B. capabilities ====================
SELECT u.role, u.can_publish, u.can_approve_clinical,
       public.user_can_publish(u.id)   AS may_publish,
       public.user_can_unpublish(u.id) AS may_unpublish
  FROM public."user" u WHERE u.id::text LIKE 'aaaaaaaa%' ORDER BY u.role, u.can_approve_clinical;
SELECT public.user_can_publish('00000000-0000-4000-8000-000000000000') AS unknown_user_may_publish;

\echo
\echo ==================== C. RPC path (service role, auth.uid() IS NULL) ====================
BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE r jsonb; h text; st text;
BEGIN
  BEGIN r := public.set_lesson_published('cccccccc-0000-4000-8000-000000000001', true, 'aaaaaaaa-0000-4000-8000-000000000001','super_admin');
        RAISE NOTICE 'C1 publish L1, super_admin          -> OK %', r;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'C1 publish L1, super_admin          -> UNEXPECTED REFUSAL % / %', st, h; END;

  BEGIN r := public.set_lesson_published('cccccccc-0000-4000-8000-000000000006', true, 'aaaaaaaa-0000-4000-8000-000000000001','super_admin');
        RAISE NOTICE 'C2 publish L6, approved quiz        -> OK %', r;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'C2 publish L6, approved quiz        -> UNEXPECTED REFUSAL % / %', st, h; END;

  BEGIN r := public.set_lesson_published('cccccccc-0000-4000-8000-000000000001', true, 'aaaaaaaa-0000-4000-8000-000000000002','admin');
        RAISE NOTICE 'C3 publish L1, plain admin          -> NOT REFUSED (BUG) %', r;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'C3 publish L1, plain admin          -> refused % / %', st, h; END;

  BEGIN r := public.set_lesson_published('cccccccc-0000-4000-8000-000000000001', true, 'aaaaaaaa-0000-4000-8000-000000000003','admin');
        RAISE NOTICE 'C4 publish L1, clinical-only admin  -> NOT REFUSED (BUG) %', r;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'C4 publish L1, clinical-only admin  -> refused % / %', st, h; END;

  BEGIN r := public.set_lesson_published('cccccccc-0000-4000-8000-000000000002', true, 'aaaaaaaa-0000-4000-8000-000000000001','super_admin');
        RAISE NOTICE 'C5 publish L2, incomplete segment   -> NOT REFUSED (BUG) %', r;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'C5 publish L2, incomplete segment   -> refused % / %', st, h; END;

  BEGIN r := public.set_lesson_published('cccccccc-0000-4000-8000-000000000005', true, 'aaaaaaaa-0000-4000-8000-000000000001','super_admin');
        RAISE NOTICE 'C6 publish L5, no segment           -> NOT REFUSED (BUG) %', r;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'C6 publish L5, no segment           -> refused % / %', st, h; END;

  BEGIN r := public.set_lesson_published('cccccccc-0000-4000-8000-000000000003', true, 'aaaaaaaa-0000-4000-8000-000000000001','super_admin');
        RAISE NOTICE 'C7 publish L3, pending quiz         -> NOT REFUSED (BUG) %', r;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'C7 publish L3, pending quiz         -> refused % / %', st, h; END;

  BEGIN r := public.set_lesson_published('cccccccc-0000-4000-8000-000000000004', true, 'aaaaaaaa-0000-4000-8000-000000000001','super_admin');
        RAISE NOTICE 'C8 publish L4, archived track       -> NOT REFUSED (BUG) %', r;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'C8 publish L4, archived track       -> refused % / %', st, h; END;

  BEGIN r := public.set_lesson_published('00000000-0000-4000-8000-000000000000', true, 'aaaaaaaa-0000-4000-8000-000000000001','super_admin');
        RAISE NOTICE 'C9 publish unknown id               -> % (expect found:false)', r;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'C9 publish unknown id               -> REFUSED (BUG) % / %', st, h; END;

  BEGIN r := public.set_lesson_published('cccccccc-0000-4000-8000-000000000001', true, NULL, NULL);
        RAISE NOTICE 'C10 publish, NULL actor             -> NOT REFUSED (BUG) %', r;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
        RAISE NOTICE 'C10 publish, NULL actor             -> refused % (invariant 7)', st; END;
END $$;
\echo '--- audit rows the happy paths wrote ---'
SELECT entity_type, action, left(actor_id::text,8) AS actor, actor_role FROM public.content_approvals
 WHERE entity_id::text LIKE 'cccccccc%' ORDER BY created_at;
ROLLBACK;

\echo
\echo ==================== D. unpublish ====================
BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE r jsonb; h text; st text;
BEGIN
  -- L7 is already published AND has a pending quiz: the shape of the 5 live Moosii rows.
  BEGIN r := public.set_lesson_published('cccccccc-0000-4000-8000-000000000007', false, 'aaaaaaaa-0000-4000-8000-000000000003','admin');
        RAISE NOTICE 'D1 unpublish L7, clinical-only      -> OK % (content NOT re-checked)', r;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'D1 unpublish L7, clinical-only      -> UNEXPECTED REFUSAL % / %', st, h; END;

  BEGIN r := public.set_lesson_published('cccccccc-0000-4000-8000-000000000007', false, 'aaaaaaaa-0000-4000-8000-000000000002','admin');
        RAISE NOTICE 'D2 unpublish L7, plain admin        -> NOT REFUSED (BUG) %', r;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'D2 unpublish L7, plain admin        -> refused % / %', st, h; END;

  BEGIN r := public.set_lesson_published('cccccccc-0000-4000-8000-000000000007', false, 'aaaaaaaa-0000-4000-8000-000000000001','super_admin');
        RAISE NOTICE 'D3 unpublish L7, super_admin        -> OK %', r;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'D3 unpublish L7, super_admin        -> UNEXPECTED REFUSAL % / %', st, h; END;
END $$;
ROLLBACK;

\echo
\echo ==================== E. CMS-direct path (the trigger, real auth.uid()) ====================
BEGIN;
DO $$
DECLARE h text; st text;
BEGIN
  BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        PERFORM set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000002","role":"authenticated"}',true);
        UPDATE public.lessons SET is_published = true WHERE id='cccccccc-0000-4000-8000-000000000001';
        RAISE NOTICE 'E1 direct publish L1, plain admin   -> NOT REFUSED (BUG)';
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'E1 direct publish L1, plain admin   -> refused % / %', st, h; END;
  RESET ROLE; PERFORM set_config('request.jwt.claims','',true);

  BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        PERFORM set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}',true);
        UPDATE public.lessons SET is_published = true WHERE id='cccccccc-0000-4000-8000-000000000002';
        RAISE NOTICE 'E2 direct publish L2, super_admin   -> NOT REFUSED (BUG)';
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'E2 direct publish L2, super_admin   -> refused % / %', st, h; END;
  RESET ROLE; PERFORM set_config('request.jwt.claims','',true);

  BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        PERFORM set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}',true);
        UPDATE public.lessons SET is_published = true WHERE id='cccccccc-0000-4000-8000-000000000001';
        RAISE NOTICE 'E3 direct publish L1, super_admin   -> OK (allowed, no audit row: that is the RPC''s job)';
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'E3 direct publish L1, super_admin   -> UNEXPECTED REFUSAL % / %', st, h; END;
  RESET ROLE; PERFORM set_config('request.jwt.claims','',true);

  BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        PERFORM set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000002","role":"authenticated"}',true);
        UPDATE public.lessons SET is_published = false WHERE id='cccccccc-0000-4000-8000-000000000002';
        RAISE NOTICE 'E4 no-op is_published, plain admin  -> OK (a non-transition is never gated)';
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'E4 no-op is_published, plain admin  -> UNEXPECTED REFUSAL % / %', st, h; END;
  RESET ROLE; PERFORM set_config('request.jwt.claims','',true);

  -- a no-JWT direct publish: capability is skipped, content is not
  BEGIN UPDATE public.lessons SET is_published = true WHERE id='cccccccc-0000-4000-8000-000000000003';
        RAISE NOTICE 'E5 direct publish L3, no JWT        -> NOT REFUSED (BUG)';
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'E5 direct publish L3, no JWT        -> refused % / % (content still enforced)', st, h; END;

  BEGIN UPDATE public.lessons SET is_published = true WHERE id='cccccccc-0000-4000-8000-000000000001';
        RAISE NOTICE 'E6 direct publish L1, no JWT        -> OK (capability skipped, content holds)';
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'E6 direct publish L1, no JWT        -> UNEXPECTED REFUSAL % / %', st, h; END;

  -- the INSERT hole: a lesson cannot be born published
  BEGIN INSERT INTO public.lessons (id, lesson_name, track_id, is_published)
        VALUES ('cccccccc-0000-4000-8000-0000000000ff','born published','bbbbbbbb-0000-4000-8000-000000000001',true);
        RAISE NOTICE 'E7 INSERT a published lesson        -> NOT REFUSED (BUG)';
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'E7 INSERT a published lesson        -> refused % / %', st, h; END;

  BEGIN INSERT INTO public.lessons (id, lesson_name, track_id)
        VALUES ('cccccccc-0000-4000-8000-0000000000fe','ordinary create','bbbbbbbb-0000-4000-8000-000000000001');
        RAISE NOTICE 'E8 ordinary INSERT (default false)  -> OK (creates unaffected)';
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'E8 ordinary INSERT (default false)  -> UNEXPECTED REFUSAL % / %', st, h; END;

  -- UNPUBLISH via the direct path (true->false with a real JWT). L7 is published and carries a
  -- pending quiz, so these also show that unpublish never re-checks content at the trigger either.
  BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        PERFORM set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000002","role":"authenticated"}',true);
        UPDATE public.lessons SET is_published = false WHERE id='cccccccc-0000-4000-8000-000000000007';
        RESET ROLE; PERFORM set_config('request.jwt.claims','',true);
        RAISE NOTICE 'E9 direct UNpublish L7, plain admin -> NOT REFUSED (BUG)';
  EXCEPTION WHEN others THEN RESET ROLE; PERFORM set_config('request.jwt.claims','',true);
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'E9 direct UNpublish L7, plain admin -> refused % / %', st, h; END;

  BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        PERFORM set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000003","role":"authenticated"}',true);
        UPDATE public.lessons SET is_published = false WHERE id='cccccccc-0000-4000-8000-000000000007';
        RESET ROLE; PERFORM set_config('request.jwt.claims','',true);
        RAISE NOTICE 'E10 direct UNpublish L7, clinical   -> OK (allowed, content not re-checked)';
  EXCEPTION WHEN others THEN RESET ROLE; PERFORM set_config('request.jwt.claims','',true);
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'E10 direct UNpublish L7, clinical   -> UNEXPECTED REFUSAL % / %', st, h; END;
END $$;
ROLLBACK;

\echo
\echo ==================== F. archival ====================
BEGIN;
DO $$
DECLARE h text; st text; n int;
BEGIN
  -- F1 super_admin archives a track
  BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        PERFORM set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}',true);
        UPDATE public.tracks SET archived_at = clock_timestamp() WHERE id='bbbbbbbb-0000-4000-8000-000000000001';
        RESET ROLE; PERFORM set_config('request.jwt.claims','',true);
        SELECT count(*) INTO n FROM public.content_approvals WHERE entity_id='bbbbbbbb-0000-4000-8000-000000000001' AND action='archive';
        RAISE NOTICE 'F1 archive track, super_admin       -> OK, % audit row(s)', n;
  EXCEPTION WHEN others THEN RESET ROLE; PERFORM set_config('request.jwt.claims','',true);
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'F1 archive track, super_admin       -> UNEXPECTED REFUSAL % / %', st, h; END;

  -- F2 plain admin archives a DIFFERENT track (same row + now() would be a no-op)
  BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        PERFORM set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000002","role":"authenticated"}',true);
        UPDATE public.tracks SET archived_at = clock_timestamp() WHERE id='bbbbbbbb-0000-4000-8000-000000000003';
        RESET ROLE; PERFORM set_config('request.jwt.claims','',true);
        RAISE NOTICE 'F2 archive track, plain admin       -> NOT REFUSED (BUG)';
  EXCEPTION WHEN others THEN RESET ROLE; PERFORM set_config('request.jwt.claims','',true);
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'F2 archive track, plain admin       -> refused % / %', st, h; END;

  -- F3 clinical-only admin archives a lesson -> archival is not a clinical power
  BEGIN EXECUTE 'SET LOCAL ROLE authenticated';
        PERFORM set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000003","role":"authenticated"}',true);
        UPDATE public.lessons SET archived_at = clock_timestamp() WHERE id='cccccccc-0000-4000-8000-000000000001';
        RESET ROLE; PERFORM set_config('request.jwt.claims','',true);
        RAISE NOTICE 'F3 archive lesson, clinical admin   -> NOT REFUSED (BUG)';
  EXCEPTION WHEN others THEN RESET ROLE; PERFORM set_config('request.jwt.claims','',true);
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'F3 archive lesson, clinical admin   -> refused % / %', st, h; END;

  -- F4 no JWT: allowed, audited with a NULL actor
  BEGIN UPDATE public.lessons SET archived_at = clock_timestamp() WHERE id='cccccccc-0000-4000-8000-000000000001';
        SELECT count(*) INTO n FROM public.content_approvals
         WHERE entity_id='cccccccc-0000-4000-8000-000000000001' AND action='archive' AND actor_id IS NULL;
        RAISE NOTICE 'F4 archive lesson, no JWT           -> OK, % audit row(s) with NULL actor', n;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'F4 archive lesson, no JWT           -> UNEXPECTED REFUSAL % / %', st, h; END;

  -- F5 unarchive is audited as 'unarchive'
  BEGIN UPDATE public.lessons SET archived_at = NULL WHERE id='cccccccc-0000-4000-8000-000000000001';
        SELECT count(*) INTO n FROM public.content_approvals
         WHERE entity_id='cccccccc-0000-4000-8000-000000000001' AND action='unarchive';
        RAISE NOTICE 'F5 unarchive lesson, no JWT         -> OK, % audit row(s)', n;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'F5 unarchive lesson, no JWT         -> UNEXPECTED REFUSAL % / %', st, h; END;

  -- F6 an UPDATE that does not touch archived_at writes nothing
  BEGIN SELECT count(*) INTO n FROM public.content_approvals WHERE action IN ('archive','unarchive');
        UPDATE public.lessons SET priority = 999 WHERE id='cccccccc-0000-4000-8000-000000000006';
        SELECT count(*) - n INTO n FROM public.content_approvals WHERE action IN ('archive','unarchive');
        RAISE NOTICE 'F6 unrelated lesson UPDATE          -> % new archive audit row(s) (expect 0)', n;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
        RAISE NOTICE 'F6 unrelated lesson UPDATE          -> ERROR %', st; END;

  -- F7 re-stamping the SAME archived_at value is a no-op, so not gated and not audited
  BEGIN SELECT count(*) INTO n FROM public.content_approvals WHERE action IN ('archive','unarchive');
        EXECUTE 'SET LOCAL ROLE authenticated';
        PERFORM set_config('request.jwt.claims','{"sub":"aaaaaaaa-0000-4000-8000-000000000002","role":"authenticated"}',true);
        UPDATE public.tracks SET archived_at = archived_at WHERE id='bbbbbbbb-0000-4000-8000-000000000002';
        RESET ROLE; PERFORM set_config('request.jwt.claims','',true);
        SELECT count(*) - n INTO n FROM public.content_approvals WHERE action IN ('archive','unarchive');
        RAISE NOTICE 'F7 re-stamp same archived_at, plain -> allowed, % new audit row(s) (expect 0)', n;
  EXCEPTION WHEN others THEN RESET ROLE; PERFORM set_config('request.jwt.claims','',true);
        GET STACKED DIAGNOSTICS h = PG_EXCEPTION_HINT, st = RETURNED_SQLSTATE;
        RAISE NOTICE 'F7 re-stamp same archived_at, plain -> refused % / %', st, h; END;
END $$;
\echo '--- archive audit rows written in this transaction ---'
SELECT entity_type, action, coalesce(left(actor_id::text,8),'(null)') AS actor, actor_role
  FROM public.content_approvals WHERE action IN ('archive','unarchive') ORDER BY created_at;
ROLLBACK;

\echo
\echo ==================== G. the content_approvals actor CHECK ====================
BEGIN;
DO $$
DECLARE st text;
BEGIN
  BEGIN INSERT INTO public.content_approvals (entity_type, entity_id, action, actor_id)
        VALUES ('lesson','cccccccc-0000-4000-8000-000000000001','archive',NULL);
        RAISE NOTICE 'G1 NULL actor on archive            -> accepted';
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
        RAISE NOTICE 'G1 NULL actor on archive            -> REJECTED % (BUG)', st; END;

  BEGIN INSERT INTO public.content_approvals (entity_type, entity_id, action, actor_id)
        VALUES ('lesson','cccccccc-0000-4000-8000-000000000001','publish',NULL);
        RAISE NOTICE 'G2 NULL actor on publish            -> ACCEPTED (BUG)';
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
        RAISE NOTICE 'G2 NULL actor on publish            -> rejected % (invariant 7 preserved)', st; END;

  BEGIN INSERT INTO public.content_approvals (entity_type, entity_id, action, actor_id)
        VALUES ('track','bbbbbbbb-0000-4000-8000-000000000001','archive',NULL);
        RAISE NOTICE 'G3 entity_type track                -> accepted';
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
        RAISE NOTICE 'G3 entity_type track                -> REJECTED % (BUG)', st; END;
END $$;
ROLLBACK;

\echo
\echo ==================== H. the role CHECK, the drops, the quiz default ====================
BEGIN;
DO $$
DECLARE st text;
BEGIN
  BEGIN UPDATE public."user" SET role='Admin' WHERE id='aaaaaaaa-0000-4000-8000-000000000002';
        RAISE NOTICE 'H1 role = ''Admin''                   -> ACCEPTED (BUG)';
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
        RAISE NOTICE 'H1 role = ''Admin''                   -> rejected %', st; END;
END $$;
ROLLBACK;
SELECT to_regclass('public.users_internal') IS NULL AS users_internal_dropped,
       NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='role' AND typnamespace='public'::regnamespace) AS role_type_dropped,
       (SELECT column_default FROM information_schema.columns
         WHERE table_schema='public' AND table_name='quiz_questions' AND column_name='answer_status') AS quiz_default,
       (SELECT count(*) FROM public."user" WHERE can_publish) AS users_with_can_publish;
