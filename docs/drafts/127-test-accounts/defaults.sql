-- Supabase's ALTER DEFAULT PRIVILEGES, applied AFTER the schema restore (migration 127 harness).
--
-- WHY AFTER, and not in stubs.sql: these make every table/function created from now on arrive with
-- ALL / EXECUTE already granted to anon and authenticated -- the trap migration 094 documents and
-- the reason 127 must REVOKE on the objects it creates. Running them BEFORE the restore instead
-- grants ALL on every RESTORED table too, which destroys fidelity with live: the harness showed
-- `authenticated` holding table-level UPDATE on "user" and column grants on all 47 columns, where
-- live holds no table-level UPDATE and exactly 4 INSERT / 10 UPDATE columns (migration 112). The
-- run's own fidelity gate caught it, and 127's VERIFY then failed for the right reason.
--
-- So: restored tables keep the ACLs the dump carries; only NEW objects get Supabase's defaults.
\set ON_ERROR_STOP on

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
