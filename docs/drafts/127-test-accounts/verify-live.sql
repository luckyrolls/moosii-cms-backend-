-- POST-APPLY verification for migration 127 — READ-ONLY, run on each project after its apply.
--
--   PGCLIENTENCODING=UTF8 psql "<MOOSII_DB_URL | FINANCIAL_DB_URL>" \
--     -f docs/drafts/127-test-accounts/verify-live.sql
--
-- Wrapped in BEGIN TRANSACTION READ ONLY … ROLLBACK, so it cannot write even by accident. Do NOT
-- use PGOPTIONS='-c default_transaction_read_only=on' — the Supabase pooler silently drops it and
-- the session comes back writable (observed 2026-11-17).
--
-- 127's own VERIFY block already RAISEd on every structural failure during the apply. This file is
-- the independent after-the-fact read: it re-checks the same guarantees from outside the
-- transaction that created them, and reports the per-project row counts that VERIFY only RAISEd a
-- NOTICE about.
BEGIN TRANSACTION READ ONLY;

\echo '===== 0. which project is this ====='
SELECT current_user AS usr,
       (pg_control_system()).system_identifier AS sysid,
       (SELECT value FROM public.app_settings WHERE key = 'domain') AS domain,
       current_setting('transaction_read_only') AS txn_read_only;   -- must be 'on'

\echo ''
\echo '===== 1. the flag: NOT NULL DEFAULT false, and UNGRANTED (expect f / f / f) ====='
SELECT a.attnotnull AS not_null,
       pg_get_expr(d.adbin, d.adrelid) AS default_expr,
       has_column_privilege('authenticated', 'public."user"', 'is_test_account', 'UPDATE') AS auth_update_expect_f,
       has_column_privilege('anon',          'public."user"', 'is_test_account', 'UPDATE') AS anon_update_expect_f,
       has_column_privilege('authenticated', 'public."user"', 'is_test_account', 'INSERT') AS auth_insert_expect_f
FROM pg_attribute a
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = 'public."user"'::regclass AND a.attname = 'is_test_account';

\echo ''
\echo '===== 1b. 112''s grants are intact (expect NO table INSERT/UPDATE; 4 INSERT / 10 UPDATE columns) ====='
-- UPDATE must still be 10 — exactly 112's list. is_test_account must NOT have joined it, so any
-- count above 10 means a grant leaked in; below 10 means something else was revoked.
SELECT has_table_privilege('authenticated', 'public."user"', 'UPDATE') AS table_update_expect_f,
       has_table_privilege('authenticated', 'public."user"', 'INSERT') AS table_insert_expect_f;
SELECT privilege_type, count(*) AS cols
FROM information_schema.column_privileges
WHERE table_schema = 'public' AND table_name = 'user' AND grantee = 'authenticated'
  AND privilege_type IN ('INSERT', 'UPDATE')
GROUP BY 1 ORDER BY 1;   -- expect INSERT 4, UPDATE 10

\echo ''
\echo '===== 2. the trigger exists and is column-scoped ====='
SELECT tgname, pg_get_triggerdef(oid) AS def
FROM pg_trigger
WHERE tgrelid = 'public."user"'::regclass AND NOT tgisinternal
ORDER BY tgname;

\echo ''
\echo '===== 3. the audit table: RLS on, exactly one SELECT policy, no client write grant ====='
SELECT c.relrowsecurity AS rls_on,
       (SELECT count(*) FROM pg_policies p
         WHERE p.schemaname='public' AND p.tablename='test_account_events') AS policies_expect_1,
       (SELECT count(*) FROM information_schema.role_table_grants g
         WHERE g.table_schema='public' AND g.table_name='test_account_events'
           AND g.grantee IN ('anon','authenticated')
           AND g.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')) AS client_writes_expect_0
FROM pg_class c WHERE c.oid = 'public.test_account_events'::regclass;

SELECT policyname, cmd, roles::text, qual
FROM pg_policies WHERE schemaname='public' AND tablename='test_account_events';

\echo ''
\echo '===== 4. the two RPCs + the trigger fn: SECURITY DEFINER, pinned search_path, service_role only ====='
SELECT p.oid::regprocedure AS fn,
       p.prosecdef AS security_definer,
       p.proconfig AS config,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') AS service_expect_t,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_expect_f,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_expect_f
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('set_test_account', 'reset_test_account', 'test_account_flag_guard')
ORDER BY p.proname;

\echo ''
\echo '===== 5. onboarding_complete is NOT NULL (expect t / false) ====='
SELECT a.attnotnull AS not_null_expect_t, pg_get_expr(d.adbin, d.adrelid) AS default_expr
FROM pg_attribute a
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = 'public."user"'::regclass AND a.attname = 'onboarding_complete';

\echo ''
\echo '===== 6. the seed: who is flagged, and every flagged account has a flag event ====='
-- financial expects 1 flagged, Moosii expects 2 (read-only pre-apply check, 2026-11-17).
-- Emails are deliberately NOT selected.
SELECT count(*) AS flagged FROM public."user" WHERE is_test_account;

SELECT count(*) AS flagged_outside_seed_expect_0
FROM public."user"
WHERE is_test_account
  AND email <> ALL (ARRAY['markmun99@gmail.com','mdawnmunroe@gmail.com']);

SELECT count(*) AS flagged_without_event_expect_0
FROM public."user" u
WHERE u.is_test_account
  AND NOT EXISTS (SELECT 1 FROM public.test_account_events e
                   WHERE e.user_id = u.id AND e.action = 'flag');

SELECT action, actor_role, count(*) AS rows
FROM public.test_account_events
GROUP BY 1, 2 ORDER BY 1, 2;

\echo ''
\echo '===== 7. NOTHING was reset by the apply (expect every count unchanged / non-zero as before) ====='
-- The migration flags accounts; it must never have called reset_test_account.
SELECT (SELECT count(*) FROM public.test_account_events WHERE action LIKE 'reset%') AS reset_events_expect_0,
       (SELECT count(*) FROM public.completed_items) AS completed_items,
       (SELECT count(*) FROM public.children)        AS children,
       (SELECT count(*) FROM public.user_facts)      AS user_facts,
       (SELECT sum(moosies) FROM public."user")      AS total_moosies;

ROLLBACK;
