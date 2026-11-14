#!/usr/bin/env bash
# Rebuild the throwaway PG17 harness and run the migration-126 suite end to end.
#
#   bash docs/drafts/126-publish-gating/run.sh
#
# Needs: PostgreSQL 17 client+server binaries, and MOOSII_DB_URL in .env for the schema dump
# (READ-ONLY: pg_dump --schema-only). Nothing touches either live project.
#
# Traps this script encodes:
#   * pg_ctl start hangs unless stdout/stderr are redirected (-l).
#   * PGCLIENTENCODING=UTF8 or Windows psql reads the .sql files as a code page.
#   * the dump is NOT committed; it is regenerated each run.
set -euo pipefail

BIN="${PGBIN:-/c/Program Files/PostgreSQL/17/bin}"
PORT="${PGPORT_TEST:-55432}"
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
trap 'pg_ctl.exe -D "$WORK/data" stop -m immediate >/dev/null 2>&1 || true' EXIT
until pg_isready.exe -h localhost -p "$PORT" >/dev/null 2>&1; do :; done

T=(-w -h localhost -p "$PORT" -U postgres -d moosii_test)
createdb.exe -h localhost -p "$PORT" -U postgres moosii_test

echo "== 3. stubs + restore =="
psql.exe "${T[@]}" -q -v ON_ERROR_STOP=1 -f "$REPO/docs/drafts/126-publish-gating/stubs.sql"
psql.exe "${T[@]}" -q -f "$WORK/schema.sql" 2>&1 | grep -viE 'supabase_admin|already exists' | head -5 || true

echo "== 4. fidelity vs live (these md5s must match the live project) =="
psql.exe "${T[@]}" -A -F' | ' \
  -c "SELECT md5(replace(prosrc, chr(13), '')) AS set_lesson_published FROM pg_proc WHERE oid='public.set_lesson_published(uuid,boolean,uuid,text)'::regprocedure;" \
  -c "SELECT md5(replace(prosrc, chr(13), '')) AS user_active_tracks_for_user FROM pg_proc WHERE proname='user_active_tracks_for_user';" \
  -c "SELECT count(*) AS policies FROM pg_policies WHERE schemaname='public';"

echo "== 5. fixture =="
psql.exe "${T[@]}" -q -v ON_ERROR_STOP=1 -f "$REPO/docs/drafts/126-publish-gating/seed.sql"

echo "== 6. apply migration 126 =="
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/126_publish_gating_and_archive_audit.sql" 2>&1 | sed -E 's#^psql:[^ ]+:[0-9]+: ##'

echo "== 7. behaviour suite =="
psql.exe "${T[@]}" -f "$REPO/docs/drafts/126-publish-gating/tests.sql" 2>&1 | sed -E 's#^psql:[^ ]+:[0-9]+: ##'

echo "== 8. re-apply, to prove the file is NOT re-runnable (expected: the md5 guard refuses) =="
psql.exe "${T[@]}" -v ON_ERROR_STOP=1 -f "$REPO/migrations/126_publish_gating_and_archive_audit.sql" 2>&1 | sed -E 's#^psql:[^ ]+:[0-9]+: ##' | head -3
