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
(Current APPLIED high-water, per project from 069: **financial 131 · Moosii 131** (main) + **0008**
(prompt track). Both projects share 008..074, 076..081, 086, 092..095, 098..099, 101..105, 107..113, 115, 117, 118, 119, 120, 125, 126, 127 and 128; **075 is financial-only** (decision D6);
**082–083 are Moosii-only** (child-health seeds + classify prompt); **084–085, 087–091, 096–097, 100, 106, 114 and 116 are financial-only**
(all APPLIED).
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
  2026-09-15). **080–081 APPLIED financial (2026-09-15); 080–083 APPLIED moosii (2026-09-15).**
  Apply order = number order; proposal labels in brackets. Moosii: every pre-check, apply and
  verification clean (080/081 as on financial; 082 verify 20 flags / 24 rules / 3 responses, all
  provisional, poisoning emergency; 083 pre-check md5 4a3e23cf → verify fc44fb5c, CRLF kept, rule 6
  with the safety exemption + CHILD HEALTH block present, child_health required).
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
- **084–085 — financial content seed** — **084 APPLIED financial (2026-09-16) · 085 APPLIED financial (2026-09-18) · FINANCIAL ONLY** (decisions
  D-C1..D-C4, 2026-09-16). Data only. Each file raises unless `app_settings.domain = 'financial'`.
  - **084** — what `generate_lessons` / `generate_segment_content` need on financial, which had no
    such rows: the Plain Money tone (voice block + segment row, §2g) with copied `standard_arc`,
    `standard_400`, size profile `standard`, and a financial `card_positions_v1` (Moosii's carries
    parenting wording); the active `lesson` prompt with the domain swapped (ages nullable, D-C1;
    D-C2 trigger list; not-advice paragraph); 8 topics; 6 tracks; 7 `fact_track_rules`; Getting
    Oriented as the default track. Filled from `docs/drafts/financial-seed/financial-content-seed.md`
    (§1–§6); the voice block is §2 verbatim plus §1's anti-patterns, and the final card is "one
    concrete action today" in card positions and the financial `standard_arc`. Q-Onboard (§8: an
    answer cannot write a fact), `fact_entry_map` (§7) and `screen_help` (§9) are deliberately not
    here. Tested locally on a financial schema restore (after 075 + 086): bad value / bad weight /
    empty value / wrong domain refused with nothing written; applies twice; all verification checks
    hold; a null-age lesson inserts; a fact grants its track. **Apply after 086.**
    **Financial apply (2026-09-16, PG 17.6):** pre-check: 086 live, 0 rows in every seeded table, 075
    vocabulary 6/13. Applied. Verify: 1 active lesson + 1 active segment prompt; 4 blocks; 1 size
    profile; 8 topics; 6 tracks; **7 fact_track_rules, matching brief §6**; default = Getting Oriented;
    lesson ages nullable; Plain Money fully wired; no parenting wording; rolled-back null-age lesson
    created on Credit Health. (The first verification run stopped on a bug in the check itself — a
    PL/pgSQL variable shadowed a table alias — after the migration had committed; the corrected
    check was re-run on the applied data and passed.)
  - **085** — D-C3: creates/updates Mark's `public."user"` row as `super_admin` with both review
    flags. Needs his financial auth uid (a slot), so it runs after he signs up. Financial has no
    `auth.users` triggers, so sign-up alone creates no `user` row.
    **Financial apply (2026-09-18):** Mark signed up after 087/088, so his `user` row (role `user`,
    no flags) and config row already existed. Pre-check: financial; his auth user present and the only
    one. Applied (the ON CONFLICT update). Verify: `super_admin`, `can_review_editorial` and
    `can_approve_clinical` true; config row intact; the only admin on financial.
- **086 — `content_edit_policy_guard()` per-table branches** — **APPLIED financial (2026-09-16) ·
  APPLIED moosii (2026-09-16).** Both projects, financial first. Fixes a 064 defect that only the financial domain reaches: the single
  `CASE` naming `NEW.seg_id` / `NEW.lesson_id` / … fails with `record "new" has no field …` on every
  guarded write, so on financial no lesson, segment, card or quiz row can be written at all (it blocks
  `generate_lessons`). Same policy, messages, ERRCODE and HINT; same signature. Guarded on 064's md5
  `fb4c390c…` → `ba31ffd7…`. Tested locally on a financial schema restore: before, every write fails;
  after, unpublished writes succeed, six content writes on a published lesson are refused with
  `published_content_locked`, metadata stays writable, a moosii-domain DB stays inert, and it re-runs.
  **Apply before 084's content is generated.**
  Financial apply (2026-09-16, PG 17.6): pre-check md5 `fb4c390c` + 5 triggers; verify md5 `ba31ffd7`,
  5 triggers, SECURITY DEFINER kept; rolled-back proof: a lesson + segment created through the RPC, a
  card / quiz question / answer written unpublished, then 6/6 content writes refused after publish,
  metadata still writable. (084 was applied after 086; 085 on 2026-09-18.)
  Moosii apply (2026-09-16, PG 15.8): same pre-check (md5 `fb4c390c`, 5 triggers); verify md5 `ba31ffd7`
  (identical on PG 15), 5 triggers, SECURITY DEFINER kept; rolled-back proof: a content UPDATE on a
  published card succeeds — the guard is still inert on the moosii domain.
- **087 — financial: auth.users + storage.objects triggers, `lessons` bucket** — **APPLIED financial
  (2026-09-16) · FINANCIAL ONLY.** The schema-only dump of `public` did not carry objects in other schemas.
  A read-only diff of both projects' non-public objects (2026-09-16) found these app-created gaps:
  Moosii's 3 `auth.users` triggers (sign-up → `user` row; verification; provider) and 3
  `storage.objects` triggers (`image_assets` sync / delete), and the `lessons` bucket. The trigger
  functions already exist on financial (the three auth ones only differ by CRLF). The image-sync
  function hardcodes Moosii's storage URL, so 087 replaces financial's copy with financial's ref.
  Body guarded on all five function md5s (LF-normalised). Deliberately NOT copied: Moosii's 9 storage
  policies (two are blanket `allow_all` — see `docs/backlog.md` P1), the five app-side buckets, the
  realtime publication's tables, the cron purge job, Supabase-managed drift. Tested locally (financial
  schema restore + stubbed auth/storage): wrong domain and a tampered function refused; applies twice;
  sign-up creates the `user` row and the default track appears; verification flips `is_verified`; an
  object in `lessons` creates `image_assets` with financial's URL; delete (with Supabase's
  `storage.allow_delete_query`) removes it. **Apply before 085.**
  **Financial apply (2026-09-16, PG 17.6):** pre-check: none of the six triggers, 0 buckets, privileges
  granted, 0 auth users. Applied. Verify: six triggers with Moosii's definitions; sync function = 087's
  (financial URL); `lessons` public, 50 MB; rolled-back proof: sign-up → `user` row (unverified,
  provider email, role user) + Getting Oriented; verification → `is_verified`; upload → `image_assets`
  with financial's URL; delete → row removed.
- **088 — financial: seed `consts` from Moosii** — **APPLIED financial (2026-09-16) · FINANCIAL ONLY.**
  Data only. Since 087 the sign-up trigger copies `consts` into `user_configurations`; financial's
  `consts` was empty, so a sign-up got no config row, and without it completing any item FAILS
  (`trigger_add_moosies` → `moosies + NULL` → NOT NULL violation), `user_mlp_not_completed` (app home
  plan, CMS classify snapshot) returns nothing, and `unique_items_today_by_user` drops the user.
  Seeds Moosii's single row (1 | 1.5 | 20 | 50 | 10 | 9.99 | 99.9 | 7 — Moosii's product values).
  Tested locally: before, no config row / empty plan / completion fails; after, config 20/50/10, plan
  shows, completion adds 10 moosies; wrong domain refused; applies twice. Financial apply: pre-check
  consts empty, 0 users without config, sign-up trigger present; verify row = Moosii's; rolled-back
  sign-up → config row, plan item visible, completion succeeds (+10 moosies).
- **089 — financial: the remaining prompt rows** — **APPLIED financial (2026-09-18) · FINANCIAL ONLY.** Data only.
  `coverage_audit`, `quiz`, `review_best_practices` / `review_doc_grounded` / `review_factual_smell`,
  `questionnaire` — every prompt type the financial CMS can reach that financial lacked (classify is
  off there). Adapted from Moosii's live rows with parenting wording removed, in 084's voice
  (`financial-content-seed.md` §1–§3). Real rewrites: coverage_audit (no age axis; ages nullable),
  questionnaire (never asks for amounts), review_factual_smell (examples). Vocabulary swaps: quiz,
  review_best_practices (+ takeaway = one concrete action), review_doc_grounded. Schemas, scopes and
  models copied from Moosii (review_* are gemini-2.5-flash → GEMINI_API_KEY on the financial
  backend). Refuses to run if any row of these types exists (the handlers read `.single()`).
  Ships with the coverage-audit code change (`src/lib/ageAxis.ts`): financial audits run with no age
  span. Tested locally (financial restore after 075/086/084): wrong domain and a pre-existing row
  refused; applies twice; one active row per type; coverage ages nullable; review card positions →
  financial's block; no parenting words in any financial prompt. **Apply after 084, and deploy the
  code first** (without it a financial audit still demands a span).
  **Financial apply (2026-09-18):** code pushed first (88484da). Pre-check: financial held only
  `lesson` + `segment`; card_positions_v1 present. Verify: one active row per type; coverage ages
  nullable; review `{{card_positions}}` → financial's block; 0 parenting hits across all 8 financial
  prompts.
- **090 — financial: Getting Oriented is about the reader's money, not the app** — **APPLIED financial
  (2026-09-21) · FINANCIAL ONLY.** Data only (Mark, 2026-09-21). Getting Oriented's description → Mark's
  text (guarded on 084's seed md5 `429e58bf`); one sentence — never describe, promise, or give
  instructions for the partner app's features — added to BOTH the `lesson` prompt (asked for) and the
  `coverage_audit` prompt (the one the CMS's generate-lessons button actually runs), directly after
  their shared general-education paragraph; md5-guarded (`ac42bce2` → `c49d8ef4`, `41b080af` →
  `aa42b50a`). Tested locally (wrong domain / edited description refused; applies; re-run no-op).
  Not changed: the 3 Getting Oriented lessons generated 2026-09-19 under the old description.
- **091 — financial: no-app-features rule in the segment prompt** — **APPLIED financial (2026-09-21) ·
  FINANCIAL ONLY.** Data only (Mark, 2026-09-21). 090's sentence, word for word, added to the `segment`
  prompt (id …0301, writes the card text) directly after the same anchor; md5-guarded (`bf582c55` →
  `9b85fd1d`). Tested as a rolled-back dry run on financial (applies once; a second run is a no-op).
- **092 — approving an image no longer un-approves its card** — **APPLIED financial (2026-09-21) ·
  APPLIED Moosii (2026-09-21).** BOTH PROJECTS, schema only. `sub_segments_reset_review_trg` (066) drops `image`
  from its column list (now title, content, sequence + insert/delete); function body unchanged
  (`a6387d29`). Fixes POST /lessons/:id/approve answering `complete` while `approve_content_image`'s
  pointer write reset every card with a new image to `draft` (FINDINGS-cover-image.md §0). No reset
  is lost: no CMS/app path writes `image`; new images reset in code; pointer clears ride on a delete,
  a content write or an explicit draft. Proof (`docs/drafts/092-approve-proof.sql`, rolled back): an
  8-card financial segment and a 9-card Moosii segment — before: bundle says `complete`, all cards
  `draft`, segment `pending`; after: all `clinically_approved`, `complete`; a text edit still resets
  exactly one card; segment and image fingerprints identical before and after each run.
- **093 — a picture swap on a clinically approved card needs clinical review again** — **APPLIED
  financial (2026-09-21) · APPLIED Moosii (2026-09-21).** BOTH PROJECTS, schema only (Mark's decision 2026-09-21).
  New trigger `sub_segments_image_swap_review_trg` (AFTER UPDATE OF image, WHEN the image changed to a
  non-null value on a `clinically_approved` card) → `editorial_reviewed` + recompute; SECURITY DEFINER
  like 066. A trigger, not the approve function, because it sees OLD vs NEW and also catches the
  generate job's `auto_approve` direct write. `approve_segment_bundle` (pre md5 `9d331c9b` → `1243e207`,
  ACL kept) now approves images BEFORE promoting, and promotes only the cards that were
  `editorial_reviewed` at the start — otherwise every fresh image would be demoted right after its
  sign-off (the 092 bug again). Proof (`docs/drafts/093-swap-proof.sql`, each case rolled back, same
  segments as 092): fresh images + bundle → all approved/complete; swap by single approve AND by bundle →
  that card `editorial_reviewed`, segment `pending`; bundle with existing images + same URL re-written →
  nothing moves; swap on an editorial / draft card → stage unchanged; text edit → draft. Before 093 the
  swap cases stayed `clinically_approved`. Fingerprints identical before and after.
- **094 — approval RPCs and `recompute_seg_status`: service_role only** — **APPLIED financial
  (2026-09-21) · APPLIED Moosii (2026-09-21).** BOTH PROJECTS, privileges only (backlog P1). EXECUTE revoked from
  PUBLIC, anon, authenticated on both `approve_content_image` overloads, `approve_segment_bundle`,
  `recompute_seg_status`; granted to service_role. Callers checked first: backend only (the CMS and app
  call none of them; the in-DB callers of recompute are SECURITY DEFINER). Proof
  (`docs/drafts/094-anon-proof.sql` / `.sh`): before, every anon/authenticated call executed (anon key
  over HTTP on Moosii too); after, 42501 (HTTP 401); service_role approve and the admin CMS-direct edit →
  066 recompute still work. Audit of the rest + drafted 095: `FINDINGS-rpc-grants.md`.
- **095 — backend-only RPCs: service_role only** — **APPLIED financial (2026-09-26) · APPLIED Moosii
  (2026-09-26).** BOTH PROJECTS, privileges only. EXECUTE revoked from PUBLIC, anon, authenticated on
  `set_card_review_state` (anon could clinically approve any lesson — proven, rolled back),
  `apply_classification`, `rebuild_user_mlp`, `unapprove_segment_bundle`; granted to service_role. File
  unchanged from the draft. Callers re-checked 2026-09-26 in all three repos: backend only, service-role
  client (`cardReview.ts:33`, `classifyUpdate.ts:499`, `rebuildMlp.ts:677`, `lessons.ts:184`); moosii-cms
  and moosii-rn only carry generated types; the one in-DB caller (`approve_segment_bundle` →
  `set_card_review_state`) is invoker and service_role-only since 094. Each project: rolled-back dry run,
  then apply; after, proacl `{postgres=X, service_role=X}` on all four; as anon → `permission denied for
  function set_card_review_state`; as service_role (dry run) the call still executes.
- **096 — moosii-reader slice 1: anon read of published content** — **APPLIED financial (2026-09-26) ·
  FINANCIAL ONLY.** Privileges + policies, no schema or rows (Mark's brief; design
  moosii-reader/DESIGN-web-reader.md §3.2). New `reader_lesson_visible(uuid)` (SECURITY DEFINER; published,
  lesson and track unarchived; EXECUTE anon + authenticated — deliberately not service_role-only). anon's
  table SELECT on `lessons`/`segments`/`sub_segments`/`app_settings` replaced by per-column SELECT on the
  reader columns; four `TO anon` SELECT policies (visible lessons; `complete` segments of them; their cards;
  the `domain` row). `authenticated` untouched; quiz tables are slice 2. Tested as a rolled-back dry run on
  financial, then applied; as anon: 1 lesson (06eef3f3…), `curator_note` → permission denied, 1 `complete`
  segment, `app_settings` → domain/financial only. ⚠ Not fixed: anon-readable plain views bypass it
  (`docs/rls-sweep.md`).
- **097 — moosii-reader slice 2: anon read of approved quizzes** — **APPLIED financial (2026-09-26) ·
  FINANCIAL ONLY.** Privileges + policies, no schema or rows. anon gets column SELECT on
  `lessons.is_published`/`archived_at` (no row widened — 096's policy still gates rows); anon's table
  SELECT on `quiz_questions`/`quiz_answers` replaced by column SELECT on the reader columns; two `TO anon`
  policies: approved questions on a `complete` segment of a visible lesson, and those questions'
  answers (`is_correct` exposed on purpose — the reader grades client-side). Written and dry-run
  (rolled back) by another seat (0570fea); dry-run again, then applied. Live, as anon: lessons →
  1 row `t`/null; quiz_questions → 1 approved row; quiz_answers → 4; `lesson_id` → permission denied.
- **098 — views → security_invoker, anon revoked; `user_mlp_sel` → `is_admin()`** — **APPLIED financial
  (2026-09-26) · APPLIED Moosii (2026-09-26).** BOTH PROJECTS, options/privileges/policy only. Ten owner-run views that
  anon could read in full (`FINDINGS-anon-views.md`) → `security_invoker = true` + REVOKE SELECT FROM anon;
  `user_mlp_sel` widened from super_admin to `is_admin()` so a plain admin's CMS classify read survives
  invoker. Callers: backend `mlp_item_pool` (service_role, unchanged), moosii-rn and moosii-cms
  `user_mlp_not_completed`; the other eight have none. Proof per project: rolled-back persona simulation
  then dry run; live: anon → permission denied on all ten; own / admin / super_admin / service_role counts
  and the `mlp_item_pool` md5 identical to before; the 096/097 reader verifies unchanged (financial).
  Moosii: a signed-in user's unfiltered read dropped 26 → 6 (own only); a plain admin still reads another
  user's 6. No `database.types.ts` change (view columns unchanged).
- **099 — REVOKE ALL FROM anon on the 15 RLS-off tables** — **APPLIED financial (2026-09-26) · APPLIED
  Moosii (2026-09-26).** BOTH PROJECTS, privileges only (tourniquet; RLS stays off, authenticated/service_role
  untouched — the RLS pass is backlog P1). No sessionless client reads them (backend, moosii-cms,
  moosii-rn, moosii-reader grepped). Live: anon S/I/U/D/T = f on all 15; anon on content_approvals /
  prompt_blocks / topics → permission denied; admin (claims) counts unchanged.
- **100 — financial: no amounts, not even as examples (tone + quiz) + lesson typo** — **APPLIED financial
  (2026-09-28) · FINANCIAL ONLY.** Data only (Mark, 2026-09-28; FINDINGS-financial-images §5). Plain Money
  tone block (…0204): the amounts sentence → Mark's wording (no amount, price, balance or limit even as an
  example; "under 30% of your limit" allowed as a guideline); prior text saved to `prompt_block_versions`.
  Financial quiz prompt (…0402): the same sentence appended. Lesson f9b2c834… description "hat" → "What"
  (unpublished, so the financial edit lock allowed it). md5-guarded per change (`39092208`→`ff8985d0`,
  `46f131e1`→`52add72d`, `5eec1ce0`→`65a642ec`); dry-run twice in one rolled-back transaction (the second
  pass is a no-op), also from a CRLF copy; then applied and read back. **Not included:** the
  currency-regex lint rule. The engine has no regex type and injects error-severity bans verbatim into
  prompts (FINDINGS-financial-images §7).
- **101 — `user_facts.source` += `derived`, `estimated`** — **APPLIED financial (2026-09-28) · APPLIED
  Moosii (2026-09-28).** BOTH PROJECTS, schema (CHECK only). For the `derive_facts` job (api-contract §8d);
  `POST /facts` still accepts only `platform_api | cms | manual`. 0 `user_facts` rows on either project
  beforehand. Per project: rolled-back dry run, apply; verified by a rolled-back insert: `estimated` passes
  the CHECK (financial inserts; Moosii fails only on the fact_values FK, since it has no vocabulary),
  `guessed` → check violation.
- **102 — RLS on the 15 RLS-off tables + fact vocabulary read + `set_lesson_published` revoke** — **APPLIED
  financial (2026-09-28) · APPLIED Moosii (2026-09-28).** BOTH PROJECTS, schema (RLS + policies + grants).
  13 backend-only tables: RLS on, no policy. `screen_help`: admin ALL (CMS-direct). `topics`: signed-in read
  (the RN plan labels come through the invoker view `user_mlp_not_completed`). `fact_keys` / `fact_values`:
  signed-in read. `set_lesson_published`: EXECUTE service_role only. Callers + persona simulation:
  FINDINGS-rls-pass.md. After: 0 public tables with RLS off on either project.
- **103 — signed-in non-admins read only published, unarchived content** — **APPLIED financial (2026-09-28) ·
  APPLIED Moosii (2026-09-28).** BOTH PROJECTS, schema. `reader_lesson_visible` (096's body) now exists on Moosii
  too (anon EXECUTE only on financial). New SELECT policies `*_select_admin_or_visible` on lessons / segments /
  sub_segments / quiz_questions / quiz_answers: `is_admin()` sees everything; others get the 096/097 reader
  rule. Replaces the `USING (true)` / `auth.uid() IS NOT NULL` read policies; drops `segments_insert_auth`.
  Per project: rolled-back simulation, dry run, apply, then the persona simulation re-run against the live
  policies: all 122 (financial) / 162 (Moosii) measurements equal the rolled-back result. CMS admins and the
  RN parent's plan unchanged; non-admin writes on the 15 tables 0 rows.
- **104 — `user_facts.source` += `seed`** — **APPLIED financial (2026-09-28) · APPLIED Moosii (2026-09-28).**
  BOTH PROJECTS, schema (CHECK only). For the `seed_facts` job (api-contract §8e: demo personas, source_ref
  `demo-seed`); `POST /facts` still refuses it. Per project: dry run, apply; verified by a rolled-back insert:
  `seed` passes the CHECK (financial inserts; Moosii fails only on the fact_values FK), `guessed` → check
  violation.
- **105 — `completed_items` / `user_lesson_progress`: drop the open policies** — **APPLIED financial (2026-09-30) ·
  APPLIED Moosii (2026-09-30).** BOTH PROJECTS, policies only. Dropped `"Enable insert for authenticated users only"`
  (`WITH CHECK (true)`) on both tables and `"Enable read access for all users"` (`USING (true)`) on
  `user_lesson_progress`. They let any signed-in user insert completions/progress for ANY user and read everyone's
  progress (FINDINGS-activities §2). Own-row policies remain. Persona simulation (rolled back, then live, 0 mismatches):
  end user and plain admin cross-user inserts → 42501, own inserts/upserts unchanged; super_admin unchanged; admin
  `completed_items` reads unchanged; progress reads → own rows (plain admin 8 → 6 on Moosii; no caller reads others').
- **106 — demo outcomes (Beat 6)** — **APPLIED financial (2026-10-01).** *** FINANCIAL ONLY *** (domain guard RAISEs
  elsewhere; checked on Moosii, rolled back). `demo_outcome_series` (user_id → auth.users CASCADE; (fact_key, value) →
  fact_values RESTRICT, so vocabulary only, no amounts; observed_at may be future; label CHECK ~* 'seeded') and
  `demo_outcome_aggregate` (metric PK, value int, label CHECK ~* 'seeded'). RLS on, 0 policies, no anon/authenticated
  grants (service role only). Seeded: Sam credit_utilization_band moderate @2026-11-12 "six weeks later (projected,
  seeded)"; Sarah has_emergency_buffer false @2026-09-01, true @2026-10-22; aggregate started_credit_health 120,
  moved_down_band_30d_pct 41. Dry run (rolled back): rows as above, user_facts unchanged (6), Sam's claims and anon →
  permission denied, value '1200' → 23503, label 'projected' → 23514, re-run clean. Never written to user_facts.
- **107 — `lessons.kind` ('lesson' | 'activity')** — **APPLIED financial (2026-09-30) · APPLIED Moosii (2026-09-30).**
  BOTH PROJECTS, schema + RPC. Column NOT NULL DEFAULT 'lesson' + CHECK `lessons_kind_valid` (every existing row →
  'lesson'); `create_lessons_with_segments` gains `kind` in its explicit insert list as `coalesce(l.kind,'lesson')`
  (CREATE OR REPLACE, ACL kept, insert-or-select unchanged; hash-guarded 067 body `a251abfb` → `d7ae90fb`);
  financial: `GRANT SELECT (kind)` to anon. `mlp_item_pool` / `user_mlp` untouched (kind stays out). Per project: dry
  run with rolled-back RPC probes (kind activity → activity, absent → lesson, one segment each; bogus → 23514),
  apply, same checks live, 0 probe rows left. `database.types.ts` regenerated (lessons.kind; also picks up
  `reader_lesson_visible`, on Moosii since 103). First activity (financial data, not a migration): "Set a
  Statement-Date Reminder", Credit Health, priority 250, unpublished.
- **108 — voice lint bans internal terms** — **APPLIED financial (2026-10-01) · APPLIED Moosii (2026-10-01).**
  BOTH PROJECTS, data only. Four error-severity `ban` rows in `voice_lint_rules` (`ban_internal_segment`,
  `ban_internal_sub_segment`, `ban_internal_card_series`, `ban_internal_this_card_series`); `ON CONFLICT (rule_key) DO
  NOTHING`. Per project: identity check, dry run (4 rows, rolled back), apply, verify rows (financial 4 rules total;
  Moosii 21, 7 error bans). Lint + prompt injection checked with an ad-hoc script: all four in the injected "Never use"
  line; "the segment" / "this card series" / "sub-segment" flagged, "Segmented" not.
- **109 — prompt rows: "segment" wording → reader-neutral** — **APPLIED financial (2026-10-01) · APPLIED Moosii (2026-10-01).**
  BOTH PROJECTS, data only, word swaps only. Active quiz `system_message` + `scope` "the supplied segment content" →
  "the supplied lesson's cards"; quiz `output_schema` description "…from the segment content." → "…from the lesson's
  cards."; lesson + coverage_audit "(segment content is generated downstream)" → "(the lesson's cards are generated
  downstream)" (financial's lesson row has a line break inside the phrase, kept); block `standard_arc` "to the segment."
  → "to the lesson."; MOOSII also `sturdy_6_card_arc` "that match the segment" → "…the lesson" and `sturdy_leadership`
  "tailored to the segment." → "…the lesson.". md5-guarded per row and per project (before → swap → after asserted;
  already-after → no-op). Per project: identity check, dry run (rolled back), apply, verify no active
  quiz/lesson/coverage_audit text or block matches 'segment', re-run = all no-op (financial 6, Moosii 8).
  Not changed: JSON-schema names `SegmentQuiz` / `SegmentCards` and the segment prompts' "Ordered cards (sub_segments)"
  schema description. Data fix (not a migration): financial's 5 quiz texts "the segment" → "the lesson".
- **110 — grounding instructions block + generation cap** — **APPLIED financial (2026-10-12) · APPLIED Moosii (2026-10-12).**
  BOTH PROJECTS, schema (two CHECKs) + data (two rows). `prompt_blocks_block_type_check` gains `'grounding'`; one
  shared singleton block `('grounding','grounding_v1')`, resolved by name and NOT referenced from `prompts`. The text is
  chosen by `app_settings.domain` (any other value RAISEs) and differs only in the specifics rule's claim types, to match
  each project's review: Moosii "strong safety or medical claims", md5 `17d937caf1097e817e047e9980d12b8b` (541 chars);
  financial "strong legal, tax or credit-score claims", md5 `7de4bcbe6581b42dbbba378ae2098712` (550 chars). The blank
  line is built with `E'

'`, so the file's line endings can't change it. `app_settings` row `grounding_max_chars = '30000'` +
  CHECK `app_settings_grounding_max_chars_valid` (positive integer). `ON CONFLICT DO NOTHING` for both rows (a rerun
  never overwrites an edit). card_positions untouched. Code (`use_source_documents`) fails legibly without these rows.
  The header quotes each project's live review `SPECIFIC-BUT-UNSUPPORTED` rule with its row id and system_message md5
  (drift watch).
  Tested 2026-10-12 on a throwaway local PG 17 cluster restored from Moosii's `prompt_blocks` + `app_settings`:
  apply, rerun = no-op, card_positions md5 `b217089d…` unchanged, `'30k'` → 23514, block_type `'bogus'` → 23514; re-tested
  per domain (moosii / financial wording; `domain='bogus'` → RAISE, whole transaction rolled back).
  Financial 2026-10-12: identity (sysid 7678069749886157684, domain financial, PG 17.6); pre-check 0 grounding rows,
  0 setting rows, CHECK without 'grounding'; dry run (rolled back) → 1 row md5 `7de4bcbe…`, then 0/0 again; apply OK;
  verify: both CHECKs present, grounding_v1 active (550 chars, md5 `7de4bcbe6581b42dbbba378ae2098712`, legal/tax/
  credit-score wording), card_positions md5 `62d21c5e…` unchanged, `grounding_max_chars = 30000`, `'30k'` → 23514.
  Moosii 2026-10-12: identity (sysid 7481590244898220655, domain moosii, PG 15.8); same pre-check (0 / 0, old CHECK);
  dry run → md5 `17d937ca…`, then 0/0; apply OK; verify: both CHECKs, grounding_v1 active (541 chars, md5
  `17d937caf1097e817e047e9980d12b8b`, safety/medical wording), card_positions md5 `b217089d…` unchanged, cap 30000,
  `'30k'` → 23514. End-to-end read-only: `loadGrounding` on b31254cd returns the block + 1 doc (1252 chars) and the
  rendered section carries no doc id.
- **111 — Moosies: one server-side award path (F28) + lesson-completion unique key (F29)** — **APPLIED financial (2026-10-13) · APPLIED Moosii (2026-10-13).**
  BOTH PROJECTS, schema + trigger + one-time data reset. New ledger `moosie_awards` (`UNIQUE (reason, source_id)`;
  `source_id text`, since `completed_items.id` is a bigint identity; CHECKs on amount >= 0, reason, source shape; RLS
  own/admin read, no client write). `trigger_add_moosies()` rewritten (same name; SECURITY DEFINER, search_path pinned,
  EXECUTE revoked from PUBLIC/anon/authenticated): pays lesson / questionnaire `points`, 0 for `kind='activity'`,
  `moosi_to_add` only when there are no points; ledger row ON CONFLICT DO NOTHING, balance moves only if it was
  inserted. Hash-guarded (legacy `2121c7c6…` → `10d3d5de…`). F29: `completed_items_user_lesson_unique` (partial,
  `item_type='lesson'`); refuses on duplicates. One-time reset (only on the run that creates the ledger): every
  `user.moosies` → 0. Duplicate check 2026-10-13: 0 groups / 0 rows on financial and on Moosii.
  Tested 2026-10-13 on a throwaway local PG 17 cluster restored from a schema-only dump of Moosii
  (`docs/drafts/111-moosies/`): apply (seed balance 40 → 0), re-run = no-op (a balance of 33 + its ledger row kept),
  `verify.sql` all PASS (lesson 5, activity 0, check-in 7 + 7, no-points → moosi_to_add 10, duplicate lesson → 23505,
  replayed award no-op, bad source_id → 23514, `authenticated` insert pays 6 and cannot write the ledger → 42501);
  guards refuse (3 duplicate rows → RAISE, nothing created; foreign trigger body → RAISE); `npm test` with
  `MOOSIE_TEST_DB_URL` 220/220.
  Financial 2026-10-13: identity (sysid 7678069749886157684, domain financial, PG 17.6); pre-check no ledger, md5
  `2121c7c6…`, 0 duplicate groups, balances 10 over 3 users, 1 completion; dry run (rolled back) → ledger, md5
  `10d3d5de…`, search_path `public, pg_temp`, balances 0, then live state unchanged; apply OK; verify: SECURITY
  DEFINER + `search_path=public, pg_temp`, EXECUTE only service_role (no PUBLIC grant), trigger still bound, 6
  constraints, RLS on + `moosie_awards_sel`, anon no privilege / authenticated SELECT only, partial unique index, balances
  0, ledger 0; `verify.sql` live (rolled back, check-in fixture, real activity "Set a Statement-Date Reminder") all PASS;
  after: balances 0, ledger 0, completions 1. Sam's seeded orientation completion predates the ledger, so it has no
  award row and Sam's balance is 0.
  Moosii 2026-10-13: identity (sysid 7481590244898220655, domain moosii, PG 15.8); pre-check no ledger, md5 `2121c7c6…`,
  0 duplicate groups, balances 171 over 6 users, 6 completions; dry run (rolled back) → ledger, md5 `10d3d5de…`,
  search_path `public, pg_temp`, balances 0, then live state unchanged (171); apply OK; verify: same structure as
  financial (SECURITY DEFINER, `search_path=public, pg_temp`, EXECUTE only service_role, trigger bound, 6 constraints,
  RLS + policy, grants, partial unique index), balances 0, ledger 0; `verify.sql` live (rolled back, a lesson flipped to
  activity inside the transaction, real check-in) all PASS; after: balances 0, ledger 0, completions 6.
  `database.types.ts` regenerated (adds `moosie_awards`; no bridge to drop).
- **112 — lock `"user".moosies` (F32) + own-row `"user"` INSERT + diagnostics pay once (F33)** — **APPLIED financial (2026-10-17) · APPLIED Moosii (2026-10-17).**
  BOTH PROJECTS, grants + one policy + trigger. `trigger_add_moosies()` (same name/ACL; hash-guarded 111 `10d3d5de…` → `09d509d0…`):
  a `kind='diagnostic'` questionnaire pays only on the user's first completion (later rows amount 0, ledger row kept),
  serialized by a per-(user, questionnaire) `pg_advisory_xact_lock`; check-ins pay every row; lessons/activities
  unchanged. `"user"`: table-level INSERT/UPDATE revoked from anon + authenticated; authenticated re-granted UPDATE on
  the 10 client-written columns and INSERT on the 4 onboarding columns (inventory in the file header: moosii-rn
  b744b4f, moosii-cms b99c82a, moosii-reader 337f0d6; no client writes moosies). Also closes self-writes of `role` /
  `can_review_editorial` / `can_approve_clinical`. Policy `"Enable insert for authenticated users only"`: `WITH CHECK
  (true)` → `(id = (SELECT auth.uid()))` (folded in 2026-10-17; RN's insert, `verify.tsx:95`, writes the session's own
  id; guarded: refuses if the policy is missing). No new objects → `database.types.ts` unchanged.
  Tested 2026-10-13 on the local PG 17 cluster from 111 (schema-only Moosii restore + 111): apply, re-run = no-op,
  `docs/drafts/112-moosies-lock/verify.sql` all PASS (diagnostic 7 → 0 → 0 with ledger rows, check-in 7 + 7,
  authenticated UPDATE of moosies / role / can_* / is_verified / email → 42501, each of the 10 columns → 1 row, app
  completion still +5); guard refuses a foreign trigger body with grants untouched; `npm test` with
  `MOOSIE_TEST_DB_URL` 227/227 (incl. a two-connection race: one diagnostic pays once).
  Amended 2026-10-17 (own-row INSERT), re-tested on the same cluster: amended file applied over the original 112, re-run
  = no-op, policy check `(id = ( SELECT auth.uid() AS uid))`; `verify.sql` all PASS incl. INSERT of another user's row
  → 42501 (RLS) and own row → 1 row (moosies 0, role user); negative control with the old `WITH CHECK (true)` → verify
  FAILs on that case; guards refuse a missing policy and a foreign trigger body, grants and policy untouched;
  `npm test` with `MOOSIE_TEST_DB_URL` 228/228.
  Financial 2026-10-17: identity (sysid 7678069749886157684, domain financial, PG 17.6); pre-check md5 `10d3d5de…`, anon
  + authenticated table-level INSERT/UPDATE on `"user"`, INSERT policy `WITH CHECK (true)`, state 0 Moosies / 0 ledger /
  1 completion; dry run (rolled back) → md5 `09d509d0…`, search_path pinned, table UPDATE off, `moosies` off,
  `display_name` on, policy `(id = auth.uid())`, then live state unchanged; apply OK; verify: SECURITY DEFINER +
  `search_path=public, pg_temp`, EXECUTE only service_role, trigger bound; table-level INSERT/UPDATE: anon f/f,
  authenticated f/f, service_role t/t; authenticated column UPDATE = exactly the 10, column INSERT = exactly the 4, anon
  0 writable columns; policy `(id = ( SELECT auth.uid() AS uid))`; state unchanged. `verify.sql` live (rolled back): first
  run reported a FALSE fail on the own-row INSERT case — its caller was the first user by id, financial's super_admin,
  whom `user_self_insert` lets insert any row by design; verify.sql fixed to use a throwaway plain caller; re-run all
  PASS (diagnostic 7 → 0 → 0, check-in 7 + 7, 7 forbidden writes → 42501, 10 columns → 1 row, app completion +5,
  another user's row → 42501, own row → 1 row); after: 0 / 0 / 1, auth users 3, user rows 3.
  Moosii 2026-10-17: identity (sysid 7481590244898220655, domain moosii, PG 15.8); pre-check as financial (md5
  `10d3d5de…`, table-level INSERT/UPDATE for anon + authenticated, policy `WITH CHECK (true)`); state 24 Moosies / 4
  ledger rows / 2 completions (app activity since 111; two awarded completions were later deleted, their awards kept —
  balances = ledger sums for every user); dry run (rolled back) identical to financial, live state unchanged; apply OK;
  verify: structure identical to financial (md5 `09d509d0…`, SECURITY DEFINER, search_path pinned, EXECUTE service_role
  only, trigger bound, table-level writes off for anon/authenticated, 10 UPDATE + 4 INSERT columns, anon 0, policy
  `(id = auth.uid())`), 0 users whose balance ≠ ledger sum; `verify.sql` live (rolled back) all PASS; after: 24 / 4 / 2,
  auth users 6, user rows 6. No new objects → `database.types.ts` unchanged.
- **113 — activity follow-ups, slice 1 + F37 (no client deletes of `completed_items`)** — **APPLIED financial (2026-10-17) · APPLIED Moosii (2026-10-17).**
  BOTH PROJECTS, schema + 3 settings rows. F37: REVOKE DELETE + TRUNCATE on `completed_items` from anon/authenticated;
  DROP `completed_items_del` and the catch-all `user_or_super_admin_access` (its S/I/U duplicated by `_sel/_ins/_upd`;
  `is_admin()` includes super_admin). Client delete inventory 2026-10-17 (moosii-rn b744b4f, moosii-cms ba18ba5,
  moosii-reader 337f0d6): none. `lessons` gains `followup_after_days`, `verify_fact_key`, `verify_fact_value`
  (activity-only CHECK, pair CHECK, composite FK `fact_values` RESTRICT; the vocabulary is a table).
  `user_activity_followups` (status committed/done/skipped, 7 CHECKs, UNIQUE (user, lesson), RLS own/admin SELECT, no
  client writes). `app_settings` followup_max_asks 2 / followup_grace_days 14 / followup_verified_bonus 5 + CHECKs.
  `activity_followup_limits()` (SECURITY DEFINER). View `user_activity_followups_due` (security_invoker). Functions
  `activity_award`, `activity_finish`, `activity_followup_answer`, `resolve_activity_followups` (EXECUTE service_role
  only). Guards: 107 + 111 live; `completed_items_sel/_ins/_upd` present.
  Tested 2026-10-17 on the local PG 17 cluster (schema-only Moosii restore): applied over 111+112, re-run = no-op; the
  missing-policy guard refuses; a FRESH restore with 111 → 112 → 113 applies clean; `docs/drafts/113-activity-followups/
  verify.sql` all PASS on both; `npm test` with `MOOSIE_TEST_DB_URL` 256/256 (18 follow-up DB tests: each choice,
  pre-existing completion, idempotent finish, not_yet ×2 → out of the view, grace lapse, unpublished/archived hidden,
  auto-resolve committed + self-done, pre-commitment evidence ignored, seeded fact resolves with its id, did_it + bonus
  once each, client DELETE on completed_items → 42501, client writes to follow-ups → 42501).
  Financial 2026-10-17: identity (sysid 7678069749886157684, domain financial, PG 17.6); pre-check: no follow-up table /
  lesson columns / settings, completed_items policies del/ins/sel/upd/ALL, client DELETE on; state 1 completion / 0
  Moosies / 0 ledger / 1 activity; dry run (rolled back) → table present, client DELETE off, 3 policies, limits (2,14),
  then live state unchanged; apply OK; verify: completed_items policies = ins/sel/upd, DELETE + TRUNCATE off for anon +
  authenticated (service_role on), 4 lesson constraints, 14 follow-up constraints, RLS + uaf_sel, follow-ups anon nothing /
  authenticated SELECT only, view security_invoker (anon no SELECT), the 4 functions EXECUTE service_role only and
  activity_followup_limits SECURITY DEFINER for authenticated + service_role, settings 14 / 2 / 5; `verify.sql` live
  (rolled back) all PASS; after: 1 completion / 0 / 0 / 0 follow-ups, auth users 3, lessons 12, fact keys 6.
  Moosii 2026-10-17: identity (sysid 7481590244898220655, domain moosii, PG 15.8); pre-check as financial; state 3 completions / 29 Moosies / 5 ledger / 0 activities (app activity since 112); dry run (rolled back) identical to financial, live state unchanged; apply OK; verify: structure identical to financial; balances = ledger sums for every user; `verify.sql` live (rolled back) all PASS; after: 3 / 29 / 5 / 0 follow-ups, auth users 6, lessons 154, fact keys 0. `database.types.ts` regenerated.
- **114 — follow-up config for "Set a Statement-Date Reminder"** — *** FINANCIAL ONLY *** — **APPLIED financial (2026-10-19).**
  Data, one row: lesson `d9f6e3b4-…` → `followup_after_days = 7`, `verify_fact_key = 'credit_utilization_band'`,
  `verify_fact_value = 'low'`. Refuses unless `app_settings.domain = 'financial'`, the lesson is that activity, the
  vocabulary has (credit_utilization_band, low), and its current settings are NULL or already these (drift → refuse).
  Tested 2026-10-17 on a throwaway local copy: domain moosii → RAISE; financial → applied (7, credit_utilization_band,
  low); re-run = no-op; drifted value (3) → RAISE, row untouched. Not applied on Moosii (it has no such lesson).
  Financial 2026-10-19: identity (sysid 7678069749886157684, domain financial, PG 17.6); pre-check: the activity, published,
  three NULLs, no other lesson configured; dry run (rolled back) → (7, credit_utilization_band, low), then NULLs again;
  apply OK; verify: (7, credit_utilization_band, low), content md5 `8a6bdace…` unchanged, still published, segment
  `complete`, 5 cards `clinically_approved`, no other lesson configured; re-run = no-op.
- **115 — `activity_finish`: progress parity (F42) + "Did it" on a committed row (F44)** — **APPLIED financial (2026-10-19) · APPLIED Moosii (2026-10-19).**
  BOTH PROJECTS, one function. CREATE OR REPLACE (same signature / jsonb return → 113's service_role-only EXECUTE kept);
  hash-guarded 113 `686e0937…` → `a4676266…` (identical on both projects, 2026-10-19). F42: the new-row path upserts
  `user_lesson_progress {is_completed: true}` (ON CONFLICT (user_id, lesson_id) … WHERE not already true) in the same
  transaction. F44: `did_it` on an existing `committed` row → done / self / resolved_at now + `activity_did_it` once;
  every other repeat returns the row unchanged; skipped is final.
  Tested 2026-10-19 on the local PG 17 cluster (fresh restore + 111–114): apply, re-run = no-op, EXECUTE still
  service_role only; a foreign body → RAISE, body untouched; `docs/drafts/115-activity-finish/verify.sql` all PASS;
  `npm test` with `MOOSIE_TEST_DB_URL` 271/271 (later → did_it resolves + pays once, repeat pays 0, skipped final,
  later/not_for_me no-ops, status always returned, progress written once / pre-existing kept).
  Financial 2026-10-19: identity (sysid 7678069749886157684, domain financial, PG 17.6); pre-check md5 `686e0937…`, EXECUTE
  service_role only, state 0 follow-ups / 1 progress / 1 completion / 0 ledger; dry run (rolled back) → `a4676266…`, grants
  intact, then `686e0937…` again; apply OK; verify: md5 `a4676266…`, EXECUTE service_role only; `verify.sql` live (rolled
  back) all PASS; after: 0 / 1 / 1 / 0, auth users 3, lessons 12.
  Moosii 2026-10-19: identity (sysid 7481590244898220655, domain moosii, PG 15.8); pre-check as financial (md5 `686e0937…`,
  service_role only), state 0 follow-ups / 10 progress / 3 completions / 5 ledger; dry run (rolled back) identical; apply
  OK; verify: md5 `a4676266…`, EXECUTE service_role only; `verify.sql` live (rolled back) all PASS; after: 0 / 10 / 3 / 5,
  auth users 6, lessons 154. No new objects → `database.types.ts` unchanged.
- **116 — "Put Your Buffer on Autopilot" becomes Sarah's verifiable activity** — *** FINANCIAL ONLY *** — **APPLIED financial (2026-10-23).**
  Data, one existing lesson (`e7fc45b6`, Building a Buffer, priority 200, unpublished; title / track / priority / topic /
  publish state unchanged): kind `activity`, followup_after_days 14, verify (has_emergency_buffer, 'true') — the stored
  vocabulary token — and the new description. Guards: domain; lesson present, unpublished, unarchived, in Building a
  Buffer, titled as expected; kind lesson/activity; vocabulary; drift. Content + images come from jobs afterwards
  (unapproved). Reworked 2026-10-23 (was: create a new lesson).
  Tested 2026-10-23 on a throwaway local copy: domain moosii → RAISE; published → RAISE; wrong track → RAISE; financial →
  applied (activity, 14, has_emergency_buffer, true, new description; title / priority 200 / unpublished unchanged;
  anchor 6d4502d2 untouched); re-run = no-op (row not rewritten); drifted value → RAISE, row untouched.
  Financial 2026-10-23: identity (sysid 7678069749886157684, domain financial, PG 17.6); pre-check: lesson, 200, unpublished,
  unarchived, Building a Buffer, NULL follow-up settings; other 11 lessons fingerprinted (`b22f6b2a…`); dry run (rolled back)
  → the intended row, then unchanged; apply OK; verify: (activity, 14, has_emergency_buffer, true, new description), title /
  track / priority 200 / topic / unpublished unchanged, other lessons' fingerprint identical; segment `3d1b3de6-…`.
  Then (jobs, not the migration): regen_segment_content whole_segment, plain_money, structure override, no quiz → 5 draft
  cards; 5 generate_sub_segment_image → 5 candidate images; nothing approved, lesson unpublished.
- **117 — structure block `activity_v1` (activities generate activity-shaped cards)** — **APPLIED financial (2026-10-26) · APPLIED Moosii (2026-10-26).**
  BOTH PROJECTS, data, one `prompt_blocks` row (structure / `activity_v1` / "Activity (v1)", active), text chosen by
  `app_settings.domain`: financial ends "No dollar amounts." (md5 `93d7ecf7…`), moosii without it (md5 `83e45c89…`); any
  other domain → RAISE, rolled back. ON CONFLICT (block_type, name) DO NOTHING. No schema change. Not referenced from
  `prompts`. Code: `src/lib/structureChoice.ts` (generate + regen apply it for kind activity when no explicit structure
  override, and so does the track batch's content units; lessons byte-identical).
  Tested 2026-10-24 on throwaway local copies: financial → one row, the financial text, md5 `93d7ecf7…` (equal to the
  brief's text hashed independently); moosii → md5 `83e45c89…`; domain `bogus` → RAISE, 0 rows; re-run after an edit →
  no-op, the edit kept.
  Financial 2026-10-26: identity (sysid 7678069749886157684, domain financial, PG 17.6, client UTF8); pre-check: no
  activity_v1, structure blocks = standard_arc only, other 5 blocks fingerprinted (`22a62667…`), no prompts row refers
  to it; dry run (rolled back) → the row, md5 `93d7ecf7…`, then 0 rows; apply OK; verify: one row structure / activity_v1 /
  "Activity (v1)", active, md5 `93d7ecf747db8c3ea0838f55067b6c72`, the financial text; other blocks' fingerprint
  identical; no prompts row refers to it.
  Moosii 2026-10-26: identity (sysid 7481590244898220655, domain moosii, PG 15.8, client UTF8); pre-check: no activity_v1,
  structure blocks = standard_arc + sturdy_6_card_arc, other 13 blocks fingerprinted (`39c41766…`), no prompts row refers
  to it; dry run (rolled back) → the row, md5 `83e45c89…`, then 0 rows; apply OK; verify: one row structure / activity_v1 /
  "Activity (v1)", active, md5 `83e45c890e58c2d1ca3dacdcd6affca0`, the Moosii text (no dollar sentence); other blocks'
  fingerprint identical; no prompts row refers to it.
- **118 — follow-up `verify_mode` (a commitment already at target is a self-report)** — **APPLIED financial (2026-11-07) · APPLIED Moosii (2026-11-07).**
  BOTH PROJECTS, schema + function + view. `user_activity_followups.verify_mode` text NOT NULL DEFAULT `'data'`,
  CHECK (`data`|`self`); backfill flips to `self` every row whose activity has no verify rule or whose member already
  carried the target value AT the commitment (`observed_at <= coalesce(committed_at, created_at)`); `activity_finish`
  (113's body otherwise unchanged) decides it once at creation — `data` only when the activity HAS a verify rule AND
  the member is not already at the target; `user_activity_followups_due` gains the column, appended last.
  WHY: since D6 an unchanged facts push writes no row, so a follow-up committed while its fact was already at target
  can never receive an observation dated after the commitment (`docs/api-contract.md` §8b, §10).
  DELIBERATELY NOT CHANGED: `resolve_activity_followups` — `verify_mode` is ADVISORY and does not gate verification, so a
  fact that genuinely moves away and back still verifies a `self` row (`resolved_by = 'data'`). Awards, asks/grace limits,
  `mlp_item_pool`, `user_mlp` and RLS untouched (the column rides the table's existing policy).
  MIGRATION BEFORE CODE: the backend selects `verify_mode` in `GET /activity-followups` and `.../recent`, so commit
  `1803e8d` was pushed only after BOTH projects were applied (a push deploys both services).
  Dry run 2026-11-06 on live financial inside `BEGIN … ROLLBACK`: compiles; column `is_nullable NO`, default `'data'::text`;
  0 backfill disagreements; view column appended last; `activity_finish` → `data` for `d9f6e3b4…` (Sam `credit_utilization_band`
  high, target low) and `self` for `e7fc45b6-1c6d…` (Sam `has_emergency_buffer` already true); nothing persisted.
  Financial 2026-11-07: identity (conn role `postgres.gwxeaygksankbncptlle`, sysid 7678069749886157684, domain financial,
  PG 17.6, client UTF8); pre-check: 113 live, no `verify_mode` column, 0 follow-up rows (so the backfill was a no-op —
  `UPDATE 0`), `activity_finish` still 113's (no `verify_mode`, has `activity:no_followup_configured`); apply OK
  (one transaction, the DROP CONSTRAINT IF EXISTS NOTICE is expected); verify: column text NOT NULL default `'data'::text`,
  CHECK `uaf_verify_mode_valid` present and biting (23514 on `verify_mode = 'guess'`), 0 backfill disagreements, due view
  columns end `… lapses_at, verify_mode` with `security_invoker=true`, `activity_finish` ACL `service_role=X` only
  (no anon/authenticated), and in rolled-back transactions `activity_finish` returned `data` for the statement-date
  reminder and `self` for the buffer activity. After rollback: 0 follow-up rows; Sam's only `completed_items` row is the
  protected orientation seed (`06eef3f3…`, 2026-09-10).
  Moosii 2026-11-07: identity (conn role `postgres.szhihepbqzbbmxybluql`, sysid 7481590244898220655, domain moosii,
  PG 15.8, client UTF8); pre-check: 113 live (`lessons.verify_fact_key` present), no `verify_mode` column, 0 follow-up
  rows and 0 activity lessons at all (so the backfill was a no-op — `UPDATE 0`), `activity_finish` still 113's; apply OK;
  verify: column text NOT NULL default `'data'::text`, CHECK `uaf_verify_mode_valid` present — a throwaway row in a
  rolled-back transaction took the `data` default, accepted `'self'` and raised 23514 on `'guess'` (it also has to satisfy
  113's `uaf_open_iff_committed` / `uaf_done_iff_resolved_by`, hence `done` + `resolved_at` + `resolved_by`); 0 backfill
  disagreements; due view columns end `… lapses_at, verify_mode` with `security_invoker=true`; `activity_finish` ACL
  `service_role=X` only. After rollback: 0 follow-up rows. Cross-check: `md5(prosrc)` of `activity_finish` is
  `f1808f31…` on BOTH projects. Step 5 of the file's VERIFICATION is financial-only by design — Moosii has no
  verify-configured activity (no activity lessons yet).
  `src/types/database.types.ts` regenerated from Moosii after the apply: exactly 4 added lines (`verify_mode` on the
  table's Row/Insert/Update and on the due view), nothing else drifted; no `(supabase as any)` bridge was needed.
- **119 — authored reason labels + `user_track_reasons_for_user` (why an item is in the plan)** — **APPLIED financial (2026-11-09) · APPLIED Moosii (2026-11-09).**
  BOTH PROJECTS, schema + data + one new function (F83; `docs/FINDINGS-plan-reasons.md`, `api-contract.md` §11).
  `fact_track_rules.reason_label` text **NOT NULL** (populated first) and `new_user_tracks.reason_label` text
  **NULLABLE**, both CHECK `btrim(...) <> '' AND ... !~ '[0-9]'` — a member-facing sentence that explains a banded
  fact must not carry a number either (invariants 3, 12). `user_track_reasons_for_user(uuid)` returns ONE ROW PER
  REASON (`default|fact|demographic|questionnaire|insight|manual`) for the tracks that are actually active; SECURITY
  INVOKER, EXECUTE service_role only (the 094 rule), because `user_track_activations` is RLS-on with no policy and the
  reasons cannot be assembled client-side.
  WHY A COLUMN ON `new_user_tracks`, NOT A `kind → label` LOOKUP: the default arm's reason is per-TRACK. Moosii has 12
  `new_user_tracks` rows, financial 1; a lookup keyed by kind could hold only one sentence for the whole arm. WHY
  NULLABLE THERE: financial's single default track has authored copy, Moosii's 12 are parenting copy authored
  separately (Michelle) — they stay NULL, `GET /plan` returns `label: null`, and there is NO fallback text in code.
  ⚠ **THE FROZEN ALGORITHM IS NOT TOUCHED** (invariant 1): nothing here changes `generateFullMLP`, `computeUserMlp`,
  `user_active_tracks_for_user` or `mlp_item_pool`. The new function CALLS the active-tracks function and joins to it,
  so no reason row can add or remove a track. Both PRE-CHECK and VERIFICATION record `md5(prosrc)` of
  `user_active_tracks_for_user` and the apply is only accepted if they MATCH.
  MIGRATION BEFORE CODE: `GET /plan` reads `reason_label` and calls the new function, so the code commits were
  pushed only after BOTH projects were applied (a push deploys both services).
  Labels (Mark 2026-11-09): credit high "Because your cards are close to their limits"; credit moderate "Because your
  card balances are climbing"; buffer false "Because there isn't much set aside for surprises yet"; direct deposit
  false "Because we don't see a regular paycheck coming in"; new subscription "Because a new subscription showed up";
  `saving_for_home` "Because you're saving toward a home" and `wants_debt_payoff_plan` "Because you want a plan for
  paying down debt" (both proposed by Claude, approved; US spelling fixed in `13c83fe`); default track Getting
  Oriented "A starting point for everyone".
  Dry run 2026-11-07 on live financial inside `BEGIN … ROLLBACK`: compiles; nullability as intended; 7 labels + the
  default sentence; CHECK raised 23514 on a label containing `30%`; reasons for Sam and Sarah exactly as expected;
  0 orphan reasons; `md5(prosrc)` of the active-tracks function unchanged; grants service_role only; and after the
  rollback 0 `reason_label` columns and no function.
  Financial 2026-11-09: identity (conn role `postgres.gwxeaygksankbncptlle`, sysid 7678069749886157684, domain
  financial, PG 17.6, client UTF8); pre-check: both columns free, function free, 7 fact rules + 1 default track to
  cover, `user_track_activations` and `user_mlp_data` present, `uat_md5` **fdcb7204…**; apply OK (one transaction,
  `UPDATE 1` × 8, the two DROP CONSTRAINT IF EXISTS NOTICEs are expected); verify: `fact_track_rules.reason_label`
  is_nullable NO / `new_user_tracks.reason_label` YES, both CHECKs present and BITING (23514 for `'...30% utilized'`
  and for `'   '`, both rolled back), 0 rules without copy, all 8 labels read back verbatim, function ACL
  `service_role=X` only, `uat_md5` **fdcb7204… — IDENTICAL to pre-check**; and against live rows:
  Sam → Credit Health / fact / "Because your cards are close to their limits" / `credit_utilization_band=high`
  (estimated) + Getting Oriented / default / "A starting point for everyone"; Sarah → Building a Buffer / fact /
  "Because there isn't much set aside for surprises yet" / `has_emergency_buffer=false` (derived) + the same default;
  0 orphan reasons and 0 unexplained active tracks for both; an unknown user returns 0 rows, not an error.
  Moosii 2026-11-09: identity (conn role `postgres.szhihepbqzbbmxybluql`, sysid 7481590244898220655, domain moosii,
  PG 15.8, client UTF8); pre-check: both columns free, function free, **0 fact rules and 12 default tracks** (no
  Getting Oriented track here, so every populate UPDATE is a no-op — `UPDATE 0` × 8), prerequisites present,
  `uat_md5` **fdcb7204…** (identical to financial's — the fn + view pair of 037 is in sync across projects);
  apply OK; verify: nullability NO / YES as on financial, both CHECKs present and the `new_user_tracks` one BITING
  (23514 for `'Track number 2'` and for `'  '`, both rolled back — `fact_track_rules` is empty here so only that
  half runs), **12 of 12 `new_user_tracks` rows `reason_label` NULL by design** (Moosii's parenting copy is a
  separate content task), 0 fact rules without copy, function ACL `service_role=X` only, `uat_md5`
  **fdcb7204… — IDENTICAL to pre-check**; and against a live user with a `"user"` row (`05184e2a…`): 12 active
  tracks → 12 `default` reasons, every label NULL, 0 orphan reasons and 0 unexplained tracks; unknown user 0 rows.
  NOTED, not caused by 119: Moosii has **13 users with `user_mlp` rows but only 6 with a `public."user"` row**, so
  the other 7 resolve to 0 active tracks today — their stored plans are stale and a rebuild would empty them. That
  is the empty-plan gap in `docs/FINDINGS-plan-reasons.md` §1 / item (i), now measured. For such a user `GET /plan`
  returns the stale items with `why: null` and empty `reasons` — honest, and no error.
- **120 — `activity_finish`: "Not for me" abandons a committed row (R15), AND the migration-115 restore** — **APPLIED financial (2026-11-10) · APPLIED Moosii (2026-11-10).**
  BOTH PROJECTS, one function. R15: `not_for_me` on an existing **committed** row sets `skipped`,
  `resolved_at = now()`, pays nothing and returns the updated row (`created: false`, `awarded: 0`); it leaves the due
  view at once. `resolved_by` stays **NULL**, not `'self'` — `uaf_done_iff_resolved_by CHECK ((status = 'done') =
  (resolved_by IS NOT NULL))` permits it only on a `done` row (23514 otherwise), and a FIRST-call `not_for_me` writes
  NULL too, so both paths produce an identical row (Mark approved keeping the constraint, 2026-11-10).
  ⚠ **IT ALSO REPAIRS A REGRESSION MIGRATION 118 SHIPPED.** 118 rebuilt `activity_finish` from **113's** body
  instead of the then-live **115's**, and 118's pre-check tested `prosrc LIKE '%activity:no_followup_configured%'` —
  a string present in 115's body too — so the rebase error passed unnoticed. Live on BOTH projects from 2026-11-07
  (md5 `f1808f31…`) this dropped: **F42** the `user_lesson_progress {is_completed:true}` upsert; **F44** `did_it` on a
  committed row resolving to done/self and paying `activity_did_it` once (it became a no-op, `awarded: 0`); and the
  **`FOR UPDATE`** row lock. `docs/api-contract.md` §10 documented 115 throughout, so the contract was right and the
  database wrong. 120 re-bases on 115's EXACT body, re-applies 118's `verify_mode` on top and adds R15 — one
  statement, so all four land together.
  **LESSON (why 118's guard was not enough):** a `LIKE` drift check is not a version check. 115 guarded on an exact
  md5; 120 does too, and its guard RAISEs a NOTICE NAMING the body it matched (`f1808f31…` = the regressed 118 body,
  `a4676266…` = 115's, `686e0937…` = 113's → refuse). Any future replacement of this function must do the same.
  UNCHANGED: awards, `resolve_activity_followups`, asks/grace limits, the due view, `mlp_item_pool`, `user_mlp`
  (invariants 1, 8), RLS. No new objects → `database.types.ts` unchanged.
  SECOND SURFACE: the reader never sends `not_for_me` on a committed row — `ActivityEndCard.tsx` returns early when a
  row exists and renders only "I did it" for a `committed` one. R15 is a backend capability with no client surface
  yet; exposing "changed my mind" is reader/RN work.
  Dry run 2026-11-10 on live financial inside `BEGIN … ROLLBACK`: guard matched the regressed 118 body and said so;
  all seven scenarios green; after the rollback 0 follow-ups for Sam and the body md5 back to `f1808f31…`.
  Financial 2026-11-10: identity (conn role `postgres.gwxeaygksankbncptlle`, sysid 7678069749886157684, domain
  financial, PG 17.6); pre-check: md5 `f1808f31…` with has_f42/has_f44/has_lock all `f` (the regression), EXECUTE
  anon/authenticated false + service_role true, 0 follow-ups for Sam; apply OK (the guard NOTICE named the matched
  body); verify: markers f42/f44/FOR UPDATE/R15/verify_mode all `t`, new md5 **`8274975e…`**, privileges unchanged
  (anon/authenticated false, service_role true), and the behaviour suite on Sam + `d9f6e3b4…`, each scenario in its
  own rolled-back transaction — (a) `later` → `not_for_me` gives `skipped` / `resolved_by` NULL / `resolved_at` set /
  `created false` / `awarded 0` and **0 due rows**; (b) a repeat `not_for_me` is a no-op and a `did_it` AFTER the
  abandon leaves it `skipped` / `awarded 0` (skipped is final); (c) **F44 restored** — `later` → `did_it` gives
  `done` / `self` / `awarded 5` (= `lessons.points`) and a second `did_it` pays 0; (d) **F42 restored** —
  `user_lesson_progress` goes from 0 rows to `is_completed true`; (e) `verify_mode` still `data` for the
  statement-date reminder and `self` for the buffer activity; (f) a first-call `not_for_me` is unchanged
  (`skipped` / NULL / `created true` / `awarded 0`). After every rollback Sam was back to 0 follow-ups.
  Moosii 2026-11-10: identity (conn role `postgres.szhihepbqzbbmxybluql`, sysid 7481590244898220655, domain
  moosii, PG 15.8); pre-check: the SAME regressed body, md5 `f1808f31…` with has_f42/has_f44/has_lock all `f`,
  EXECUTE anon/authenticated false + service_role true; apply OK (guard NOTICE named the matched body); verify:
  markers all `t`, new md5 **`8274975e…`** — **byte-identical to financial's**, so the two projects match again
  (invariant 4), privileges unchanged.
  Moosii now HAS an activity (`eed6fa04…` "A short meditation", published, `followup_after_days` 1, no verify
  rule, 5 points) and 2 follow-ups, created SINCE the 119 apply — so the behaviour suite ran here too, against
  real rows, each scenario in its own rolled-back transaction: (a) `not_for_me` on the real `committed` row gives
  `skipped` / `resolved_by` NULL / `resolved_at` set / `created false` / `awarded 0` and **0 due rows**; a repeat
  is a no-op and a `did_it` after it stays `skipped` / 0; (c) **F44** — `did_it` on that row gives `done` / `self`
  / `awarded 5` and a second pays 0; (d) **F42** — on the new-row path for a user with no follow-up,
  `user_lesson_progress` goes 0 rows → `is_completed true`, and `verify_mode` is `self` (the activity has no
  verify rule, per 118's rule). After the rollbacks both original follow-ups were untouched and the test user had
  0 progress rows.
  ⚠ **RESIDUAL DAMAGE, NOT repaired by 120** (120 only fixes the function; F42 fires on the NEW-row path):
  BOTH Moosii follow-ups were created while the regressed body was live, so both have a `completed_items` row but
  **NO `user_lesson_progress` row** — 2 real users whose "A short meditation" will not read as completed on the
  progress surface. The fix is a 2-row data repair (insert `user_lesson_progress {is_completed:true}` for those
  (user, lesson) pairs); it writes live user data, so it waits for its own go. Financial has no such rows: its
  only follow-up from the window was reset away.
- **125 — prompts lockdown: the open INSERT policy goes, one ACTIVE row per `prompt_type`** — **APPLIED financial (2026-11-13) · APPLIED Moosii (2026-11-13).**
  BOTH PROJECTS, same policy and same data shape. `public.prompts` carried a legacy
  `"Enable insert for authenticated users only"` INSERT TO authenticated **WITH CHECK (true)**. There is no UPDATE
  and no DELETE policy, so a client could never change an existing row — but ANY signed-in user could INSERT one,
  and six generation paths pick their row by `prompt_type` + `is_active` + `.single()`
  (`generateLessons.ts:50-54`, `generateQuiz.ts:51-55`, `generateQuestionnaire.ts:62-66`, `reviewLesson.ts:115-119`,
  `coverageAudit.ts:65-69`, `classifyUpdate.ts:49-53`). PostgREST `.single()` errors on zero OR >1 rows, so a second
  active row of a type is never silently substituted — it makes the query FAIL, i.e. one INSERT of
  `{prompt_type:'classify_update', is_active:true}` takes `/classify-update` down for every app user, and the same
  trick kills lesson/quiz/questionnaire generation, the reviewer or the coverage audit. Source: `docs/FINDINGS-roles.md` §6.
  125 drops that policy (no `IF EXISTS` — the pre-check asserts exactly one INSERT policy and that its name is the
  expected one, so a rename or a prior drop stops the file), and adds
  `prompts_one_active_per_type UNIQUE (prompt_type) WHERE is_active AND prompt_type <> 'segment'` so the invariant
  those six calls depend on is structural. **Segment rows are exempt on purpose**: segment content selects by explicit
  `prompts.id` (`generateSegmentContent.ts:50-55`), so many active segment rows are correct — that is the tone library
  (financial 1 of 1 active, Moosii 9 of 10). A NULL `prompt_type` is excluded by the predicate (0 such rows on either
  project).
  UNCHANGED, deliberately: both SELECT policies (`prompts_sel` is still `USING (true)` TO public, so anon can read
  every `system_message` — a separate decision), the other 17 tables carrying `INSERT … WITH CHECK (true)`
  (`docs/rls-sweep.md`), the missing `is_active` filter on `GET /tones` (`src/routes/tones.ts:64-67`), and all code.
  The backend writes `prompts` with the SERVICE ROLE (`/tones`, `/questionnaire-prompt`), which bypasses RLS, so no
  backend or CMS path loses a write it had. No new objects in `database.types.ts` (a policy and an index are not typed).
  Dry run 2026-11-13 on live financial inside `BEGIN … ROLLBACK`: pre-check, DROP POLICY, CREATE INDEX and VERIFY all
  green, then rolled back.
  Financial 2026-11-13: identity (host `aws-0-ca-central-1.pooler.supabase.com`, conn role
  `postgres.gwxeaygksankbncptlle`, sysid 7678069749886157684, domain financial); pre-check printed the policy name
  `'Enable insert for authenticated users only'` and **7 active non-segment rows, all unique per type**
  (`coverage_audit`, `lesson`, `questionnaire`, `quiz`, `review_best_practices`, `review_doc_grounded`,
  `review_factual_smell` — financial has no `classify_update` row); apply OK; verify in a FRESH session: `pg_policies`
  shows **no INSERT policy** and the 2 SELECT policies intact, `pg_indexes` shows
  `CREATE UNIQUE INDEX prompts_one_active_per_type ON public.prompts USING btree (prompt_type) WHERE (is_active AND (prompt_type <> 'segment'::text))`,
  8 prompt rows unchanged.
  Moosii 2026-11-13: dry run with ROLLBACK green first; identity (host `aws-0-us-east-1.pooler.supabase.com`, conn
  role `postgres.szhihepbqzbbmxybluql`, sysid 7481590244898220655, domain moosii); pre-check printed the SAME policy
  name and **8 active non-segment rows, all unique per type** (the 7 financial ones plus `classify_update`, which
  financial has no row for); apply OK; verify in a FRESH session: no INSERT policy, the 2 SELECT policies intact, the
  index definition **byte-identical to financial's**, 18 prompt rows / 17 active / **9 active segment rows** — the
  tone library, exempt by the predicate and the reason `prompt_type <> 'segment'` is in it. The two projects match
  again (invariant 4).

- **126 — approvals gating slice 1: `can_publish`, a structural publish precondition, super_admin-only archival** — **APPLIED financial (2026-11-14) · APPLIED Moosii (2026-11-14).**
  BOTH PROJECTS. Seven changes in one transaction: (1) `"user".can_publish` boolean NOT NULL DEFAULT false,
  set true for `role='super_admin'`, plus `CHECK (role IN ('user','admin','super_admin'))`;
  (2) `DROP TYPE public.role` — orphaned (no column, no code) and MISLABELLED (`'super'`, not `'super_admin'`,
  so anything adopting it would have broken the admin gate); (3) `DROP TABLE users_internal` — empty on both
  projects and read by nothing (`jwtAuth.ts:7`); the local checkouts name it ONLY in their generated
  `database.types.ts`, and `moosii-cms/TODO.md:47` already asked for the drop; (4) `quiz_questions.answer_status`
  DEFAULT `'approved'` → `'pending'`, no backfill; (5) `set_lesson_published` re-based on 068's body behind an
  EXACT md5 guard; (6) a `lessons` BEFORE INSERT OR UPDATE OF `is_published` trigger; (7) `tracks` + `lessons`
  BEFORE UPDATE OF `archived_at` triggers that gate on super_admin and audit into `content_approvals`.
  **ONE definition of "publishable"** — `lesson_publish_blocker(uuid)` returns NULL or the HINT — shared by the
  RPC and the trigger, because 118/115 and the 2026-11-11 rebuild-trigger defect were both two copies of one
  rule drifting apart.
  **Publish** now needs `can_publish` AND ≥1 segment AND every segment `seg_status='complete'` AND no
  `quiz_questions` on those segments with `answer_status <> 'approved'` AND neither the lesson nor its track
  archived. **Unpublish** needs `can_publish` OR `can_approve_clinical`, and re-checks no content.
  HINTs, all ERRCODE `check_violation` (23514), the `content_edit_policy_guard` pattern: `publish_not_permitted`,
  `unpublish_not_permitted`, `publish_not_approved`, `publish_quiz_pending`, `publish_archived`,
  `archive_not_permitted`.
  **Capability is checked by exactly ONE of the two points, never both**: the backend calls the RPC under the
  service role where `auth.uid()` is NULL and the actor is `p_actor_id`, so the RPC checks it and the trigger
  skips it; a Supabase-direct UPDATE has a real `auth.uid()` and no `p_actor_id`, so the trigger checks it. The
  CONTENT rules are checked by both, but the RPC checks them BEFORE its UPDATE, so the trigger is a no-op on
  that path, not a second refusal.
  `content_approvals`: `action` gains `archive`/`unarchive`, `entity_type` gains `track`, and `actor_id` is
  relaxed to nullable with `CHECK (actor_id IS NOT NULL OR action IN ('archive','unarchive'))` — invariant 7's
  guarantee is preserved exactly where it already applied, and a no-JWT archive (psql, SQL editor) is admitted
  explicitly with `actor_role='service'`.
  NOTHING IS REWRITTEN but `"user".can_publish`: every check runs only on a `false→true` transition, so the
  5 Moosii published lessons with pending quiz questions and the 4 published under archived tracks stay
  published. VERIFY asserts the counts before and after.
  **Local harness `docs/drafts/126-publish-gating/`** (PG 17 cluster from a read-only Moosii schema dump;
  restored schema verified identical to live — `set_lesson_published` `d418d1eb…`, `user_active_tracks_for_user`
  `fdcb7204…`, 355 policies). 32 cases green: every refusal HINT, both happy paths, publish/unpublish through
  BOTH the RPC and the direct path, an unknown id still `{found:false}`, a NULL actor still 22004, a lesson
  cannot be INSERTed already published, super_admin archive OK + audited, plain-admin and clinical-admin archive
  refused, no-JWT archive allowed and audited with a NULL actor, and a re-apply refused by the md5 guard.
  The suite caught a real defect in the first draft: `SELECT true INTO v_found` is NULL when no row matches, so
  an unknown lesson was reported `publish_not_approved` instead of `not_found` — fixed with `IF NOT FOUND`.
  Financial 2026-11-14: dry run with ROLLBACK green first; identity (host `aws-0-ca-central-1.pooler.supabase.com`,
  conn role `postgres.gwxeaygksankbncptlle`, sysid 7678069749886157684, domain financial); pre-check matched
  md5 `d418d1eb…`, 1 super_admin, 10 published+unarchived lessons of which 0 with a pending quiz; apply OK;
  verify in a FRESH session — `super_admin` 1/1 with `can_publish`, `users_internal` and `public.role` gone, quiz
  default `'pending'`, all three triggers present, `content_approvals` carrying the new `content_approvals_actor_required`
  CHECK, 10 published lessons unchanged, and the new body md5 **`4476a4ba64abf655b01a812b71d3f269`** —
  byte-identical to the harness. **Any future replacement of this function must guard on `4476a4ba…`.**
  Moosii 2026-11-14: dry run with ROLLBACK green first; identity (host `aws-0-us-east-1.pooler.supabase.com`,
  conn role `postgres.szhihepbqzbbmxybluql`, sysid 7481590244898220655, domain moosii); pre-check matched the
  SAME md5 `d418d1eb…`, **2 super_admins**, 11 published+unarchived lessons of which **5 carry a pending quiz
  question**; apply OK; verify in a FRESH session — 2/2 super_admins have `can_publish` and the **2 plain admins
  have none**, `users_internal` and `public.role` gone, quiz default `'pending'`, all 3 triggers present, the 11
  published lessons unchanged WITH their 5 pending quizzes, and body md5 **`4476a4ba…`** — byte-identical to
  financial's and to the harness, so the two projects match (invariant 4).
  ⚠ **Those 5 Moosii lessons are now one-way**: they stay published, but unpublishing any of them means it
  cannot be re-published until its quiz question is approved (`publish_quiz_pending`). Same for the 4 published
  lessons under archived tracks (`publish_archived`). Mark accepted this on 2026-11-13/14.
  ⚠ **The 2 plain admins lost publish and archive** on Moosii. Granting `can_publish` is a one-row UPDATE per
  user; archival is super_admin only by decision.
  `database.types.ts` regenerated from Moosii after this apply: `can_publish` on `user`, `users_internal` and the
  `role` enum gone, `lesson_publish_blocker` / `user_can_publish` / `user_can_unpublish` added
  (9 insertions, 29 deletions; `npx tsc --noEmit` clean, `npm test` 321/283 pass/0 fail/38 skipped).
  FOLLOW-UP, not in this slice: the routes still surface a refusal as **500 `db_error`** until slice 2 maps the
  HINT to 403/409.

- **127 — test accounts: `is_test_account`, a two-depth reset, and an audit of both** — **APPLIED financial (2026-11-18) · APPLIED Moosii (2026-11-18).**
  BOTH PROJECTS. Seven parts in one transaction: (a) `"user".is_test_account` boolean NOT NULL DEFAULT false,
  deliberately **UNGRANTED** — 112 revoked table-level INSERT/UPDATE from anon/authenticated and granted exactly
  4 INSERT / 10 UPDATE columns, so a NEW column is unwritable by a client and a self-write is refused 42501
  before any policy runs; (b) `test_account_flag_guard()` + a BEFORE UPDATE **OF is_test_account** trigger that
  raises `test_account_not_permitted` (23514) when `auth.uid()` is non-NULL and not super_admin; (c)
  `test_account_events` — append-only audit (`flag`/`unflag`/`reset_activity`/`reset_full`, actor, jsonb detail),
  RLS on, no client write grant, one super_admin SELECT policy; (d) `set_test_account(p_user, p_flag, p_actor)`
  and (e) `reset_test_account(p_user, p_depth, p_actor)`, both SECURITY DEFINER with a pinned `search_path` and
  EXECUTE for `service_role` only (094); (f) `onboarding_complete` SET NOT NULL; (g) a seed step flagging the two
  known CMS accounts, `actor_role='migration'`.
  **RLS is NOT one of the three guards.** The live UPDATE policy on `"user"` is a single `user_self_update` whose
  qual is `(id = auth.uid()) OR is_super_admin() OR (auth.role() = 'service_role')`, and policies OR together — so
  RLS alone permits an account to write its own row. The guards are PRIVILEGE (no column grant), TRIGGER, and the
  TS route check; the migration header records this.
  **`reset_test_account` depths**: `activity` wipes what the parent DID (the classify subtree by user_id and by
  child_id, `child_milestones`, the activity tables via a `to_regclass` + `format()` loop that handles
  `starred_items."user id"` and reports `quiz_user_progress` as `skipped_no_user_column`, `user_facts` where
  `source IN ('derived','manual')`, and zeroes `moosies` — 111's award trigger fires on INSERT only and nothing
  reverses it on DELETE); `full` additionally wipes onboarding, `user_facts` where `source IN ('platform_api',
  'estimated')`, `children`, and resets the profile columns. **Never touched at either depth:** the user row's
  identity, `role`, capabilities, or `user_facts` where `source='seed'` (the demo outcome story).
  **RE-RUNNABLE**, unlike 126 — every step is IF NOT EXISTS / DROP IF EXISTS + CREATE, the seed is idempotent
  (`changed:false`, no second audit row), and VERIFY passes on a second run.
  **Local harness `docs/drafts/127-test-accounts/`** (PG 17 cluster from a read-only Moosii schema dump; the
  fidelity gate is the grants on `"user"` — `authenticated` table UPDATE/INSERT `f`/`f`, column INSERT 4 /
  UPDATE 10 — plus 354 policies). The behaviour suite is a node test file
  (`src/lib/__tests__/testAccounts.db.test.ts`, skips without `MOOSIE_TEST_DB_URL`), 14 cases green.
  **It caught a real defect in the first draft**: the full reset set `birth_date = NULL`, but `"user".birth_date`
  is NOT NULL DEFAULT `now()` on both projects, so a full reset would have raised **23502 on every real account**.
  Fixed with `SET col = DEFAULT` for the columns that have one. An empty table would have hidden it.
  Two harness defects of my own, now encoded in its README: Supabase's `ALTER DEFAULT PRIVILEGES` must be applied
  AFTER the restore (before it they grant ALL on every restored table and destroy fidelity), and every expected
  failure needs a SAVEPOINT — a raised exception aborts the transaction and the next statement returns 25P02,
  which carries no HINT, making five *correct* refusals look broken.
  Financial 2026-11-18: identity confirmed read-only first (sysid 7678069749886157684, domain financial, PG 17.6);
  pre-check 3 users / 0 `onboarding_complete` NULLs / 0 true / 3 false, **1 of the 2** seed accounts present, 0
  missing an `auth.users` row, 360 policies; apply OK, `127 SEED: flagged 1`, `127 VERIFY OK`; post-apply
  verification (`docs/drafts/127-test-accounts/verify-live.sql`, read-only) green on all 7 sections — flag
  ungranted f/f/f, 112's grants still 4/10 with no table grant, the trigger column-scoped, the audit table RLS-on
  and write-closed with exactly 1 policy, all 3 functions SECURITY DEFINER + service_role-only,
  `onboarding_complete` NOT NULL, 1 flagged with 1 `flag`/`migration` event and none outside the seed list, and
  **0 reset events** — nothing was reset by the apply.
  ⚠ **`public."user"` is shared infra** (invariant 4): CMS login reads `role`, app onboarding reads the profile.
  Both surfaces are checked after each apply.
  Moosii 2026-11-18: identity confirmed read-only first (sysid 7481590244898220655, domain moosii, **PG 15.8** —
  the harness is PG 17, so the file was re-checked for anything newer than 15; it uses none); pre-check 10 users /
  0 NULLs / **7 true** / 3 false, **2 of the 2** seed accounts present, 0 missing an `auth.users` row, 354
  policies; apply OK, `127 SEED: flagged 2`, `127 VERIFY OK`; verify-live.sql green on all 7 sections, identical
  in shape to financial's — 2 flagged, 2 `flag`/`migration` events, none outside the seed list, 0 reset events,
  and the live data untouched (14 `completed_items`, 358 `children`, 96 moosies). The two projects now match
  (invariant 4).
  ⚠ The `SET NOT NULL` rewrote no row on either project: both had 0 `onboarding_complete` NULLs already. On
  Moosii 7 of the 10 users are onboarded, so a cold start there exercises the RESUMED path; financial's 3 are
  all `false`, so it exercises fresh onboarding.
  FOLLOW-UP, not in this file: the routes (`GET /users/test-accounts`, `PATCH /users/:id/test-account`,
  `POST /users/:id/reset`), `api-contract.md` §12 and the route tests are a separate commit, held; and
  moosii-rn's `onboarding_complete ?? true` coercion is a separate prompt in the app repo.

- **128 — catalog modes: one global mode over a grouped track catalog** — **APPLIED financial (2026-11-19) · APPLIED Moosii (2026-11-20).**
  BOTH PROJECTS, DIFFERENT BACKFILL (branched on `app_settings.domain`). `tracks` gains `test_group`
  (`live` | `mem` | `mdm` | `legacy`, NOT NULL) and `mode_archived`; an append-only
  `catalog_mode_switches` log whose latest row **by `seq`** IS the current mode; a BEFORE INSERT
  default and a BEFORE UPDATE OF archived_at manual-archive trigger on `tracks` (the CMS writes that
  table directly — invariant 4); the same-group rule over all five questionnaire→track paths, as
  statement-level AFTER triggers calling one whole-graph `assert_no_cross_group_links()`; and
  `switch_catalog_mode` / `set_track_group`, SECURITY DEFINER + pinned `search_path` +
  service_role-only EXECUTE (094).
  **NOT an MLP change** (invariant 1): archival is already the single filter plan selection honours
  (invariant 6, 045/046, preserved by 074), so a switch is a bulk archive/unarchive plus one
  `scope:all` rebuild. `mode_archived` is what makes it reversible — it records WHO archived a
  track, so a switch back never resurrects something a human shelved. Two CHECKs keep that honest
  (`mode_archived ⇒ archived_at IS NOT NULL`, `mode_archived ⇒ test_group <> 'legacy'`).
  ⚠ **Trigger order on `tracks` is load-bearing and asserted in VERIFY**: alphabetical, so
  `tracks_archive_guard_trg` (126) gets first refusal and writes its audit row before
  `tracks_mode_archived_sync_trg` normalises the flag. Renaming either reorders them.
  **RE-RUNNABLE** — all DDL is IF NOT EXISTS / DROP IF EXISTS + CREATE, the backfill only touches
  rows whose `test_group` is still NULL, and the seed log row is written only when the log is empty.
  Proven by a second apply in the harness.
  **Local harness `docs/drafts/128-catalog-modes/`** (PG 17 cluster from a read-only Moosii schema
  dump; nine steps: 127 → fixture → 128 → re-apply → 14 behaviour tests
  (`src/lib/__tests__/catalogModes.db.test.ts`) → an undo rehearsal that rolls back). The fixture
  reproduces the ONE real cross-group link, so the harness proves the backfill RESOLVES it rather
  than that a clean graph stays clean.
  **It caught three defects, all invisible on paper**: (1) `current_catalog_mode()` was missing its
  094 revoke/grant and was therefore callable with the anon key through PostgREST — 128's own VERIFY
  failed the apply and named it; (2) the log ordered by `switched_at`, which is the TRANSACTION
  timestamp, so two switches in one transaction tied and the tie-break fell to a random uuid, making
  "the current mode" non-deterministic (a test that passed and failed on alternate runs) — fixed
  with a `seq` identity column; (3) the undo revealed tracks archived BEFORE 128 existed, because it
  looked for `mode_archived` — which the backfill sets on the already-archived `mooselist` rows
  without touching their `archived_at`. The undo now reverses the two id sets the seed row names
  (`backfill_archived_ids` / `backfill_unarchived_ids`) and nothing else.
  Financial 2026-11-19: identity confirmed read-only first (sysid 7678069749886157684, domain
  financial, PG 17.6); pre-apply 7 tracks all active, 0 questionnaires, 126's guard present, 128 not
  applied, `content_approvals` 47 rows (2 `track`); apply OK —
  `128 VERIFY OK: domain=financial mode=live — groups live 7, mem 0, mdm 0, legacy 0 (0 archived,
  0 unarchived by the backfill); cross-group links 0`. Post-apply read-only verification: all 7
  tracks `live` and active, `mode_archived` 0 everywhere, one seed log row (`live`, actor_role
  `migration`, both id lists `[]`), `content_approvals` **still 47** — the apply archived nothing and
  wrote no audit row — all 7 functions SECURITY DEFINER with anon/authenticated `f` and service_role
  `t`, and the five `tracks` triggers in the required alphabetical order.
  **Post-apply `scope:all` rebuild** (amendment, Mark 2026-11-19): job
  `cd782ee9-6a21-47c8-99a7-10022c14404e`, **succeeded** in 1.6 s — 3 users processed, 3 succeeded, 0
  failed. Enqueued through `POST /jobs` with `FINANCIAL_INTERNAL_API_KEY`; the coalesced
  `enqueueRebuildAllIfIdle` route (`POST /mlp/rebuild-all`) needs an admin JWT, and with no rebuild
  in flight the two produce the same single job.
  Moosii 2026-11-20: identity confirmed read-only first (sysid 7481590244898220655, domain moosii,
  **PG 15.8** — the harness is PG 17, so the file was re-checked for anything newer than 15; it uses
  none); pre-apply 70 tracks / 16 active / 30 `mooselist` (0 of them active), 126's guard present,
  128 absent, `content_approvals` 75 rows (5 `track`). Apply OK —
  `128 VERIFY OK: domain=moosii mode=mem — groups live 30, mem 2, mdm 0, legacy 38 (15 archived,
  1 unarchived by the backfill); cross-group links 0`.
  ⚠ **DEVIATION from the measurement, approved (Mark, 2026-11-20): `legacy` is 38, not the measured
  37.** Cause: `test1120` (`b8147f76-12bb-4012-8a87-e18d715ae013`), created and archived through the
  CMS on 2026-11-20 12:12 between the measurement and the apply — one `archive` row with
  `actor_role='authenticated'`, i.e. 126's guard on the CMS path. Being already archived and not
  `mooselist`, the backfill only LABELLED it: no `archived_at` change, no audit row, no effect on any
  plan. It also explains the two other pre-apply deltas (70 tracks not 69, `content_approvals` 75 not
  74). Everything else matched exactly.
  Post-apply read-only verification: **30 `live`** (0 active, all 30 `mode_archived` — the switcher
  owns their pre-existing archival), **2 `mem`** (both visible: `New Parents` and the join-in),
  **38 `legacy`** (0 active, 0 `mode_archived`); active tracks **16 → 2**; mode `mem`;
  `content_approvals` **75 → 91 (+16)** = 15 `archive` + 1 `unarchive`, every one actor NULL /
  `actor_role='service'`; the seed log row's `backfill_archived_ids` holds 15 ids and **matches the
  rows that actually got an `archive` audit row exactly (0 mismatch)**, `backfill_unarchived_ids` is
  the join-in alone; the join-in is `mem` + visible + `mode_archived=false`; all 7 functions
  SECURITY DEFINER with anon/authenticated `f` and service_role `t`; and the five `tracks` triggers in
  the required alphabetical order.
  The 15 archived, with lesson counts: `Baby Sleep  - mm` (8), `Fine Motor | Typical Dev` (16),
  `Parental Sleep Problems` (5), **`Single parent challenges` (1 lesson, 1 PUBLISHED — accepted,
  Mark 2026-11-19)**, `test` (0), and 10 empty `… | Typical Dev` / `… | Standard` shells.
  ⚠ **STALE-PLAN WINDOW:** the apply changes which tracks are selectable but rewrites no plan, so
  `user_mlp` still held items from the 15 archived tracks until the `scope:all` rebuild ran. On Moosii
  that rebuild was triggered by Mark from the CMS MLP management screen, not by this seat — there is
  no local key for the Moosii service's `/jobs` and `POST /mlp/rebuild-all` needs an admin JWT.
  FOLLOW-UP, not in this file: the three routes, `api-contract.md` §13 and the route/unit tests are a
  separate commit.

- **129 — the approval image gate: an un-adjudicated candidate holds a segment out of `complete`** — **APPLIED financial (2026-11-25) · APPLIED Moosii (2026-11-25).**
  BOTH PROJECTS, schema only, **no rows written**. Slice A1's structural half.
  `recompute_seg_status` — the SINGLE writer of `segments.seg_status` — gains ONE clause: a card with
  **no approved image but an un-adjudicated candidate** keeps its segment `pending`. A replacement
  candidate **beside** an approved image does NOT block, which is the whole asymmetry: pressing
  regenerate on a published lesson must not drop it to `published_unreviewed`, because the live
  picture is still the approved one. A new `content_images_recompute()` + `content_images_recompute_trg`
  (AFTER INSERT OR DELETE OR UPDATE **OF status**) makes the gate fire on image movement without
  writing `seg_status` itself, so the single-writer rule is preserved.
  **Guarded on the EXACT pre-129 md5** `660ed036da2cf30d2886244d850e7dab`, compared after stripping
  CR — the 118/120 rule, not a `prosrc LIKE`. VERIFY asserts the new body carries the clause (matched
  on the SQL `ci.status = 'candidate'`, never on a comment's wording), the trigger's scope, the 094
  grants, and that the **056/066/092/093** function bodies are byte-identical
  (`sub_segments_reset_review` `947187be…`, `quiz_reset_review` `46edd210…`,
  `sub_segments_image_swap_review` `6d673726…`, `set_card_review_state` `4bb5e0cb…`).
  Post-129 body md5: `017a190fd685972a20924e1a98e16170`.
  **The file re-derives nothing.** Affected segments flip only when something next recomputes them
  (a card transition, an image change, or the stale-complete repair), so an apply cannot change what
  a parent sees on its own. Measured read-only before the apply: **financial 0 segments, Moosii 7**
  — and all 7 Moosii ones already have unapproved cards, i.e. they are already in the 25-segment
  stale-`complete` set (migration 056 ran no re-derive loop; `docs/FINDINGS-complete-with-draft-cards.md`).
  0 correctly-complete segments move on either project.
  **No type change** — functions and a trigger only, so `database.types.ts` is unaffected.
  **UNDO** (four steps, verbatim in the file header): drop the trigger, drop `content_images_recompute()`,
  restore `recompute_seg_status` to the pre-129 body quoted in §1 until it hashes back to
  `660ed036…` and re-apply the 094 revoke/grant, then `SELECT recompute_seg_status(id) FROM segments;`.
  Nothing this file wrote needs undoing.
  **Local harness `docs/drafts/129-approval-safety/`** (PG 17 cluster, port 55435, from a read-only
  Moosii schema dump; ten steps, including a **second apply that must be REFUSED by the md5 guard**
  and 17 behaviour tests, `src/lib/__tests__/approvalGate.db.test.ts`). One of those tests asserts the
  TypeScript `deriveSegStatus` and the SQL agree on every fixture segment — the duplication is
  deliberate (the gate must hold against CMS-direct writes too) and that test is what keeps it honest.
  ⚠ **The dump now already contains 127 and 128**, so this harness asserts they arrived with it
  rather than applying them; re-applying 128 against such a dump fails in its own VERIFY. 128's own
  `run.sh` still applies it and will hit that — logged in `docs/backlog.md` (P3).
  Financial 2026-11-25: identity confirmed read-only first (sysid 7678069749886157684, domain
  financial, PG 17.6); pre-apply the guard md5 matched, `content_images_recompute()` and the trigger
  name both free, 10 `complete` / 3 `pending` segments. Apply OK —
  `129 PRE-CHECK ok on domain financial` →
  `129 VERIFY ok: the gate is live, the trigger is scoped to status, 056/066/093 untouched`.
  Post-apply read-only verification: body md5 `017a190f…`; the trigger present and scoped to
  `UPDATE OF status`; both functions anon/authenticated `f`, service_role `t`; the four
  056/066/092/093 md5s **unchanged**; seg_status **still 10 `complete` / 3 `pending`**; **0** `complete`
  rows violating the new gate and **13/13 segments agreeing** with the gate predicate; lessons
  `10 published_reviewed` / `3 draft`, unchanged.
  Moosii 2026-11-25: identity confirmed read-only first (sysid 7481590244898220655, domain moosii,
  **PG 15.8** — the harness is PG 17, and the file uses nothing newer than 15); the file applied was
  byte-identical to the one that ran on financial (`git diff` clean). Pre-apply the guard md5 matched,
  both new names free, **31 `complete` / 139 `pending`**. Apply OK —
  `129 PRE-CHECK ok on domain moosii` →
  `129 VERIFY ok: the gate is live, the trigger is scoped to status, 056/066/093 untouched`.
  Post-apply read-only verification: body md5 `017a190f…`; the trigger present and scoped to
  `UPDATE OF status`; both functions anon/authenticated `f`, service_role `t`; the four
  056/066/092/093 md5s **unchanged**; seg_status **still 31 `complete` / 139 `pending`** — nothing
  moved, as expected from a file that writes no rows; lessons `11 published_reviewed` / `145 draft`,
  unchanged.
  **The 7 pending re-derivations, confirmed in place:** 7 `complete` segments now violate the gate,
  and **all 7 are inside the pre-existing stale set** — overlap 7, "blocked by the new gate but
  otherwise correctly complete" **0**. For scale: of 31 stored `complete`, 22 have unapproved cards
  and 3 are cardless (25 disagreeing with the derived value, the 056 defect), leaving 6 genuinely
  complete and untouched by this gate. The 7 flip the next time anything recomputes them.
  FOLLOW-UP, not in this file: the stale-`complete` repair + structural guard
  (`docs/FINDINGS-complete-with-draft-cards.md`, decisions still open) is what re-derives those 25.

- **130 — the stale-`complete` repair: re-derive `seg_status`, unpublish what loses its last reviewed segment** — **APPLIED financial (2026-11-26) · APPLIED Moosii (2026-11-26).**
  BOTH PROJECTS, **REVIEW REQUIRED**. Migration 056 added `sub_segments.review_state DEFAULT 'draft'`
  and ran **no re-derive loop**, so every segment already stored `complete` kept that value with
  all-draft cards — 25 Moosii segments since 2026-08-09; financial clean, its content all postdates
  056. Cause proven by an exact timestamp boundary: `docs/FINDINGS-complete-with-draft-cards.md`.
  Every reader gates on `seg_status` alone (the app's `useLesson.ts`, the three RLS SELECT policies,
  `lessons_review_status`, `lesson_publish_blocker`), so a stale row served unreviewed content AND
  reported itself `published_reviewed`.
  **Shape:** snapshot every segment first into `repair_130_snapshot` (the only thing the undo needs;
  RLS on, no policy, service_role only) → re-derive through `recompute_seg_status`, the single
  sanctioned writer, so **no `UPDATE … SET seg_status` appears in the file at all** → unpublish the
  lessons that lose their last `complete` segment **and are reachable** (own `archived_at` NULL and
  their track's too).
  **DECISIONS (Mark, 2026-11-25) D1–D9**, recommendations accepted: re-derive only (D1); unpublish
  the 4 reachable `mem` lessons here and leave the 3 `legacy` ones (D2 — unreachable, so
  unpublishing them is an editorial call); one `scope:all` rebuild after, because the unpublishes
  change `mlp_item_pool` while a re-derive alone would not (D3); re-derive the 12 orphans too,
  deletion backlogged (D4); the `sub_segments.review_state` column REVOKE ships with the
  reset-audit slice (D5); two migrations, repair then guard, so each has a clean undo (D6);
  `lesson_publish_blocker` and the RLS policies keying on CARD state is its own slice (D7); the 9
  unapproved quiz questions on 8 of these segments are **flagged only** — 126's blocker catches
  them on any re-publish and invariant 10 keeps the app from showing them (D8); 065's header gets a
  note and the view is unchanged (D9).
  ⚠ **It WIDENS `content_approvals_actor_required`** to allow a NULL `actor_id` when
  `actor_role = 'migration'`. An `unpublish` row previously had to name an actor, and
  `set_lesson_published` additionally demands `can_publish` — so a migration could only have
  audited itself by impersonating a super_admin, i.e. by putting a false name in an audit table
  (invariant 7 exists to stop exactly that). The alternatives were a false actor or no audit row at
  all. The undo restores the original CHECK, which requires deleting the actor-less rows first.
  **Knock-ons, all intended and VERIFIED rather than assumed:** `lessons.with_quiz` re-derives
  itself through 063's trigger on `segments` (7 Moosii lessons carry `true` and own a re-derived
  segment); `lessons_review_status` starts telling the truth; and the repair writes **no**
  `content_approvals` row for a re-derive, because resets are unaudited today — the snapshot table
  is the traceability.
  **RE-RUNNABLE**, and honest about it: the snapshot is taken once and NOT retaken, so a second
  apply still reports the change count relative to the ORIGINAL state while unpublishing 0.
  **Measured read-only 2026-11-26** — Moosii: 170 segments → **25 change, every one
  `complete` → `pending`, 0 the other way**, 12 orphans, 17 with a stale `approved_by`; 13 distinct
  lessons each with exactly ONE segment (so `complete_after = 0` for all); 7 published, of which 4
  reachable `mem` (unpublished) and 3 `legacy` (left alone). financial: 13 segments → **0**.
  Financial 2026-11-26: identity confirmed read-only first (sysid 7678069749886157684, domain
  financial, PG 17.6); 129's body live, and `repair_130_snapshot` / `seg_status_derived` /
  `segments_status_derived_guard_trg` all free; pre-apply 10 `complete` / 3 `pending` / 10
  published. Apply OK — `130 PRE-CHECK: 13 segment(s), 0 will change` →
  `130 SNAPSHOT: 13 segment(s) recorded` → `130 RE-DERIVE: 13 recomputed, 0 changed` →
  `130 UNPUBLISH: 0 lesson(s)` → `130 VERIFY ok`. Post-apply read-only: **0 segments changed, 0
  lessons unpublished, 0 `actor_role='migration'` audit rows**; 10 `complete` / 3 `pending` / 10
  published unchanged; `lessons_review_status` 10 `published_reviewed` / 3 `draft` unchanged; the
  snapshot holds all 13 segments; the widened CHECK in place; `repair_130_snapshot` RLS on with 0
  policies. **A pure no-op, as measured.**
  **UNDO** (verbatim in the file header, rehearsed in `docs/drafts/130-stale-complete/undo.sql`):
  drop 131's guard FIRST — it refuses the undo's own `seg_status` write — restore `seg_status` +
  `approved_by` from the snapshot, **then** `is_published` (126's content precondition refuses to
  re-publish a lesson with no `complete` segment, so the order is forced), restore the CHECK after
  deleting the actor-less rows, drop the snapshot, re-create the guard, then one `scope:all`
  rebuild. On Moosii the `seg_status` write needs the table owner (057 revokes the column), i.e. an
  apply via psql as `postgres`.

  Moosii 2026-11-26: identity confirmed read-only first (sysid 7481590244898220655, domain moosii,
  **PG 15.8**); the file applied was byte-identical to the one that ran on financial (`git diff`
  clean); 129's body live, all three new names free; pre-apply **31 `complete` / 139 `pending` / 11
  published**. Apply OK and EXACTLY as measured — `130 PRE-CHECK: 170 segment(s), 25 will change
  (25 complete->pending, 0 pending->complete)`, the 7 affected published lessons each NAMED with
  its group and reachability, then `130 SNAPSHOT: 170 segment(s) recorded` →
  `130 RE-DERIVE: 170 recomputed, 25 changed` (every id logged) → `130 UNPUBLISH: 4 lesson(s)` →
  `130 VERIFY ok`.
  **The 25:** 13 lesson-attached + **12 orphans**, all `complete` → `pending`, 0 the other way.
  **The 4 unpublished** (reachable `mem`, each with its own anonymous audit row — `unpublish`,
  `actor_id` NULL, `actor_role='migration'`, and `published_by` cleared): *Babyproofing Your Home
  for a Crawler* (7bdd7b8b), *Bringing your baby home from the hospital* (bcbd4eea), *Handling Your
  Newborn Safely* (9f707e77), *Newborn Feeding Basics* (ab0a4e77).
  **The 3 left alone** (`legacy`, tracks archived, so unreachable): *Balancing Work and Family
  Time*, *Managing Stress and Finding Support as a Single Mom*, *Understanding Your Premature
  Baby's Cues* — all three now report `published_unreviewed` with 9 / 7 / 8 cards awaiting
  editorial, which is the first time that view has told the truth about them.
  Post-apply read-only: **6 `complete` / 164 `pending` / 7 published**; snapshot covers all 170
  segments and records exactly 25 changed + 4 lessons; **0** segments disagree with
  `seg_status_derived`; 4 `actor_role='migration'` audit rows; `with_quiz` true on 4 lessons, down
  from 11 — re-derived by 063's trigger with no intervention; `lessons_review_status` now 149
  `draft` / 4 `published_reviewed` / 3 `published_unreviewed`.
  ⚠ **D8, as flagged:** 9 `pending` quiz questions still sit on 8 of the 25 re-derived segments.
  Untouched by design — 126's blocker catches them on any re-publish (`publish_quiz_pending`) and
  invariant 10 keeps the app from showing them.
  Note: `844f2a80` (*Understanding SIDS and Safe Sleep Practices*) is the **negative-control
  lesson** with the planted error. It was in the 25 and is unpublished; it was only RE-DERIVED —
  nothing regenerated it.
  ⚠ **D3's `scope:all` MLP rebuild is still OUTSTANDING on Moosii** (2026-11-26). This seat cannot
  enqueue it: `INTERNAL_API_KEY` reaches only a LOCAL dev server, there is no local key for the
  Moosii service's `/jobs`, `POST /mlp/rebuild-all` needs an admin JWT, and a local server cannot
  stand in because `.env` carries `DOMAIN=financial` against Moosii's `SUPABASE_URL` — the boot
  check (invariant 4) correctly refuses that combination. Same situation as 128's Moosii rebuild,
  which Mark fired from the CMS MLP management screen. **Until it runs, 33 `user_mlp` rows across
  18 users still point at the 4 unpublished lessons.** `mlp_item_pool` is a VIEW that EXPOSES
  `is_published` rather than filtering on it (the selection code filters), so the pool already
  reports those 4 as unpublished and one rebuild is enough to clear the plans.
- **131 — `seg_status` may only ever hold the DERIVED value** — **APPLIED financial (2026-11-26) · APPLIED Moosii (2026-11-26).**
  BOTH PROJECTS, schema only, no rows, **REVIEW REQUIRED** (it refuses a write that is legal today).
  Extracts **`seg_status_derived(uuid)`** so the writer and the guard share ONE definition, rebases
  `recompute_seg_status` on it (behaviour identical; md5-guarded on the 129 body
  `017a190fd685972a20924e1a98e16170`), and adds `segments_status_derived_guard_trg` —
  `BEFORE UPDATE OF seg_status ON segments` — refusing any value that is not
  `seg_status_derived(id)`, **in either direction**, with `23514` and HINT `seg_status_not_derived`.
  "Wrong in the safe direction" is still wrong: a silent demotion would hide from the audit that
  the reset-audit slice is about to add.
  **Why extract rather than duplicate:** a guard that re-implemented the rule would eventually
  disagree with the writer it guards, and then the guard would be the bug.
  `src/lib/approvalSafety.ts deriveSegStatus` stays the TypeScript mirror, and
  `src/lib/__tests__/staleCompleteRepair.db.test.ts` asserts the two agree on every fixture segment.
  **Measured first:** `recompute_seg_status` is the ONLY function in `public` on either project
  whose body writes the column (1 row for a `SET seg_status` match on `prosrc`), and the only
  TypeScript path is that RPC (`src/lib/cardReview.ts:15`) — so the guard refuses nothing any
  caller does today. On Moosii 057 already revokes the column from every role but `postgres`;
  **on financial 057's revoke is ABSENT** (table-wide UPDATE to anon/authenticated/service_role, 23
  of 23 columns, restored by the schema dump that built it), so financial is the project this guard
  actually protects.
  ⚠ **INSERT is deliberately NOT guarded.** A segment is inserted before any card exists, so the
  derived value is always `pending` then and an INSERT guard would fire on every ordinary create.
  `create_lessons_with_segments` is the only function that inserts `segments` and never mentions
  `seg_status` (measured), so the column takes its `'pending'` DEFAULT. The residual hole is a
  hand-written `INSERT … (seg_status) VALUES ('complete')`, corrected by the first recompute.
  **PRE-CHECK refuses to guard a lying table:** if any row still disagrees with the derivation it
  raises and names 130, so the two cannot be applied out of order (D6). Proven in the harness.
  Post-131 md5s: `recompute_seg_status` **`1d6496aa4a2ca26c719493bcf056eae2`**,
  `seg_status_derived` `792e79f121ce93cfd9b53261429bf5ed`, `segments_status_derived_guard`
  `c6d50349250d4461339fcb97d320df4c`.
  **Trigger order on `segments`:** BEFORE triggers fire in NAME order, so
  `segments_status_derived_guard_trg` sorts before `set_updated_at_trigger` ('seg' < 'set') —
  harmless either way, since `set_updated_at` touches only `updated_at`. Renaming either reorders
  them; don't.
  Financial 2026-11-26: apply OK — `131 PRE-CHECK ok on domain financial — 0 disagreeing segments,
  13 segment(s) total` → `131 VERIFY: recompute_seg_status passed the guard on all 13 segment(s)` →
  `131 VERIFY: a hand-written seg_status UPDATE on 28036658… was refused, row unchanged` →
  `131 VERIFY ok`. Post-apply read-only: all three functions SECURITY DEFINER with
  anon/authenticated `f` and service_role `t`; the trigger present and scoped to
  `UPDATE OF seg_status`; 0 segments disagree with `seg_status_derived`.
  Moosii 2026-11-26: apply OK — `131 PRE-CHECK ok on domain moosii — 0 disagreeing segments, 170
  segment(s) total` → `131 VERIFY: recompute_seg_status passed the guard on all 170 segment(s)` →
  `131 VERIFY: a hand-written seg_status UPDATE on 001c90d5… was refused, row unchanged` →
  `131 VERIFY ok`. Post-apply read-only: the three md5s are **identical to financial's**, all three
  functions SECURITY DEFINER with anon/authenticated `f` and service_role `t`, the trigger present
  and scoped to `UPDATE OF seg_status`, and the `segments` trigger order is
  `content_edit_policy_guard_trg` → `segments_status_derived_guard_trg` →
  `segments_sync_with_quiz_trg` → `set_updated_at_trigger`.
  **Local harness `docs/drafts/130-stale-complete/`** (PG 17, port 55436) covers BOTH files in 12
  steps: 131-before-130 refused, 130 applied then re-applied as a no-op, 131 applied then refused
  by its md5 guard, **16 behaviour tests**, and an undo rehearsal that asserts the stale rows come
  BACK — the proof the undo is exact rather than merely clean.
  **UNDO:** drop the trigger, drop `segments_status_derived_guard()`, restore `recompute_seg_status`
  to the 129 body quoted in §2 (must hash back to `017a190f…`) with its 094 grants, drop
  `seg_status_derived(uuid)`. No rows written, nothing else to undo.

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

## Checklist: a project built from a schema dump (e.g. financial)
A `pg_dump --schema=public` carries **objects in `public`, not rows and not project settings**. A
project built that way (financial, 2026-09) starts with the schema and nothing else. Walk this list
against the source project before anyone signs in. Four of these were hit on financial on
2026-09-18, and the database-side gaps below cost migrations 087 and 088.

**Dashboard (not in any dump; compare each screen with the source project):**
- [ ] **Auth → URL Configuration** — Site URL and every Redirect URL (CMS origin, app deep links).
      A missing entry breaks magic links and OTP redirects.
- [ ] **Auth → Email / OTP** — OTP length and expiry, email confirmation on or off, secure email change.
- [ ] **Auth → Email Templates** — every template (confirm sign-up, invite, magic link, change email,
      reset password, reauthentication). The defaults carry Supabase branding and may send a link
      where the app expects a code.
- [ ] **Auth → SMTP** — custom SMTP host, sender name and address. Without it Supabase's shared
      sender applies, with its very low hourly cap.
- [ ] **Auth → Rate Limits** — emails and OTPs per hour, sign-ups, token refreshes, verifications.
- [ ] **Auth → Attack Protection** — CAPTCHA, leaked-password check, minimum password strength.
- [ ] **Storage → Buckets and policies** — buckets are rows and policies live in `storage`, so neither
      comes with a `public` dump. Create only the buckets this deployment uses (`lessons` for the
      backend/CMS, via 087). Do **not** copy Moosii's blanket `allow_all` policies (docs/backlog.md P1).
- [ ] **Edge Functions** — deployed per project, with their own secrets; nothing carries over.
- [ ] **Backend env (Render)** — `DOMAIN`, `SUPABASE_URL` (the **bare origin**
      `https://<ref>.supabase.co` — financial had `/rest/v1/` appended on 2026-09-18 and every sign-in
      got 401), the service-role key **of this same project**, `FACTS_API_KEY` (financial), and the
      CMS build's `VITE_SUPABASE_URL` / `VITE_API_BASE_URL` pointing at this project and its backend.
      Since 2026-09-18 the backend refuses to boot if it cannot read `app_settings` for any reason
      other than the table not existing, so a wrong URL or key now fails the deploy.

**Database, outside `public` (not in the dump; migrations 087/088 fixed these on financial):**
- [ ] **Triggers on `auth.users`** — `new_user_trigger`, `on_auth_user_verified`, `on_user_update`.
      Without them a sign-up creates no `public."user"` row, so the CMS refuses the account and the
      app user gets no default track.
- [ ] **Triggers on `storage.objects`** — the `image_assets` sync/delete pair. Check any function
      that hardcodes the source project's URL or ref (`sync_image_assets_from_storage` did).
- [ ] **Seed rows the schema assumes** — `consts` (sign-up copies it into `user_configurations`;
      without it, completing an item fails and the upcoming-plan view is empty), `app_settings.domain`
      (must be updated from the dumped `'moosii'`), and any prompt/content rows (084).
- [ ] **Scheduled jobs, Vault secrets, realtime publication tables** — per project, never shared.
- [ ] **Diff the non-public objects** of both projects read-only (triggers, functions, policies,
      buckets, cron jobs, publications, event triggers) and account for every difference. Ignore
      Supabase-managed drift such as extension versions and platform roles.

## Cleaning this up (optional, later)
The reconciliation list disappears if you either:
- **(a)** backfill `schema_migrations` with the hand-applied versions, so the runner's
  ledger matches reality; or
- **(b)** adopt a single migration runner going forward, so the folder and the DB stay
  in lockstep.

Until then, this file is the durable definition so the concept doesn't live only in
commit messages and chat history.
