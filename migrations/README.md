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
(Current APPLIED high-water: **066** (main) + **0008** (prompt track); 008..066 is now fully
contiguous — 059 and 062 have both been applied and verified.
⚠ **067 IS OUTSTANDING AND URGENT.** Migration 062 as applied is BROKEN: every call to
`create_lessons_with_segments` raises `42702 column reference "lesson_name" is ambiguous`,
so the `generate_lessons` job and `POST /lessons/coverage-accept` fail on every call.
Nothing is corrupted — the statement aborts before writing. 067 is the one-line fix
(`#variable_conflict use_column`). Confirmed live 2026-09-11.)

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
- **052** — APPLIED: questionnaire age CEILING — `questionnaire.age_max` column + CHECK
  `questionnaire_age_max_valid (age_max IS NULL OR age IS NULL OR age_max > age)`. NULL =
  no ceiling (byte-identical to today). Column + CHECK only; wiring `q.age_max` into the
  mlp_item_pool view's `max_child_age` is a separate slice. Filed idempotent
  (already live).
- **054** — APPLIED (Mark-authored; **rebuild record — DO NOT RUN**): drop the P0001 storage
  trigger, keep the permissive twin. `storage.objects` carried two AFTER-DELETE triggers that
  were NOT duplicates — `delete_image_asset_when_storage_deleted` (illustrations/% only,
  RAISED P0001 on a missing `image_assets` row) ran first and won, aborting any such delete;
  `delete_image_assets_on_storage_delete` (whole `lessons` bucket, deletes quietly) is kept.
  DROPs the strict trigger + its function. Resolves the flagged duplicate-trigger finding.
- **055** — APPLIED: card edit attribution + edit log + dead-column drops (corrected).
  Adds `sub_segments.updated_at/updated_by/created_by` (actor cols NO FK; `created_by` NULL =
  AI-generated); creates append-only `content_edits` (`entity_type` CHECK `('sub_segment')`,
  no FKs, `fields text[]`, no before/after values); DROPs three dead columns
  (`segments.edited`, `lessons.status`, `lessons.segment_status`) — but FIRST DROP+CREATEs the
  three views that referenced them (`lessons_with_track_name`, `v_lesson_details`,
  `lesson_segment_counts_with_track`) without those columns, since a bare DROP COLUMN would
  fail on the view dependency (the original draft missed this; DB view defs aren't in either
  repo's source). Backs `PATCH /sub-segments/:id`. Apply after 054.
- **056** — APPLIED: card-level review state + capabilities + DERIVED seg_status.
  Adds `sub_segments.review_state` (draft|editorial_reviewed|clinically_approved, backfill all
  → draft); `user.can_review_editorial/can_approve_clinical`; `content_approvals` CHECK +
  sub_segment / editorial_approve / clinical_approve / reject + `reason`. `recompute_seg_status`
  (locks segment; derives `seg_status` = complete iff ≥1 card & all clinically_approved) and
  `set_card_review_state`, both **SECURITY DEFINER**, EXECUTE `service_role`-only; the 029
  approve/unapprove bundles are rewritten to transition cards (no direct `seg_status` write).
  Apply after 055.
- **057** — APPLIED: structural guard — `seg_status` writable ONLY by the
  recompute RPC. `REVOKE UPDATE ON segments` from service_role/authenticated/anon, then
  `GRANT UPDATE` on every column EXCEPT `seg_status` (22 cols, verified live 2026-08-11).
  Makes a stray direct `seg_status` write a permission error (fail-closed; no trigger). **NO
  backend code change** — the recompute/transition RPCs are already SECURITY DEFINER.
  **Precondition MET:** CMS slice 3 deployed (regateSegment → recompute-status). Header carries
  the column-list maintenance warning + "a blanket GRANT ALL silently undoes this". Apply after 056.
- **053** — APPLIED: check-in cadence moves ACTION → ANSWER —
  `questionnaire_answers.repeat_after_days` + CHECK `qa_repeat_positive (repeat_after_days
  IS NULL OR repeat_after_days > 0)`; DROP `questionnaire_answer_actions.repeat_after_days`.
  Lets a consequence-free "Not yet" answer carry a cadence. No reader consumed the action
  column; no data migration. Filed idempotent (already live).
- **058** — APPLIED (2026-09-09; verified live in Supabase 2026-09-10): `tracks.weight` positive — backfill `NULL → 1`
  (the value the reader already folds NULL to), `SET NOT NULL`, and CHECK
  `tracks_weight_positive (weight > 0)`. Closes the reproduced generateFullMLP hang on a
  zero-weight track (FINDINGS-financial.md §A.7). Apply after 057. Types regen pending
  (`tracks.weight` Row type tightens to `number`; no code bridge involved).
- **060–063 — catalog integrity set** (FINDINGS-catalog-integrity.md). Apply strictly in this
  order; each file carries its own PRE-CHECK and VERIFICATION block.
  - **060** — **APPLIED (2026-09-10)**: archive the duplicate lesson losers (`68a7b180`,
    `2421cb61`, `4d7af074`). Archive, not delete, so the 3 approved quiz questions on
    `68a7b180` survive. **Had to run FIRST**: 061 cannot be created while those rows are live.
    Verified live — the three losers are archived, the two keepers are not.
  - **061** — **APPLIED (2026-09-10)**: partial unique index `lessons_track_name_active_uq` on
    `(track_id, lesson_name) WHERE archived_at IS NULL`. Scoped to the track because the same
    title legitimately exists in two tracks today. Applied **without `CONCURRENTLY`, wrapped in
    `BEGIN/COMMIT`** (see the standing rule below); the file has been rewritten to match what
    actually ran. Verified live — zero collisions, and a duplicate INSERT is refused with
    `23505` naming the constraint.
  - **062** — **APPLIED (2026-09-11) — but SEE 067, it shipped with a defect**: `create_lessons_with_segments` becomes INSERT-OR-SELECT (`ON CONFLICT … DO
    NOTHING` + return the existing row, `created` flag added to the RETURNS TABLE). Requires
    061 as its conflict target. Backend code tolerates the flag's absence, so it may deploy
    before this is applied.
  - **063** — **APPLIED (2026-09-11; found by probe, not named in the confirmation — worth confirming)**: `lessons.with_quiz` becomes DERIVED: `lesson_with_quiz_derive(uuid)` + triggers
    on `quiz_questions`, `segments` and `lessons`, plus a one-time backfill. Measured impact:
    141 of 153 lessons flip true→false, including 5 published ones whose single quiz question
    is unapproved.
  ⚠ These four take the numbers the unapplied `docs/drafts/facts-v1/` set had claimed
  (060–067). Facts v1 must be renumbered to 064+ before it is applied.
- **064–066 — APPLIED (2026-09-11): published-content edit policy**
  (FINDINGS-published-edit.md). Design slice; nothing is built on top of them yet.
  - **064** — `app_settings` (one row: `domain`) + `content_edit_policy_guard()` on
    `sub_segments` / `quiz_questions` / `quiz_answers` / `segments` content columns, plus `lessons.description` + `lessons.safety_sensitive` (both decided CONTENT 2026-09-10). Inert
    unless `domain='financial'`, where a content write touching a PUBLISHED lesson raises with
    `HINT='published_content_locked'`. The warn domain gets **no trigger** on purpose — the
    state it would set is derived. ⚠ The financial project inherits `app_settings.domain = 'moosii'`
    with the schema dump and must be UPDATEd to `'financial'` immediately after it, or the
    financial backend's boot assert sees the mismatch against its `DOMAIN=financial` env and
    refuses to start.
  - **066** — approval-reset triggers for the three CMS-direct content paths (card reorder,
    add card, quiz edit). A structural card change (insert/delete/reorder) resets the WHOLE
    segment because card roles are role-by-position (invariant 2); a text/image edit resets
    only that card. A quiz question's text, or any of its answers, sends that question back to
    `answer_status='pending'` — closing the hole where an edit to an APPROVED question reached
    parents unreviewed. No recursion: every trigger is `UPDATE OF <content columns>` and the
    resets write only `review_state` / `answer_status`.
  - **065** — `lessons_review_status` view: derived `content_state`
    (`draft` | `published_reviewed` | `published_unreviewed`) plus stage-1/stage-2 queue
    counters. Read-only, stores nothing, self-clears on re-approval. Needs PG15+
    (`security_invoker`).
- **067** — **DRAFT (pending apply — URGENT)**: fix `42702 column reference "lesson_name" is
  ambiguous` introduced by 062. The `ON CONFLICT (track_id, lesson_name)` inference takes
  UNQUALIFIED column names, and `lesson_name` collides with the `RETURNS TABLE` OUT parameter,
  so every call to the RPC fails — both lesson-creation paths are down until this is applied.
  Fix is one line, `#variable_conflict use_column`, resolving ambiguous names to the column.
  Renaming the OUT parameters was rejected: they are the JSON keys PostgREST returns.
  `CREATE OR REPLACE` is correct here (unlike 062) because the return type is unchanged.
- **059** — APPLIED + verified (2026-09-11): the `user_mlp_data` LEFT JOIN rewrite (Mark's
  SQL). Zero-child users now get a `user_mlp_data` row, so default tracks and `scope:'all'`
  rebuilds reach them. Its precondition — the `generateFullMLP` hang fix being live — was met
  on 2026-09-10.
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

### RULE: a return-type change needs DROP + CREATE, in ONE transaction
`CREATE OR REPLACE FUNCTION` **cannot change a function's return type** — including adding a
column to a `RETURNS TABLE`. Postgres refuses with `42P13 cannot change return type of
existing function`. So any migration that changes what a function returns must
`DROP FUNCTION <name>(<arg types>);` first, then `CREATE FUNCTION`.

**Put both inside the same `BEGIN`/`COMMIT`.** Between them the function does not exist; one
transaction means no caller can ever observe that gap — it sees the old version or the new
one, never nothing. A DROP committed on its own takes every caller down until the CREATE
lands.

**Check the privileges before you drop.** A `DROP` discards the function's `GRANT`/`REVOKE`
state, so anything explicitly granted has to be re-granted in the same migration. Capture it
first with `SELECT proacl FROM pg_proc WHERE proname = '<name>'` — `NULL` means Postgres
defaults and nothing needs restoring. (Migration 062 is the worked example: it adds `created`
to the RETURNS TABLE, and the function turned out to have no explicit grants, so none were
needed.)

Naming the argument types in the DROP is what keeps this safe: the argument signature is
usually unchanged, so the DROP removes exactly the function the CREATE then replaces and no
overload can linger.

### RULE: no `CONCURRENTLY` in editor-applied migrations
**Never write `CREATE INDEX CONCURRENTLY` (or `DROP INDEX CONCURRENTLY`, or any other
`CONCURRENTLY` form) in a file destined for the Supabase SQL editor.** Those statements
cannot run inside a transaction block, and the editor wraps what it sends in one, so the
statement fails outright — or, worse, a partial run leaves an **INVALID** index behind that
silently enforces nothing and must be dropped by hand.

Write the plain, locking form and wrap it in `BEGIN`/`COMMIT` like every other migration
here. `CONCURRENTLY` exists to avoid holding a write lock on a large, busy table; this
catalog is in the low hundreds of rows with no live user traffic on writes, so the lock is
measured in milliseconds and buys nothing. (Learned on migration 061, which was drafted with
`CONCURRENTLY` and applied without it.)

If a table ever does grow large enough that the lock matters, that is the point to run the
index build **outside** the editor — via `psql` or a session with autocommit — and to say so
explicitly in the file header, rather than leaving a keyword in a file someone will paste
into the editor.

## Cleaning this up (optional, later)
The reconciliation list disappears if you either:
- **(a)** backfill `schema_migrations` with the hand-applied versions, so the runner's
  ledger matches reality; or
- **(b)** adopt a single migration runner going forward, so the folder and the DB stay
  in lockstep.

Until then, this file is the durable definition so the concept doesn't live only in
commit messages and chat history.
