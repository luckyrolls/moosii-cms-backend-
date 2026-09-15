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
(Current APPLIED high-water, per project from 069: **financial 079 · Moosii 079** (main) + **0008**
(prompt track). Both projects share 008..074 and 076..079; **075 is financial-only** (decision D6).
Every migration 008..068 is applied and verified on MOOSII, with one caveat: 059 is applied
but has no file in the repo (see its entry). The **financial** project was built from a schema
dump of Moosii (confirmed 2026-09-12), so it carries the same schema through 068, and its
`app_settings.domain` is set to `'financial'`. ⚠ **From 069 the high-water is tracked PER PROJECT**
— financial and Moosii — per the apply-order rule under "Applying a new migration".)

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
  - **062** — **APPLIED (2026-09-11); shipped with a defect, FIXED by 067 the same day**: `create_lessons_with_segments` becomes INSERT-OR-SELECT (`ON CONFLICT … DO
    NOTHING` + return the existing row, `created` flag added to the RETURNS TABLE). Requires
    061 as its conflict target. Backend code tolerates the flag's absence, so it may deploy
    before this is applied.
  - **063** — **APPLIED (2026-09-11; found by probe, not named in the confirmation — worth confirming)**: `lessons.with_quiz` becomes DERIVED: `lesson_with_quiz_derive(uuid)` + triggers
    on `quiz_questions`, `segments` and `lessons`, plus a one-time backfill. Measured impact:
    141 of 153 lessons flip true→false, including 5 published ones whose single quiz question
    is unapproved.
  ⚠ These four took the numbers the unapplied `docs/drafts/facts-v1/` set had claimed
  (060–067). Facts v1 has since been renumbered to 069–076 (and the optional partner-id mapping to 077 when D1's FK took 076).
- **064–066 — APPLIED (2026-09-11): published-content edit policy**
  (FINDINGS-published-edit.md). Design slice; nothing is built on top of them yet.
  - **064** — `app_settings` (one row: `domain`) + `content_edit_policy_guard()` on
    `sub_segments` / `quiz_questions` / `quiz_answers` / `segments` content columns, plus `lessons.description` + `lessons.safety_sensitive` (both decided CONTENT 2026-09-10). Inert
    unless `domain='financial'`, where a content write touching a PUBLISHED lesson raises with
    `HINT='published_content_locked'`. The warn domain gets **no trigger** on purpose — the
    state it would set is derived. The financial project got this via the schema dump, and its
    `app_settings.domain` is set to `'financial'` (confirmed 2026-09-12) — without that, the
    financial backend's boot assert sees a mismatch against its `DOMAIN=financial` env and
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
- **067** — **APPLIED (2026-09-11)**: fix `42702 column reference "lesson_name" is
  ambiguous` introduced by 062. The `ON CONFLICT (track_id, lesson_name)` inference takes
  UNQUALIFIED column names, and `lesson_name` collides with the `RETURNS TABLE` OUT parameter,
  so every call to the RPC fails — both lesson-creation paths are down until this is applied.
  Fix is one line, `#variable_conflict use_column`, resolving ambiguous names to the column.
  Renaming the OUT parameters was rejected: they are the JSON keys PostgREST returns.
  `CREATE OR REPLACE` is correct here (unlike 062) because the return type is unchanged.
- **059** — APPLIED + verified (2026-09-11): the `user_mlp_data` LEFT JOIN rewrite (Mark's
  SQL). Zero-child users now get a `user_mlp_data` row, so default tracks and `scope:'all'`
  rebuilds reach them. Its precondition — the `generateFullMLP` hang fix being live — was met
  on 2026-09-10. Verified live 2026-09-12: 2 of 5 `user_mlp_data` rows have zero children.
  ⚠ **NO FILE FOR 059 EXISTS IN THIS REPO.** It was applied from SQL held outside the repo and
  never filed, so it is the one applied migration with no record here. A fresh-database
  rebuild walk has nothing to run at 059 and would silently skip the LEFT JOIN rewrite —
  reintroducing "zero-child users get no default tracks" on the financial project, which is
  exactly the population it was written for. **File Mark's SQL as
  `migrations/059_user_mlp_data_left_join.sql`** (with an ALREADY-APPLIED banner, like 047a) so
  the walk is complete. The body is `user_mlp_data`'s view definition, which is not otherwise
  recorded anywhere in the repo either.
- **068** — **APPLIED (2026-09-11)**: `set_lesson_published(uuid, boolean, uuid, text)` —
  flips `lessons.is_published` AND writes the `content_approvals` row in ONE transaction, so
  a lesson cannot be published or unpublished without its audit row. Replaces two PostgREST
  calls (two transactions) where `logApproval` swallowed its own failures, so a missing audit
  row still returned 200. Refuses a null actor rather than skipping the row. ⚠ Deliberately
  inverts `logApproval`'s "never block the action" rule **for this action only**. Verified live:
  the null-actor guard fires, and the CMS has written real `lesson` publish/unpublish rows through
  it. The route's pre-068 fallback is now dead code and can be removed in a later cleanup.
- **069–073 — facts v1 schema** (`docs/drafts/facts-v1/README.md`; contract draft
  `docs/drafts/facts-v1/contract-facts-intake.draft.md`). **APPLIED financial (2026-09-14) ·
  APPLIED moosii (2026-09-14).** First batch under the Claude-applies process. Applied with psql in
  order, on each project; per file PRE-CHECK → migration → VERIFICATION (rolled back), all clean
  on both (financial PG 17.6, Moosii PG 15.8); post-state 0 rows in every new table on both.
  074 (the resolution arm) followed the same day; see the 076 / 074 / 075 entry below.
  - **069** — `fact_keys` + `fact_values`: closed vocabulary; the "no amounts" CHECKs. Verified:
    RLS on; `1200`, `$40`, `0.82`, `Low` rejected.
  - **070** — `user_facts`: append-only observation log; FK to the vocabulary `ON UPDATE RESTRICT ON
    DELETE RESTRICT`. Applied as **D1 option (a): no FK on `user_id`** (pre-check re-confirmed
    `children.parent_id` still has none); adding the `auth.users` FK later is one ALTER while the
    table is empty. Verified: unknown pair / amount / source rejected; clearing keeps history;
    renaming an in-use value refused.
  - **071** — `user_facts_latest`: latest-wins, a PLAIN view (not `security_invoker`, see its
    header); REVOKE from anon/authenticated. Verified: no SELECT for anon/authenticated, SELECT for
    service_role; a late-arriving older observation does not win.
  - **072** — `fact_track_rules`: (fact_key, value) → track, `ON DELETE RESTRICT` on the track.
  - **073** — `fact_entry_map`: (fact_key, value) → exactly one lesson or segment; nothing reads it
    in v1.
- **076 → 074 → 075 — facts v1 second batch, APPLIED 2026-09-14.** Applied in that order (076
  depends only on 070; 074 is independent of it). Same process: identity guard, then per file
  PRE-CHECK → migration → VERIFICATION (rolled back), all clean.
  - **076** — `user_facts.user_id` → `auth.users(id) ON DELETE CASCADE` (**decision D1, option
    (b)**). **APPLIED financial · APPLIED moosii.** Pre-check: 0 orphan rows on both. Verified: FK
    present with cascade; a fact for a user with no auth account is refused. (The cascade itself is
    proven in the local harness, not live.) Took the number 076 — the optional partner-id mapping
    draft moved to **077**, and the proposed RLS fix to **078**.
  - **074** — the fact arm on `user_active_tracks_for_user` + its view twin, the SECURITY DEFINER
    helper `user_fact_track_ids(uuid)` (track ids only; EXECUTE anon/authenticated/service_role,
    mirroring the function), and `user_active_tracks_with_reason` replaced with its live text plus a
    `fact_match` reason. **APPLIED financial · APPLIED moosii.** Pre-check on both: function, view
    and with_reason md5 matched the texts 074 was built from. Verified on both: function reads the
    helper, view has the arm, with_reason has `fact_match`, helper SECURITY DEFINER with pinned
    search_path, `user_facts_latest` still closed to clients, twins agree (Moosii 5 users, 0
    mismatches). **No-op proof:** Moosii `user_active_tracks` 50 rows and `with_reason` 50 rows,
    byte-identical before/after (financial: 0/0). **Arm proof on Moosii** (a real user + track,
    rolled back): the fact grants the track in function and view, with_reason says `fact_match`, an
    `authenticated` CALL sees it through the helper, and clearing removes it. Financial: arm proof
    skipped — no users or tracks exist there yet. Post-state on Moosii: every facts table 0 rows.
    ⚠ Second surface: open the CMS inspector (`with_reason`) once to confirm it still renders.
  - **075** — demo vocabulary seeds. **APPLIED financial only (decision D6); never for Moosii**
    (the driver refuses it there). Verified: 6 keys, 13 values, 0 rules, 0 entry-map rows — the 074
    arm stays a no-op until rules are authored.
  Types regenerated from Moosii after the batch (adds `user_fact_track_ids`).
- **078** — **APPLIED financial (2026-09-14) · APPLIED moosii (2026-09-14)** — R1 and the admin widening accepted: the active-tracks views read with the
  CALLER's rights under per-user RLS. Closes the hole where `user_active_tracks`,
  `user_active_tracks_with_reason`, `user_mlp_data` and `questionnaire_responses_tracks` are plain
  postgres-owned views (postgres has BYPASSRLS), so the anon key reads any user's tracks and every
  user's `user_mlp_data` (profile + child ages). In one transaction: `is_admin()`/`is_super_admin()`
  become SECURITY DEFINER (required — 213 policies on 64 tables call them, and dropping `user`'s blanket
  read policy would otherwise recurse); drop the blanket `USING (true)` read policies on `children`,
  `completed_items`, `user`; widen the own-row SELECT policies to `is_admin()`; authenticated read on
  `new_user_tracks` + `fact_track_rules`; own-or-admin on `user_facts`; `security_invoker` on all five
  views; the function reads facts directly again and 074's helper is dropped. R1 (accepted): signed-in users can
  then read their OWN raw facts (reverses 071's posture). Tested locally against a schema-only dump of
  Moosii (`docs/drafts/rls-078/`). Surfaces to confirm: the app (moosii-rn) reads tracks with the
  user's session; the CMS inspector after applying.
  **Apply results.** Pre-check on both: post-074 function/view/with_reason md5, policy fingerprint
  (68), admin checks not yet definer, no FORCE RLS, only the function read the helper. Verify on both:
  admin checks SECURITY DEFINER, 5 views security_invoker, 3 blanket read policies gone, helper dropped,
  twins agree (Moosii 5 users). Roles on Moosii (rolled back): anon 0 rows from the four views, the facts
  view and `user`, no error; an admin sees all 50 rows; an ordinary user sees only their own 10 rows,
  identical to the service view, and 1 `user` row. Service view `user_active_tracks` 50 rows and
  `with_reason` 50 rows identical before/after. Financial: catalog + anon only (no users). Types
  regenerated after (drops `user_fact_track_ids`).
- **079** — **APPLIED financial (2026-09-14) · APPLIED moosii (2026-09-14)**: `UNIQUE NULLS DISTINCT (email)` on `public."user"`
  (`user_email_key`). Moves the duplicate-account guard into the database: after 078 the app's
  client-side lookup of another user's row by email (moosii-rn `verify.tsx:78-82`) sees nothing.
  Case-sensitive; NULL emails stay allowed. The body refuses to add the constraint while non-NULL
  duplicates exist. Pre-check 2026-09-14: 0 duplicate groups on both projects (financial 0 users,
  Moosii 5), 0 case-insensitive duplicates. ⚠ App effect: the duplicate-auth-account path now fails its
  insert with 23505 — flag for the moosii-rn seat.
  **Apply results.** Pre-check re-run inside the apply: 0 duplicate groups (as specified), 0 non-NULL,
  0 case-insensitive, on both (financial 0 users, Moosii 5). Verify on both: `UNIQUE (email)` with NULLs
  distinct; a duplicate non-NULL email refused with 23505 (rolled back).
- **080–083 — child health in classify** (docs/drafts/child-health/PROPOSAL.md; decided by Mark
  2026-09-15). **080–081 APPLIED financial (2026-09-15); 080–083 PENDING moosii.** Apply order =
  number order; proposal labels in brackets.
  Tested locally on a schema-only dump of Moosii (post-079): all four apply cleanly twice, and the
  constraint, RLS and prompt assertions hold.
  - **080 [H1] — both projects** — financial: pre-check, apply and verify clean (RLS on + 4
    policies; unknown flag, bad band, inverted age range refused): `health_red_flags` (vocabulary rendered into the prompt) +
    `health_urgency_rules` (flag + age [min,max) months + optional min °C / min hours → band;
    `rule_key` unique). Signed-in read, `is_admin()` write.
  - **081 [H3] — both projects** — financial: pre-check (025 check definition confirmed), apply and
    verify clean (silent-none distress row refused, strain downgrade accepted, safety downgrade
    refused, silent health row refused, `health_detections` RLS on with no policy): `health_responses` (one fixed row per band),
    `health_detections` (backend-only audit; a row is a band OR a parse failure),
    `user_update_events.health_band`, `distress_detections.downgraded_from` (strain|overwhelm, never
    safety), and 025's unnamed row check `distress_detections_check` replaced by
    `distress_detections_row_is_notable` (still refuses a silent-none row). Before 082 because 082
    seeds `health_responses`.
  - **082 [H2] — MOOSII ONLY**: provisional seed from AAP when-to-call guidance: 20 flags, 24 rules,
    3 responses, every row `is_provisional` with `source_ref`. Poisoning = emergency, source
    "AAP poison guidance — verify page", Poison Control 1-800-222-1222 in the emergency copy.
  - **083 [H4] — MOOSII ONLY**: `classify_update` prompt: 024's text + distress rule 6 (parent state,
    not child symptoms; never applies to safety) + a CHILD HEALTH extraction block; `output_schema`
    gains required `child_health`. Guarded on the live md5 (`4a3e23cf…` → `fc44fb5c…`). ⚠ The live row
    stores the prompt with **CRLF** line endings (applied via the SQL editor); 083 preserves CRLF.
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

## Applying a new migration (current process, from 2026-09-14)
1. Add a numbered `NNN_description.sql` file here (next number in sequence) as **DRAFT**, with a
   PRE-CHECK block and a VERIFICATION block.
2. **Mark gives a go for a batch** (one or more files).
3. **Claude applies the batch to FINANCIAL** with `psql` (`FINANCIAL_DB_URL` in `.env`), per file:
   PRE-CHECK → the migration (`-v ON_ERROR_STOP=1`) → VERIFICATION. Any failure stops the batch
   there. Claude first confirms the connection reaches the right project (the `postgres.<ref>`
   user and `pg_control_system().system_identifier`), then reports the per-file results.
4. **Mark gives a second go; Claude repeats the batch on MOOSII** (`MOOSII_DB_URL`) and reports.
5. Each project's apply is recorded in its reconciliation entry
   (`APPLIED financial (date) · APPLIED moosii (date)`) and the high-water, in its own commit.
6. After the MOOSII apply, if the schema changed, regenerate `src/types/database.types.ts` — the
   types come from Moosii (`SUPABASE_URL`) — and drop any temporary `(supabase as any)` bridge.

Mark may still apply a file by hand in the SQL editor; the entry then flips only on his
confirmation that he ran it.

Migrations are written idempotent where practical (`IF NOT EXISTS`,
`ON CONFLICT DO NOTHING`, `CREATE OR REPLACE`) so a re-run is safe.

### RULE: from migration 069, apply to the FINANCIAL project first, then Moosii
There are two Supabase projects — **financial** and **Moosii** — sharing one schema. From
**069 onward, every migration is applied to the financial project FIRST, then to Moosii.**
Run the file's PRE-CHECK and VERIFICATION on financial, confirm it is clean, and only then
repeat the whole file on Moosii. **A defect found on financial stops the Moosii apply** until
the file is fixed.

**Why this order.** Financial has no live content or users yet; Moosii has the published
catalog and real traffic. A migration defect should surface where it cannot hurt anyone. This
is not hypothetical: 062 applied cleanly and still broke `create_lessons_with_segments` on
Moosii for every caller until 067 fixed it — exactly the class of failure a first apply on an
empty project would have caught.

**The apply gate has two go's per batch** — one before financial, one before Moosii (process
above). A reconciliation entry from 069 on records both, e.g.
`APPLIED financial (date) · APPLIED moosii (date)`, and a file is only "applied" once BOTH are done. An entry reading `APPLIED financial · PENDING moosii` is a
normal intermediate state, not an error.

**Migrations ≤ 068 were applied to Moosii; financial inherited them from a schema dump**
(confirmed 2026-09-12). So financial starts at the same schema high-water, 068, and nothing below
069 is replayed there. Its `app_settings.domain` is set to `'financial'` (the row 064 created).
⚠ **A schema dump carries objects, not necessarily rows.** Migrations whose effect is DATA did
not reach financial through the schema: the prompt-track seeds 0005–0008, 060's archive of three
Moosii lessons, and the 058/063 backfills. 058/060/063 are moot on an empty catalog. The
prompt rows are not — any job that composes its prompt from `prompts` fails on financial until
that project has its own prompt rows, which is a content decision, not a migration replay.

**Scheduled jobs are per project.** A `pg_cron` job is data in that project's `cron` schema, not
schema — a dump does not reliably carry it, and each project's job must target its OWN backend
URL and secret. Treat `cron.schedule` calls as per-deployment configuration, never as a shared
migration body.

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
