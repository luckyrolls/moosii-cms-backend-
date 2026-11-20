-- ONE rolled-back dry run of reset_test_account (migration 127), for the account :email at
-- depth :depth. Nothing persists.
--
--   PGCLIENTENCODING=UTF8 psql "$MOOSII_DB_URL" -A -F'|' --pset footer=off \
--     -v email=someone@example.com -v depth=activity \
--     -f docs/drafts/127-test-accounts/dryrun/dry.sql > out.txt
--   python docs/drafts/127-test-accounts/dryrun/cmp.py out.txt
--
-- THERE IS NO `COMMIT` IN THIS FILE, AND NONE MAY EVER BE ADDED. The reset runs inside
-- BEGIN … ROLLBACK; the before- and after-counts either side of it run inside
-- BEGIN TRANSACTION READ ONLY … ROLLBACK, which cannot write even by accident. If a statement
-- raises, ON_ERROR_STOP exits psql and the open transaction dies with the connection — still no
-- commit. Phase C re-counts everything from a transaction of its own, so the proof that nothing
-- persisted does not depend on the transaction that did the work.
--
-- Do NOT use PGOPTIONS='-c default_transaction_read_only=on': the Supabase pooler silently drops
-- it and the session comes back writable (observed 2026-11-17).
\set ON_ERROR_STOP on
-- EXPANDED output (one `column|value` line each) is what cmp.py parses. Changing this
-- breaks the comparison silently, so the two files have to stay in step.
\x on

-- Resolve the account and FREEZE its child ids. The frozen list is what makes a post-'full'
-- count comparable: at full depth the children rows are gone, so a live subquery would report 0
-- for every child-keyed table whether or not their rows were actually deleted.
-- No email is ever selected into the output.
SELECT u.id AS uid,
       (SELECT coalesce(array_agg(c.id)::text, '{}')
          FROM public.children c WHERE c.parent_id = u.id) AS kids
  FROM public."user" u WHERE u.email = :'email'
\gset

\echo '--- A. BEFORE (read-only transaction) ---'
BEGIN TRANSACTION READ ONLY;
\set phase 'before_ro'
\ir counts.sql
ROLLBACK;

\echo '--- B. the dry run: BEGIN / reset / re-count / ROLLBACK ---'
BEGIN;
\set phase 'in_txn_before'
\ir counts.sql

\echo '--- the call ---'
SELECT jsonb_pretty(public.reset_test_account(:'uid'::uuid, :'depth', :'uid'::uuid)) AS returned;

\set phase 'in_txn_after'
\ir counts.sql
ROLLBACK;

\echo '--- C. AFTER ROLLBACK (read-only transaction) ---'
BEGIN TRANSACTION READ ONLY;
\set phase 'after_rollback_ro'
\ir counts.sql
ROLLBACK;
