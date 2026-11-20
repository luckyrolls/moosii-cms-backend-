# 128 local test — catalog modes

Throwaway-Postgres harness for `migrations/128_catalog_modes.sql`, against a **schema-only dump of
Moosii's `public` schema**, so it exercises the real triggers, grants, constraints and functions —
126's `tracks_archive_guard_trg` included, which the backfill archives *through*.

```
bash docs/drafts/128-catalog-modes/run.sh
```

Nine steps: dump Moosii (read-only) → `initdb` on 55434 → the **127 harness's** `stubs.sql` +
restore + `defaults.sql` → apply 127 → **`fixture.sql`** → apply 128 → re-apply (128 is
re-runnable) → the node behaviour suite → **the undo rehearsal** (`undo.sql`, rolled back).
`KEEP=1` leaves the cluster up so the suite can be re-run while iterating; `PGPORT_TEST=…` moves
the port if a kept cluster still holds 55434.

**`fixture.sql` is not optional.** A schema-only dump restores no rows, and 128's backfill reads
rows: without the fixture, PRE-CHECK rightly refuses (no `mem` seed track) and the backfill would
prove nothing. The fixture is shape-faithful to Moosii but smaller — 4 archived `mooselist` tracks,
the `New Parents` seed by the id 128 hardcodes, 3 other active tracks the backfill must archive as
legacy, 1 already-archived one, and **the join-in**: live Moosii's `Baby Is Crawling`, by the id
128 hardcodes, archived and the target of a response on a questionnaire hosted in `mem`. That
reproduces the ONE real cross-group link exactly, so the harness proves the backfill RESOLVES it
(retag to `mem` + unarchive) rather than merely proving a clean graph stays clean.

**The behaviour suite is `src/lib/__tests__/catalogModes.db.test.ts`**, not a `.sql` file. It skips
itself unless `MOOSIE_TEST_DB_URL` is set, and `run.sh` points it at the cluster it just built — so
the same 14 assertions run here and under `npm test` on a machine that has a local 128 database.

## What it caught

**Three real defects in the migration, every one invisible on paper.**

1. **`current_catalog_mode()` had no `REVOKE`/`GRANT`.** Supabase's default privileges grant
   EXECUTE on every *new* function to `anon` and `authenticated`, and PostgREST exposes all of
   `public` at `/rest/v1/rpc/*` — so a SECURITY DEFINER reader of the mode was callable with the
   anon key. 128's own VERIFY block failed the apply and named the count; the fix is the 094
   pattern, now applied to all seven functions.
2. **The mode log ordered by `switched_at`, which is not monotonic.** `now()` is the
   **transaction** timestamp, so two switches inside one transaction share it and the tie-break
   fell to `id DESC` — a random uuid. "The current mode" was therefore non-deterministic, which
   showed up as a test that passed and failed on alternate runs. Fixed with a `seq` identity
   column; `current_catalog_mode()` orders by that. Production switches are each their own
   transaction so this would have been rare and baffling rather than obvious.

3. **The undo revealed tracks that were archived before 128 existed.** The header's step 2 said
   to unarchive everything with `mode_archived` — but the backfill sets that flag on the 30
   `mooselist` rows *without touching their `archived_at`*, because they were already archived.
   Unarchiving them is not a restoration, it is a publication. The rehearsal failed differently
   first (`tracks_mode_archived_implies_archived`, because nothing reset the flag once the sync
   trigger was dropped) and that is what exposed it. The undo now reverses the backfill's two
   NAMED id sets and nothing else, and says plainly that it does not undo the switches performed
   since — switch back first if you want the pre-128 visible set.

Three of my own test bugs are worth not repeating: a parameterised query cannot carry two
statements (`42601`, not the refusal you were expecting); `questionnaire_answer_actions` has a
`qaa_payload_matches_type` CHECK tying `action_type` to which of `track_id`/`tag_id`/`milestone_id`
is set, so switching an action to the tag path means switching both together; and the fixture's
host questionnaire sits **on** the `mem` seed track, so moving that track moves host and target
together and is legitimately allowed — testing the tracks-side guard needs a target distinct from
the host.

## Traps this harness inherits from 127's

`pg_ctl start` hangs without `-l`; `PGCLIENTENCODING=UTF8` or Windows psql reads the `.sql` files
as a code page; `ALTER DEFAULT PRIVILEGES` must go on AFTER the restore (`defaults.sql`), never in
`stubs.sql`; and **every expected failure needs a `SAVEPOINT`**, because a raised exception aborts
the transaction and the next statement returns `25P02`, which carries no HINT and makes a correct
refusal look like a missing one.

## Result — 2026-11-19, 14/14 green, stable across repeated runs; undo rehearsal OK

The backfill shape, the audit rows it writes through 126's guard, the seed switch row, a
`mem → live` switch, a full `live → mem → mdm → live` round trip restoring the exact visible set,
a no-op switch appending nothing, a manual archive surviving a round trip, insert defaulting in
all three forms, retagging in and out of `legacy`, the same-group refusal on every one of the five
paths including both tag paths and the tracks side, and the 094 grants on all four RPCs.

`mdm` owns no tracks on either project, so switching to it yields an **empty catalog** — asserted
as correct behaviour, not an error.

The join-in is covered on both sides: it lands in `mem`, visible, `mode_archived = false` (nothing
switcher-owned it, so no switch may claim it), with exactly one `unarchive` row in
`content_approvals`; and the seed switch row's id lists are asserted against the actual sets, not
just their counts, because those lists are what the undo reads.

`undo.sql` ends in `ROLLBACK`, so step 9 leaves the cluster exactly as step 8 found it — the suite
re-runs unchanged afterwards (checked). It asserts all of 128's columns, functions, triggers and
the log are gone, that **126's** `tracks_archive_guard_trg` survives (not 128's to remove), and
that the visible catalog is the set it was before the undo ran.
