#!/usr/bin/env bash
# Rebuild the throwaway PG17 harness, apply migration 127, and run its behaviour suite.
#
#   bash docs/drafts/127-test-accounts/run.sh
#
# Needs: PostgreSQL 17 client+server binaries, and MOOSII_DB_URL in .env for the schema dump
# (READ-ONLY: pg_dump --schema-only). Nothing touches either live project.
#
# Unlike the 126 harness, the behaviour suite is the NODE test file
# src/lib/__tests__/testAccounts.db.test.ts — it skips itself unless MOOSIE_TEST_DB_URL is set, and
# this script sets it to the cluster it just built. So the same assertions run here and in CI-with-a-DB.
#
# Traps this script encodes:
#   * pg_ctl start hangs unless stdout/stderr are redirected (-l).
#   * PGCLIENTENCODING=UTF8 or Windows psql reads the .sql files as a code page.
#   * the dump is NOT committed; it is regenerated each run.
#   * Supabase's ALTER DEFAULT PRIVILEGES go on AFTER the restore (defaults.sql), never in stubs.sql:
#     before the restore they grant ALL on every restored table and destroy fidelity. They must
#     exist, though, or 127's REVOKEs look unnecessary and its privilege VERIFY passes for the
#     wrong reason.
set -euo pipefail

BIN="${PGBIN:-/c/Program Files/PostgreSQL/17/bin}"
PORT="${PGPORT_TEST:-55433}"
WORK="${WORK:-$(mktemp -d)}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export PGCLIENTENCODING=UTF8
export PATH="$BIN:$PATH"

DBURL="$(grep -m1 '^MOOSII_DB_URL=' "$REPO/.env" | cut -d= -f2-)"
[ -n "$DBURL" ] || { echo "MOOSII_DB_URL not set in .env"; exit 1; }

echo "== 1. schema-only dump of Moosii (read-only) =="
pg_dump.exe "$DBURL" --schema-only --schema=public --no-owner --no-comments -f "$WORK/schema.sql"
wc -l "$WORK/schema.sql"

echo "== 2. throwaway cluster on $PORT =="
rm -rf "$WORK/data"
initdb.exe -D "$WORK/data" -U postgres -A trust -E UTF8 --no-locale > "$WORK/initdb.log" 2>&1
pg_ctl.exe -D "$WORK/data" -o "-p $PORT -c listen_addresses=localhost" -l "$WORK/server.log" start > "$WORK/pgctl.log" 2>&1
# KEEP=1 leaves the cluster running so the node suite can be re-run against it while iterating;
# otherwise it is stopped on exit.
if [ "${KEEP:-0}" != "1" ]; then
  trap 'pg_ctl.exe -D "$WORK/data" stop -m immediate >/dev/null 2>&1 || true' EXIT
fi
until pg_isready.exe -h localhost -p "$PORT" >/dev/null 2>&1; do :; done

T=(-w -h localhost -p "$PORT" -U postgres -d moosii_test)
createdb.exe -h localhost -p "$PORT" -U postgres moosii_test

echo "== 3. stubs + restore =="
psql.exe "${T[@]}" -q -v ON_ERROR_STOP=1 -f "$REPO/docs/drafts/127-test-accounts/stubs.sql"
psql.exe "${T[@]}" -q -f "$WORK/schema.sql" 2>&1 | grep -viE 'supabase_admin|already exists' | head -5 || true
# Supabase's default privileges go on AFTER the restore, so they apply only to what 127 creates.
psql.exe "${T[@]}" -q -v ON_ERROR_STOP=1 -f "$REPO/docs/drafts/127-test-accounts/defaults.sql"

echo "== 4. fidelity vs live =="
# The grants on "user" ARE the subject of this migration, so they are the fidelity gate. Live on
# both projects, 2026-11-17: authenticated holds NO table-level UPDATE/INSERT, column UPDATE on
# exactly 10 columns and column INSERT on exactly 4 (migration 112). If the restore does not
# reproduce that, 127's privilege VERIFY proves nothing and the run should be discarded.
psql.exe "${T[@]}" -A -F' | ' \
  -c "SELECT has_table_privilege('authenticated','public.\"user\"','UPDATE') AS auth_table_update_expect_f,
             has_table_privilege('authenticated','public.\"user\"','INSERT') AS auth_table_insert_expect_f;" \
  -c "SELECT privilege_type, count(*) AS cols FROM information_schema.column_privileges
       WHERE table_schema='public' AND table_name='user' AND grantee='authenticated'
         AND privilege_type IN ('INSERT','UPDATE') GROUP BY 1 ORDER BY 1;  -- expect INSERT 4, UPDATE 10" \
  -c "SELECT count(*) AS policies FROM pg_policies WHERE schemaname='public';" \
  -c "SELECT count(*) AS onboarding_nulls FROM public.\"user\" WHERE onboarding_complete IS NULL;  -- expect 0 (no rows restored)"

echo "== 5. apply migration 127 =="
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/127_test_accounts.sql" 2>&1 | sed -E 's#^psql:[^ ]+:[0-9]+: ##'

echo "== 6. re-apply, to prove the file IS re-runnable (127 is, unlike 126) =="
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/127_test_accounts.sql" 2>&1 | sed -E 's#^psql:[^ ]+:[0-9]+: ##' | grep -E 'VERIFY OK|SEED|ERROR' || true

echo "== 7. behaviour suite (the node DB tests, against this cluster) =="
cd "$REPO"
export MOOSIE_TEST_DB_URL="postgresql://postgres@localhost:$PORT/moosii_test"
echo "MOOSIE_TEST_DB_URL=$MOOSIE_TEST_DB_URL"
npx tsx --test src/lib/__tests__/testAccounts.db.test.ts > "$WORK/tests.out" 2>&1 || true
grep -E "^(. )?(tests|pass|fail|skipped) |^.(ok|not ok)|^â" "$WORK/tests.out" | tail -40 || true
echo "---- full output: $WORK/tests.out"
