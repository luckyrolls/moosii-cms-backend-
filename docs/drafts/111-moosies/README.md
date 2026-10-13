# Migration 111 — local test harness

Throwaway local PG 17 cluster, restored from a **schema-only** dump of Moosii's `public` schema. Never point any of
this at Supabase except `verify.sql`, which rolls back.

```
initdb -D <dir> -U postgres -A trust -E UTF8 --locale=C
pg_ctl -D <dir> -o "-p 55432" -l <dir>/log -w start  > <dir>/pgctl.out 2>&1    # redirect, or pg_ctl hangs
pg_dump "$MOOSII_DB_URL" --schema-only --schema=public --no-owner -f <scratch>/moosii_public_schema.sql   # read-only
export PGCLIENTENCODING=UTF8
psql -h localhost -p 55432 -U postgres -d postgres -c "create database m111"
psql … -d m111 -f stubs.sql                       # roles, auth.users/uid()/role() (copied from live), extensions stub
psql … -d m111 -f <scratch>/moosii_public_schema.sql   # only supabase_admin default-privilege lines error
psql … -d m111 -f seed.sql                        # local fixtures (live projects have real rows)
psql … -d m111 -v ON_ERROR_STOP=1 -f ../../../migrations/111_moosie_awards_ledger.sql
psql … -d m111 -v ON_ERROR_STOP=1 -f verify.sql   # rolled back; also run live after each apply
MOOSIE_TEST_DB_URL=postgres://postgres@localhost:55432/m111 npm test   # the DB tests; they skip without it
```

`verify.sql` picks a user with a `user_configurations` row and lessons they haven't completed; a missing activity or
questionnaire is made inside the transaction. Every case asserts one new ledger row and the matching balance change.
