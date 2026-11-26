#!/usr/bin/env bash
# Rebuild the throwaway PG17 harness, apply 129 → fixture → 130 → 131, run the behaviour suite,
# then rehearse the undo.
#
#   bash docs/drafts/130-stale-complete/run.sh          # ~2 min
#   KEEP=1 bash docs/drafts/130-stale-complete/run.sh    # leave the cluster up to iterate
#
# Port 55436, so it cannot collide with the 126 (55432), 127 (55433), 128 (55434) or
# 129 (55435) harnesses. Reuses the 127 harness's stubs.sql / defaults.sql.
#
# Like the 129 harness, it does NOT apply 127 or 128: both are live on Moosii, so a schema-only
# dump taken today already carries their objects. It DOES apply 129, because the dump may or may
# not predate it — step 5 skips the apply when the dump already has the 129 body.
#
# The order 129 → fixture → 130 → 131 is the real apply order, and it matters twice: the fixture
# writes seg_status by hand (which 131 then forbids), and 130's PRE-CHECK refuses to run if 131's
# guard is already installed (D6).
set -euo pipefail

BIN="${PGBIN:-/c/Program Files/PostgreSQL/17/bin}"
PORT="${PGPORT_TEST:-55436}"
WORK="${WORK:-$(mktemp -d)}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
D127="$REPO/docs/drafts/127-test-accounts"
D130="$REPO/docs/drafts/130-stale-complete"
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

echo "== 4. the domain row =="
psql.exe "${T[@]}" -q -v ON_ERROR_STOP=1 -c "INSERT INTO public.app_settings (key, value) VALUES ('domain','moosii') ON CONFLICT (key) DO UPDATE SET value='moosii';"

echo "== 5. 129, unless the dump already carries it =="
MD5=$(psql.exe "${T[@]}" -A -t -c "SELECT md5(replace(pg_get_functiondef('public.recompute_seg_status(uuid)'::regprocedure), chr(13), ''))")
echo "   live recompute_seg_status md5: $MD5"
if [ "$MD5" = "017a190fd685972a20924e1a98e16170" ]; then
  echo "   -> the dump already has the 129 body; skipping the apply"
else
  psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/129_approval_image_gate.sql" 2>&1 \
    | sed -E 's#^psql:[^ ]+:[0-9]+: ##'
fi

echo "== 6. the fixture: 5 stale complete segments, 3 published lessons =="
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$D130/fixture.sql" 2>&1 | sed -E 's#^psql:[^ ]+:[0-9]+: ##'

echo "== 7. the PRE-repair picture =="
psql.exe "${T[@]}" -A -F' | ' -c \
  "SELECT s.id, s.seg_status, coalesce(l.lesson_name,'(ORPHAN)') AS lesson, coalesce(l.is_published,false) AS pub
     FROM segments s LEFT JOIN lessons l ON l.id = s.lesson_id
    WHERE s.id::text LIKE 'e1302222%' ORDER BY s.id;"

echo "== 8. 131 BEFORE 130 must be REFUSED (D6: repair first, then guard) =="
if psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/131_seg_status_derived_guard.sql" > "$WORK/early131.out" 2>&1; then
  echo "!! FAIL: 131 applied onto a lying table — its PRE-CHECK did not hold"; exit 1
else
  grep -oE 'still disagree with the derived value — apply migration 130 \(the repair\) FIRST' "$WORK/early131.out" \
    || { echo "!! FAIL: refused, but not by the repair-first check:"; sed -E 's#^psql:[^ ]+:[0-9]+: ##' "$WORK/early131.out" | head -5; exit 1; }
  echo "OK: 131 refuses to guard a table that still has stale rows"
fi

echo "== 9. apply migration 130 (the repair) =="
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/130_stale_complete_repair.sql" 2>&1 \
  | sed -E 's#^psql:[^ ]+:[0-9]+: ##'

echo "== 9b. re-apply 130, which must be a clean NO-OP (re-runnable) =="
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/130_stale_complete_repair.sql" 2>&1 \
  | sed -E 's#^psql:[^ ]+:[0-9]+: ##' | grep -E '130 (SNAPSHOT|RE-DERIVE: [0-9]+ segment|UNPUBLISH: [0-9]+ lesson|VERIFY ok)'

echo "== 9c. the POST-repair picture, and the audit rows =="
psql.exe "${T[@]}" -A -F' | ' -c \
  "SELECT s.id, s.seg_status, coalesce(l.lesson_name,'(ORPHAN)') AS lesson, coalesce(l.is_published,false) AS pub
     FROM segments s LEFT JOIN lessons l ON l.id = s.lesson_id
    WHERE s.id::text LIKE 'e1302222%' ORDER BY s.id;"
psql.exe "${T[@]}" -A -F' | ' -c \
  "SELECT entity_id, action, coalesce(actor_id::text,'(null)') AS actor, actor_role
     FROM content_approvals WHERE actor_role = 'migration' ORDER BY entity_id;"
psql.exe "${T[@]}" -A -F' | ' -c \
  "SELECT lesson_name, is_published, with_quiz FROM lessons WHERE id::text LIKE 'e1301111%' ORDER BY lesson_name;"

echo "== 10. apply migration 131 (the guard) =="
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/131_seg_status_derived_guard.sql" 2>&1 \
  | sed -E 's#^psql:[^ ]+:[0-9]+: ##'

echo "== 10b. re-apply 131, refused by the md5 guard (it is no longer the 129 body) =="
if psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/131_seg_status_derived_guard.sql" > "$WORK/re131.out" 2>&1; then
  echo "!! FAIL: 131 applied twice"; exit 1
else
  grep -oE 'is not the 129 version this file re-bases on' "$WORK/re131.out" \
    || { echo "!! FAIL: refused, but not by the md5 guard:"; sed -E 's#^psql:[^ ]+:[0-9]+: ##' "$WORK/re131.out" | head -5; exit 1; }
  echo "OK: the second apply was refused by the md5 guard"
fi

echo "== 11. behaviour suite =="
cd "$REPO"
export MOOSIE_TEST_DB_URL="postgresql://postgres@localhost:$PORT/moosii_test"
echo "MOOSIE_TEST_DB_URL=$MOOSIE_TEST_DB_URL"
npx tsx --test src/lib/__tests__/staleCompleteRepair.db.test.ts > "$WORK/tests.out" 2>&1 || true
tail -26 "$WORK/tests.out"
echo "---- full output: $WORK/tests.out"

echo "== 12. UNDO rehearsal (both files, in the order the headers specify) =="
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$D130/undo.sql" 2>&1 | sed -E 's#^psql:[^ ]+:[0-9]+: ##'
psql.exe "${T[@]}" -A -F' | ' -c \
  "SELECT s.id, s.seg_status, coalesce(l.is_published,false) AS pub
     FROM segments s LEFT JOIN lessons l ON l.id = s.lesson_id
    WHERE s.id::text LIKE 'e1302222%' ORDER BY s.id;"
echo "---- harness dir: $WORK"
