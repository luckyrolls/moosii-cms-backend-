#!/usr/bin/env bash
# Rebuild the throwaway PG17 harness, apply 127 + 128, and run 128's behaviour suite.
#
#   bash docs/drafts/128-catalog-modes/run.sh
#
# Reuses the 127 harness's stubs.sql and defaults.sql — same cluster shape, same traps. 128 needs
# ROWS (a schema-only dump restores none), so fixture.sql goes on between 127 and 128: without it
# 128's PRE-CHECK rightly refuses, and the backfill would prove nothing.
#
# Port 55434, so it cannot collide with the 126 (55432) or 127 (55433) harnesses.
# KEEP=1 leaves the cluster running so the node suite can be re-run while iterating.
#
# Nine steps; step 9 rehearses the UNDO inside a transaction it rolls back, so the file that
# claims 128 is reversible is actually run against a database with 128 on it.
set -euo pipefail

BIN="${PGBIN:-/c/Program Files/PostgreSQL/17/bin}"
PORT="${PGPORT_TEST:-55434}"
WORK="${WORK:-$(mktemp -d)}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
D127="$REPO/docs/drafts/127-test-accounts"
D128="$REPO/docs/drafts/128-catalog-modes"
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
if [ "${KEEP:-0}" != "1" ]; then
  trap 'pg_ctl.exe -D "$WORK/data" stop -m immediate >/dev/null 2>&1 || true' EXIT
fi
until pg_isready.exe -h localhost -p "$PORT" >/dev/null 2>&1; do :; done

T=(-w -h localhost -p "$PORT" -U postgres -d moosii_test)
createdb.exe -h localhost -p "$PORT" -U postgres moosii_test

echo "== 3. stubs + restore (the 127 harness's, unchanged) =="
psql.exe "${T[@]}" -q -v ON_ERROR_STOP=1 -f "$D127/stubs.sql"
psql.exe "${T[@]}" -q -f "$WORK/schema.sql" 2>&1 | grep -viE 'supabase_admin|already exists' | head -5 || true
psql.exe "${T[@]}" -q -v ON_ERROR_STOP=1 -f "$D127/defaults.sql"

echo "== 4. apply 127 (128 builds on its grant/audit patterns and its domain row) =="
psql.exe "${T[@]}" -q -v ON_ERROR_STOP=1 -c "INSERT INTO public.app_settings (key, value) VALUES ('domain','moosii') ON CONFLICT (key) DO UPDATE SET value='moosii';"
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/127_test_accounts.sql" 2>&1 \
  | sed -E 's#^psql:[^ ]+:[0-9]+: ##' | grep -E 'VERIFY OK|ERROR' || true

echo "== 5. fixture (tracks + the questionnaire graph) =="
psql.exe "${T[@]}" -q -v ON_ERROR_STOP=1 -f "$D128/fixture.sql"
psql.exe "${T[@]}" -A -F' | ' -c "SELECT coalesce(created_by,'(null)') AS created_by, (archived_at IS NOT NULL) AS archived, count(*) FROM tracks GROUP BY 1,2 ORDER BY 1,2;"

echo "== 6. apply migration 128 =="
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/128_catalog_modes.sql" 2>&1 | sed -E 's#^psql:[^ ]+:[0-9]+: ##'

echo "== 7. re-apply, to prove the file is re-runnable =="
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/128_catalog_modes.sql" 2>&1 \
  | sed -E 's#^psql:[^ ]+:[0-9]+: ##' | grep -E 'VERIFY OK|BACKFILL|ERROR' || true

echo "== 8. behaviour suite =="
cd "$REPO"
export MOOSIE_TEST_DB_URL="postgresql://postgres@localhost:$PORT/moosii_test"
echo "MOOSIE_TEST_DB_URL=$MOOSIE_TEST_DB_URL"
npx tsx --test src/lib/__tests__/catalogModes.db.test.ts > "$WORK/tests.out" 2>&1 || true
tail -22 "$WORK/tests.out"
echo "---- full output: $WORK/tests.out"

echo "== 9. undo rehearsal (rolled back) =="
# The header claims 128 is reversible; this runs that claim. undo.sql ends in ROLLBACK, so the
# cluster is left exactly as step 8 found it and the suite above can be re-run unchanged.
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$D128/undo.sql" 2>&1   | sed -E 's#^psql:[^ ]+:[0-9]+: ##' | grep -E 'UNDO OK|ERROR|ROLLBACK' || true
