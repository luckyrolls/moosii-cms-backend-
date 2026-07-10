# Migrations & the "reconciliation list"

## TL;DR
These SQL files are the repo record of schema changes, but **not all of them are
tracked by a migration runner**. Some were applied by hand through the Supabase SQL
editor and are therefore **absent from Postgres's `supabase_migrations.schema_migrations`
table**. So neither `ls migrations/` nor `schema_migrations` alone tells you what is
actually live — you have to *reconcile* the files against the real schema. The
"reconciliation list" is the set of hand-applied migrations you'd have to walk to do
that.

## The two tracks
- **001–005** — applied through the normal runner; **present** in
  `schema_migrations`. Trustworthy high-water mark for this range.
- **006–040 + the `0001`–`0004` prompt track** — applied **by hand via the Supabase
  SQL editor**; **NOT** in `schema_migrations`. This is the reconciliation list.
  (Note: `032` is reserved for the `user_track_matches`/column-drop migration, tracked
  separately — the list may temporarily have that hole. `008` is a BACKFILLED RECORD of
  the pre-existing demographic config tables — reconstructed from live DDL, a no-op on
  the live DB; `009` remains an open gap.)

Each hand-applied file's header carries a line like
`APPLY VIA THE SUPABASE SQL EDITOR — on the 008..0NN reconciliation list`, and the
high-water number is bumped as migrations are added. (Current high-water: **040**.)

## Why this matters
- A file existing here does **not** prove it was applied — confirm against the live
  schema, not the folder listing.
- `schema_migrations` is **blind** to everything applied by hand, so it under-reports
  what's live.
- A **fresh/rebuilt database** would NOT receive 006–037 by running the tracked
  migrations — someone must re-apply the hand-run ones, **in order**, via the SQL
  editor.

## Applying a new migration (current process)
1. Add a numbered `NNN_description.sql` file here (next number in sequence).
2. Run it in the Supabase SQL editor.
3. If it changed the schema, regenerate `src/types/database.types.ts` (PostgREST
   introspection) and drop any temporary `(supabase as any)` bridge.
4. Bump the "reconciliation list" high-water number in the file header.

Migrations are written idempotent where practical (`IF NOT EXISTS`,
`ON CONFLICT DO NOTHING`, `CREATE OR REPLACE`) so a re-run is safe.

## Cleaning this up (optional, later)
The reconciliation list disappears if you either:
- **(a)** backfill `schema_migrations` with the hand-applied versions, so the runner's
  ledger matches reality; or
- **(b)** adopt a single migration runner going forward, so the folder and the DB stay
  in lockstep.

Until then, this file is the durable definition so the concept doesn't live only in
commit messages and chat history.
