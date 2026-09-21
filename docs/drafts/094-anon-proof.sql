-- 094 proof, SQL: what the anon / authenticated roles can do with the approval RPCs.
-- PostgREST runs an anon request as `SET ROLE anon`, so this is the same privilege check.
-- Everything is ROLLED BACK. Usage (PGCLIENTENCODING=UTF8):
--   psql "$DB" -X -At -v seg=<segment uuid with a linkable candidate per card> -f docs/drafts/094-anon-proof.sql
-- (no ON_ERROR_STOP: each refused call is caught and reported as a line.)

\set QUIET on
SELECT set_config('proof.seg', :'seg', false) IS NOT NULL AS s \gset

-- 1. Privilege table (read-only).
SELECT 'grant | ' || r.role || ' | ' || f.sig || ' | ' ||
       CASE WHEN has_function_privilege(r.role, f.oid, 'EXECUTE') THEN 'EXECUTE' ELSE 'denied' END
  FROM (VALUES ('anon'), ('authenticated'), ('service_role')) r(role),
       (SELECT oid, proname || '(' || pg_get_function_identity_arguments(oid) || ')' AS sig FROM pg_proc
         WHERE pronamespace = 'public'::regnamespace
           AND proname IN ('approve_content_image', 'approve_segment_bundle', 'recompute_seg_status')) f
 ORDER BY 1;

-- 2. IMPACT as anon: the cards of a real segment are editorial_reviewed; anon calls
--    approve_segment_bundle. Rolled back.
BEGIN;
UPDATE sub_segments SET review_state = 'editorial_reviewed' WHERE seg_id = current_setting('proof.seg')::uuid;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true) IS NOT NULL AS c \gset
DO $$
DECLARE r json;
BEGIN
  r := approve_segment_bundle(current_setting('proof.seg')::uuid, NULL, '[]'::jsonb);
  RAISE NOTICE 'anon approve_segment_bundle EXECUTED -> seg_status %', r->>'seg_status';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'anon approve_segment_bundle REFUSED (42501): %', SQLERRM;
END $$;
RESET ROLE;
SELECT 'anon impact | cards now: ' || string_agg(review_state || ' ' || n, ', ')
  FROM (SELECT review_state, count(*) n FROM sub_segments WHERE seg_id = current_setting('proof.seg')::uuid GROUP BY 1) x;
ROLLBACK;

-- 3. Each revoked function, as anon and as authenticated (random ids; rolled back).
BEGIN;
DO $$
DECLARE role_name text; z uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    EXECUTE format('SET LOCAL ROLE %I', role_name);
    BEGIN PERFORM recompute_seg_status(z);
      RAISE NOTICE '% recompute_seg_status EXECUTED', role_name;
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE '% recompute_seg_status REFUSED (42501)', role_name;
              WHEN OTHERS THEN RAISE NOTICE '% recompute_seg_status EXECUTED (then: %)', role_name, SQLERRM; END;
    BEGIN PERFORM approve_content_image(z, NULL, 'x', 'x');
      RAISE NOTICE '% approve_content_image/4 EXECUTED', role_name;
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE '% approve_content_image/4 REFUSED (42501)', role_name;
              WHEN OTHERS THEN RAISE NOTICE '% approve_content_image/4 EXECUTED (then: %)', role_name, SQLERRM; END;
    BEGIN PERFORM approve_content_image(z, NULL, 'x');
      RAISE NOTICE '% approve_content_image/3 EXECUTED', role_name;
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE '% approve_content_image/3 REFUSED (42501)', role_name;
              WHEN OTHERS THEN RAISE NOTICE '% approve_content_image/3 EXECUTED (then: %)', role_name, SQLERRM; END;
    BEGIN PERFORM approve_segment_bundle(z, NULL, '[]'::jsonb);
      RAISE NOTICE '% approve_segment_bundle EXECUTED', role_name;
    EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE '% approve_segment_bundle REFUSED (42501)', role_name;
              WHEN OTHERS THEN RAISE NOTICE '% approve_segment_bundle EXECUTED (then: %)', role_name, SQLERRM; END;
    RESET ROLE;
  END LOOP;
END $$;
ROLLBACK;

-- 4. Paths that must keep working after 094 (rolled back): the owner-run triggers still recompute
--    (a CMS-direct text edit as `authenticated` fires 066 → recompute_seg_status as owner), and the
--    service role can still approve.
BEGIN;
UPDATE sub_segments SET review_state = 'clinically_approved' WHERE seg_id = current_setting('proof.seg')::uuid;
SELECT recompute_seg_status(current_setting('proof.seg')::uuid) IS NOT NULL AS r \gset
SET LOCAL ROLE service_role;
SELECT 'service_role approve_segment_bundle -> ' || (approve_segment_bundle(current_setting('proof.seg')::uuid, NULL, '[]'::jsonb) ->> 'seg_status');
RESET ROLE;
SELECT u.id AS admin_id FROM "user" u WHERE u.role IN ('admin', 'super_admin') ORDER BY u.role, u.id LIMIT 1 \gset
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', :'admin_id')::text, true) IS NOT NULL AS c \gset
DO $$
DECLARE n integer;
BEGIN
  -- A CMS-direct text edit by an admin (RLS lets it through): 066's trigger runs as its owner and
  -- calls recompute_seg_status — that must not be refused after 094.
  UPDATE sub_segments SET content = content || ' '
   WHERE id = (SELECT id FROM sub_segments WHERE seg_id = current_setting('proof.seg')::uuid ORDER BY sequence LIMIT 1);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'admin (authenticated) CMS-style text edit: % row(s) updated, no permission error', n;
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'admin text edit REFUSED: %', SQLERRM;
END $$;
RESET ROLE;
SELECT 'after admin text edit | card1 ' || (SELECT review_state FROM sub_segments WHERE seg_id = current_setting('proof.seg')::uuid ORDER BY sequence LIMIT 1)
       || ', seg_status ' || seg_status FROM segments WHERE id = current_setting('proof.seg')::uuid;
ROLLBACK;
