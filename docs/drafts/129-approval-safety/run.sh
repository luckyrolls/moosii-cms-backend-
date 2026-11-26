#!/usr/bin/env bash
# Rebuild the throwaway PG17 harness, apply 127 + 128 + 129, and run 129's behaviour suite.
#
#   bash docs/drafts/129-approval-safety/run.sh
#
# Reuses the 127 harness's stubs.sql/defaults.sql. It does NOT apply 127 or 128: both are already
# applied on live Moosii, so a schema-only dump taken today ALREADY CARRIES their objects —
# tracks.test_group and its insert-default trigger included. Re-applying 128 against such a dump
# FAILS ("4 track(s) outside the active mode are still active"), because the trigger has already
# supplied test_group on every fixture row and the backfill then matches nothing. That is a
# property of this harness family now that 128 is live, not a defect in 128.
#
# Port 55435, so it cannot collide with the 126 (55432), 127 (55433) or 128 (55434) harnesses.
# KEEP=1 leaves the cluster running so the node suite can be re-run while iterating.
#
# Step 8 applies 129 a SECOND time, which must fail: its PRE-CHECK guards on the md5 of the
# pre-129 recompute_seg_status, so a re-run is correctly refused. That refusal IS the proof the
# guard works — 118 silently reverted 115 for three days because its guard was a substring two
# different bodies both satisfied.
set -euo pipefail

BIN="${PGBIN:-/c/Program Files/PostgreSQL/17/bin}"
PORT="${PGPORT_TEST:-55435}"
WORK="${WORK:-$(mktemp -d)}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
D127="$REPO/docs/drafts/127-test-accounts"
D129="$REPO/docs/drafts/129-approval-safety"
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
# pg_ctl HANGS unless its stdout/stderr are redirected (CLAUDE.md migration traps).
pg_ctl.exe -D "$WORK/data" -o "-p $PORT -c listen_addresses=localhost" -l "$WORK/server.log" start > "$WORK/pgctl.log" 2>&1
if [ "${KEEP:-0}" != "1" ]; then
  trap 'pg_ctl.exe -D "$WORK/data" stop -m immediate >/dev/null 2>&1 || true' EXIT
fi
until pg_isready.exe -h localhost -p "$PORT" >/dev/null 2>&1; do :; done

T=(-w -h localhost -p "$PORT" -U postgres -d moosii_test)
createdb.exe -h localhost -p "$PORT" -U postgres moosii_test

echo "== 3. stubs + restore + defaults (the 127 harness's, unchanged) =="
psql.exe "${T[@]}" -q -v ON_ERROR_STOP=1 -f "$D127/stubs.sql"
psql.exe "${T[@]}" -q -f "$WORK/schema.sql" 2>&1 | grep -viE 'supabase_admin|already exists' | head -5 || true
psql.exe "${T[@]}" -q -v ON_ERROR_STOP=1 -f "$D127/defaults.sql"

echo "== 4. the domain row; confirm 056/127/128 arrived with the dump =="
psql.exe "${T[@]}" -q -v ON_ERROR_STOP=1 -c "INSERT INTO public.app_settings (key, value) VALUES ('domain','moosii') ON CONFLICT (key) DO UPDATE SET value='moosii';"
psql.exe "${T[@]}" -A -F' | ' -c   "SELECT to_regprocedure('public.recompute_seg_status(uuid)') IS NOT NULL AS has_056,
          to_regclass('public.test_account_events')            IS NOT NULL AS has_127,
          to_regclass('public.catalog_mode_switches')           IS NOT NULL AS has_128;"

echo "== 5. the 129 fixture (lessons, cards, images; S1/S2 complete pre-129) =="
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$D129/fixture.sql" 2>&1 | sed -E 's#^psql:[^ ]+:[0-9]+: ##'

echo "== 6. the pre-129 verdict, for comparison =="
psql.exe "${T[@]}" -A -F' | ' -c \
  "SELECT id, seg_status FROM segments WHERE id::text LIKE 'e1292222%' ORDER BY id;"

echo "== 7. apply migration 129 =="
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/129_approval_image_gate.sql" 2>&1 \
  | sed -E 's#^psql:[^ ]+:[0-9]+: ##'

echo "== 8. re-apply, which MUST be refused by the md5 guard =="
if psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/129_approval_image_gate.sql" > "$WORK/reapply.out" 2>&1; then
  echo "!! FAIL: 129 applied twice — the md5 PRE-CHECK did not hold"; exit 1
else
  grep -oE 'recompute_seg_status is not the known 056 body \(md5 [0-9a-f]+\)' "$WORK/reapply.out" \
    || { echo "!! FAIL: refused, but not by the md5 guard:"; sed -E 's#^psql:[^ ]+:[0-9]+: ##' "$WORK/reapply.out" | head -5; exit 1; }
  echo "OK: the second apply was refused by the md5 guard, as designed"
fi

echo "== 9. the post-129 verdict — stored values are UNCHANGED (129 re-derives nothing) =="
psql.exe "${T[@]}" -A -F' | ' -c \
  "SELECT id, seg_status FROM segments WHERE id::text LIKE 'e1292222%' ORDER BY id;"

echo "== 10. behaviour suite =="
cd "$REPO"
export MOOSIE_TEST_DB_URL="postgresql://postgres@localhost:$PORT/moosii_test"
echo "MOOSIE_TEST_DB_URL=$MOOSIE_TEST_DB_URL"
npx tsx --test src/lib/__tests__/approvalGate.db.test.ts > "$WORK/tests.out" 2>&1 || true
tail -24 "$WORK/tests.out"
echo "---- full output: $WORK/tests.out"
