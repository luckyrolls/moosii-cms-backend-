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
- **006–047 + the `0001`–`0008` prompt track** — applied **by hand via the Supabase
  SQL editor**; **NOT** in `schema_migrations`. This is the reconciliation list.
  (Note: `032` is reserved for the `user_track_matches`/column-drop migration, tracked
  separately — the list may temporarily have that hole. `008` is a BACKFILLED RECORD of
  the pre-existing demographic config tables — reconstructed from live DDL, a no-op on
  the live DB; `009` remains an open gap.)

Each hand-applied file's header carries a line like
`APPLY VIA THE SUPABASE SQL EDITOR — on the 008..0NN reconciliation list`, and the
high-water number is bumped as migrations are added.
(Current APPLIED high-water: **051** (main) + **0008** (prompt track).)

## Reconciliation entries — enumerated (044+ / 0005+)
The 006–043 + 0001–0004 range above predates per-entry logging. From **044** (main) and
**0005** (prompt track) on, each hand-applied migration is listed here (per the standing
doc-maintenance rule in `CLAUDE.md`). Sourced from each file's own header:

Main track:
- **044** — persist `curator_note` in `create_lessons_with_segments` (adds the column to
  the RPC's insert + select list).
- **045** — exclude ARCHIVED tracks from the active-track set: `user_active_tracks_for_user()`
  and its `user_active_tracks` view twin gain `AND t.archived_at IS NULL`.
- **046** — exclude ARCHIVED lessons from the MLP item pool: `mlp_item_pool`'s lesson arm
  gains `WHERE l.archived_at IS NULL`.
- **047** — internal_name: **column + backfill + RPC** (the complete, idempotent record). Adds
  `lessons.internal_name` (`ADD COLUMN IF NOT EXISTS`), backfills from `lesson_name`
  (`WHERE internal_name IS NULL`), and teaches `create_lessons_with_segments` to persist it
  (coalesce absent/empty → `lesson_name`; same `(p_lessons jsonb)` signature, no overload/DROP).
  The DDL is already live ad-hoc on this DB, so the file's only effect here is the RPC.
- **047a** — APPLIED (live; **NOT RUNNABLE** — rebuild record only): `checkins_foundation`
  — wipe questionnaires; drop `is_score_based`; add `questionnaire.kind` (NOT NULL default
  `'diagnostic'`); rebuild `questionnaire_user_answers` against the atom tables; create
  `questionnaire_answer_actions` (+ `qaa_payload_matches_type`); add
  `questionnaire_questions.milestone_id`; recreate `questionnaire_with_track_name` /
  `questionnaire_user_score`. Applied manually via the SQL editor and never filed until
  now. **Logical position: after 047, before 048** (048 reads the tables it creates), hence
  the `047a` sort key. It is a COMPLETE record — the §7 view bodies
  (`questionnaire_with_track_name` / `questionnaire_user_score`) and all three earlier
  FLAG-FOR-MARK items are resolved from live and transcribed; only DDL statement form and a
  couple column defaults remain reconstructed (schema shape fully confirmed). Carries an
  ALREADY-APPLIED/DO-NOT-RUN banner — do not execute it against the live DB.
- **048** — APPLIED: add a CHECK-IN routing arm to the `questionnaire_responses_tracks`
  view (`UNION ALL` a per-answer `questionnaire_user_answers ⨝ questionnaire_answer_actions`
  arm onto the diagnostic arm). 10-col contract preserved byte-for-byte, so the frozen
  `user_active_tracks` + `user_active_tracks_for_user` pair are untouched.
- **049** — APPLIED: scope the check-in routing arm to `kind='checkin'`
  (`CREATE OR REPLACE VIEW questionnaire_responses_tracks`, adds `JOIN questionnaire q` +
  `AND q.kind='checkin'`). Closes the Claim-1 hazard; 10-col contract unchanged so the
  frozen `user_active_tracks` pair needs no change.
- **050** — APPLIED: `completed_items.score DROP NOT NULL` — a check-in has
  no score; permits the app to write NULL instead of a matchable 0 sentinel (app change is
  a separate app-repo slice).
- **051** — APPLIED: partial unique index `qaa_one_milestone_per_answer` on
  `questionnaire_answer_actions (answer_id) WHERE action_type='record_milestone'` — ≤1
  milestone assertion per answer, without capping add_track/add_tag fan-out.
- **Apply order for 049–051:** all three are mutually INDEPENDENT and were applied in any
  order; each was trivial at zero rows. (They post-date 048 and its `checkins_foundation`
  predecessor — now filed as 047a.)
Prompt track:
- **0005** — seed the questionnaire-generation prompt row; cutover of `generate_questionnaire`
  from a file-based prompt to a DB-composed one.
- **0006** — `coverage_audit` prompt seed: the prompt behind the `coverage_audit` job.
- **0007** — `coverage_audit` empty-band delta: one targeted edit to the `coverage_audit`
  prompt row's `system_message` (COVERAGE MAP section).
- **0008** — `internal_name` in the `lesson` + `coverage_audit` prompts: output_schema gains
  the property (properties + required, OpenAI-strict), system_message gains the two-names rule.
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
