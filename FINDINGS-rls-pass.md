# FINDINGS — RLS pass for signed-in users (both projects)

2026-09-28 · Investigate-first · **no DDL applied.** Drafts: `docs/drafts/rls-pass/102_rls_internal_tables.sql`,
`docs/drafts/rls-pass/103_published_only_content_reads.sql`. Both were applied inside **one rolled-back
transaction per project**, with before/after counts per persona (a temporary helper function in the same
transaction turned permission errors into codes).

## TL;DR

- **Today, any signed-in user** (a Moosii parent, or a demo persona on financial) can read **and update or
  delete** every row of the 15 RLS-off tables. Measured as a Moosii parent: UPDATE reaches 1,124
  `ai_generation_log` rows, 52 `content_approvals`, 12 `prompt_blocks`, 398 `image_assets`, 112 `screen_help`.
  They also read every lesson (154), card (555) and quiz item (84), drafts included.
- **102** enables RLS on all 15. 13 are backend-only (no policy). `screen_help` is admin-only (the CMS edits
  it directly). `topics` is signed-in read (the RN plan's topic labels come through `user_mlp_not_completed`).
  Plus a signed-in read policy on `fact_keys` / `fact_values`, and a revoke of `set_lesson_published` from
  anon/authenticated (an invoker RPC only the backend calls).
- **103**: signed-in **non-admins** read only published, unarchived content (`reader_lesson_visible`, created
  on Moosii with the same body as financial's 096); **admins read everything as today**. It also drops
  `segments_insert_auth` (any signed-in user could INSERT segments).
- **Simulated** (rolled back) on both projects:
  - **CMS admins:** no change on content or `screen_help`. They lose direct access to the 13 backend-only
    tables, which the CMS never reads directly.
  - **Parent:** the RN plan is unchanged: 6 plan rows, 4 topic labels, 4 plan lessons readable.
  - **End users:** drop to published content only. Moosii: lessons 154 → 6, cards 555 → 40. Financial:
    lessons 11 → 1, and fact labels 0 → 6 / 13.
  - **Writes:** every UPDATE by a non-admin → **0 rows**.
  - The backend is unaffected (service_role bypasses RLS).

## 1. Callers (grep of moosii-cms-backend, moosii-cms, moosii-rn, moosii-reader + DB-side)

Client code: `.from('<table>')`, PostgREST embeds, storage uploads (none from clients). DB-side: functions
and views referencing the tables, both projects (identical result).

| Table | Callers (path:line) | Runs as |
|---|---|---|
| `_segment_dedupe_backup` | none | — |
| `ai_generation_log` | backend `src/lib/aiLog.ts` (insert), `src/routes/segments.ts` (read for the CMS prompt panel, via the API) | service_role |
| `content_approvals` | backend `src/lib/approvalLog.ts`; DB `set_lesson_published()` (**INVOKER**, EXECUTE-able by authenticated; called by `src/routes/lessons.ts:211` as service_role) | service_role |
| `content_edits` | backend `src/routes/subSegments.ts` | service_role |
| `image_assets` | backend `src/routes/{lessons,subSegments}.ts`, `src/storage/purgeImages.ts`; DB storage triggers `sync_image_assets_from_storage` / `delete_image_assets_on_storage_delete` (**SECURITY DEFINER**); FK `sub_segments.image` (RI checks run as owner) | service_role / definer |
| `lesson_source_documents`, `source_documents` | backend `src/routes/sourceDocuments.ts`, `src/jobs/handlers/reviewLesson.ts`; the CMS goes through the API (`moosii-cms/src/data/sourceDocuments.ts`) | service_role |
| `notification_log` | none (the legacy daily-reminder is retired); no cron job references it | — |
| `prompt_blocks`, `prompt_block_versions` | backend `src/routes/{tones,structureBlocks,cardPositions}.ts`, `src/jobs/handlers/{generateSegmentContent,reviewLesson}.ts`, migrations | service_role |
| `screen_help` | **moosii-cms `src/data/help.ts:45` (select), `:70` (update), `:72` (insert)** | **authenticated admin** |
| `subscription_plans` | none | — |
| `topics` | **moosii-cms `src/data/reference.ts:34` (select)**; backend `src/routes/lessons.ts`, 3 job handlers; **DB view `user_mlp_not_completed` (security_invoker since 098) joins topics**, read by **moosii-rn `src/hooks/useUpcomingMlp.ts:32`** and **moosii-cms `src/data/classify.ts:75`** | authenticated admin; **authenticated end user (via view)**; service_role |
| `user_tag_actions_MM_unused`, `user_track_actions_MM_unsed` | none | — |
| `fact_keys`, `fact_values` | backend `src/facts/db.ts` (vocabulary); **moosii-reader outcomes view (planned)** | service_role; authenticated end user (planned) |
| `lessons`, `segments`, `sub_segments`, `quiz_questions`, `quiz_answers` | **CMS** `src/data/{lessons,cards,batchUnits,trackImages,trackReview,priorities}.ts` (read + write); **RN** `src/hooks/useLesson.ts:24,34,48`, `useQuiz.ts:13,25`, `useCompletedItems.ts:34`, `useUpcomingMlp.ts:49`; **reader** `src/data/useLesson.ts:88`, `useQuiz.ts:61` (anon today; authenticated after demo sign-in); backend (service_role) | admin / end user / anon / service_role |

**CMS role:** the CMS renders nothing unless `is_admin()` is true (`moosii-cms/src/App.tsx:62-74`, `NotAuthorized`),
so every CMS session is admin or super_admin. **No client repo calls any of the 13 backend-only tables.**

## 2–4. Proposed policies

| Table | RLS | anon | authenticated non-admin | admin (`is_admin()`) | service_role |
|---|---|---|---|---|---|
| 13 backend-only tables | **on**, no policy | none (099) | **none** | **none** (CMS goes through the API) | bypass |
| `screen_help` | **on** | none | none | **ALL** (`screen_help_admin_all`) | bypass |
| `topics` | **on** | none | **SELECT** (all rows) | SELECT | bypass |
| `fact_keys`, `fact_values` | on (already) | none | **SELECT** (new) | SELECT | bypass |
| `lessons` | on | financial reader policy (096) unchanged | **SELECT where `reader_lesson_visible(id)`** | SELECT all + existing writes | bypass |
| `segments` | on | (096) unchanged | SELECT `seg_status='complete'` of a visible lesson; **INSERT removed** | SELECT all + existing writes | bypass |
| `sub_segments` | on | (096) unchanged | SELECT cards of such a segment | all | bypass |
| `quiz_questions` | on | (097) unchanged | SELECT `approved` on such a segment | all | bypass |
| `quiz_answers` | on | (097) unchanged | SELECT answers of a visible question | all | bypass |
| `set_lesson_published()` | — | EXECUTE revoked | **EXECUTE revoked** | revoked (backend only) | EXECUTE |

The end-user rule is exactly the 096/097 anon reader rule, so the reader behaves the same signed in or
not, and the RN app's reads (`useLesson` takes the first `complete` segment, `useQuiz` reads approved
questions) are all inside it. Admin checks use `(SELECT public.is_admin())` so Postgres evaluates it once
per query, not per row.

Full SQL: `docs/drafts/rls-pass/102_rls_internal_tables.sql` and `…/103_published_only_content_reads.sql`.

## 5. Simulation (rolled back, both projects)

Personas via `SET ROLE` + `request.jwt.claims`:
- **Moosii:** end user = the `role='user'` parent with the most plan rows; plain admin; super_admin.
- **Financial:** end user = Sam; super_admin. **There's no plain admin on financial**, so that column is n/a.

**Reads (row counts, before → after; one value = unchanged):**

| | Moosii anon | Moosii parent | Moosii admin | Moosii super_admin | Fin anon | Fin Sam | Fin super_admin |
|---|---|---|---|---|---|---|---|
| ai_generation_log | denied | 1124 → 0 | 1124 → 0 | 1124 → 0 | denied | 121 → 0 | 121 → 0 |
| content_approvals | denied | 52 → 0 | 52 → 0 | 52 → 0 | denied | 7 → 0 | 7 → 0 |
| image_assets | denied | 398 → 0 | 398 → 0 | 398 → 0 | denied | 37 → 0 | 37 → 0 |
| prompt_blocks | denied | 12 → 0 | 12 → 0 | 12 → 0 | denied | 4 → 0 | 4 → 0 |
| prompt_block_versions | denied | 0 | 0 | 0 | denied | 1 → 0 | 1 → 0 |
| content_edits / lesson_source_documents / source_documents / subscription_plans / _segment_dedupe_backup | denied | 8/3/1/2/14 → 0 | same → 0 | same → 0 | denied | 0 | 0 |
| screen_help | denied | **112 → 0** | **112** | **112** | denied | 0 | 0 |
| topics | denied | **12** | 12 | 12 | denied | **8** | 8 |
| fact_keys / fact_values | 0 | 0 | 0 | 0 | 0 | **0 → 6 / 0 → 13** | 0 → 6 / 0 → 13 |
| lessons | 0 | **154 → 6** | 154 | 154 | 1 | **11 → 1** | 11 |
| segments | 0 | 168 → 6 | 168 | 168 | 1 | 11 → 1 | 11 |
| sub_segments | 0 | 555 → 40 | 555 | 555 | 7 | 36 → 7 | 36 |
| quiz_questions | 0 | 84 → 5 | 84 | 84 | 1 | 5 → 1 | 5 |
| quiz_answers | 0 | 330 → 20 | 330 | 330 | 4 | 20 → 4 | 20 |

(`notification_log`, the two `_MM_` tables: 0 rows everywhere. Moosii's fact vocabulary is empty, since
075 was financial-only.)

**Writes (`UPDATE t SET <first column> = <first column>`, rows affected, before → after):**

| | Moosii anon | Moosii parent | Moosii admin | Moosii super_admin | Fin anon | Fin Sam | Fin super_admin |
|---|---|---|---|---|---|---|---|
| ai_generation_log | denied | **1124 → 0** | 1124 → 0 | 1124 → 0 | denied | **121 → 0** | 121 → 0 |
| content_approvals | denied | **52 → 0** | 52 → 0 | 52 → 0 | denied | **7 → 0** | 7 → 0 |
| image_assets | denied | 398 → 0 | 398 → 0 | 398 → 0 | denied | 37 → 0 | 37 → 0 |
| prompt_blocks | denied | **12 → 0** | 12 → 0 | 12 → 0 | denied | **4 → 0** | 4 → 0 |
| prompt_block_versions | denied | 0 | 0 | 0 | denied | 1 → 0 | 1 → 0 |
| screen_help | denied | **112 → 0** | **112** | **112** | denied | 0 | 0 |
| topics | denied | 12 → 0 | 12 → 0 | 12 → 0 | denied | 8 → 0 | 8 → 0 |
| content_edits / lesson_source_documents / source_documents / subscription_plans / _segment_dedupe_backup | denied | 8/3/1/2/14 → 0 | → 0 | → 0 | denied | 0 | 0 |
| fact_keys / fact_values | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

**Surface checks:**
- **RN parent (Moosii):** own `user_mlp_not_completed` 6 → 6; topic labels in it 4 → 4; plan lessons
  readable 4 → 4; own `completed_items` 0 → 0 (readable). **The plan works unchanged.**
- **Sam (financial reader persona):** own plan 1 → 1 (with topic label); published lesson, its segment,
  7 cards, 1 question, 4 answers readable; fact labels now readable.
- **CMS admin / super_admin:** all content counts unchanged; `screen_help` update 112 → 112. The CMS reads
  no backend-only table directly.
- **Admins lose direct write on `topics`** (12 → 0). The CMS only reads topics; writes go through
  migrations and the backend. If a topic editor is ever wanted, add an admin write policy then.

## 6. Migrations, apply order, verification

| # | File (draft) | Projects | Order |
|---|---|---|---|
| 102 | `102_rls_internal_tables.sql` | both | financial → Moosii |
| 103 | `103_published_only_content_reads.sql` | both | financial → Moosii, after 102 |

Numbering: these take **102/103**. The demo-personas proposals shift: `seed` source → **104**,
`demo_outcome_series` → **105**. The fact-vocabulary read is folded into 102 here, and published-only
reads are 103.

Apply per `migrations/README.md`: guardrails → pre-check → the same rolled-back simulation as above →
apply → rerun the simulation against the live policies (read-only) → report per project.

**Mark's checks afterwards:**
- **CMS as a plain admin (Moosii):** lessons list (drafts visible), open a draft lesson (cards and quiz
  load), edit a card, the help panel on any screen (load + save), the topic dropdown in lesson create, the
  priorities page, the classify console for another user. Everything as before.
- **CMS as super_admin (financial):** same list, plus generate content and an image for one card (backend
  path: must be unaffected).
- **RN, fresh parent (Moosii):** sign up → onboarding → Home shows the plan (items with topic colour and
  label) → open a lesson (cards + quiz) → complete it → it leaves the plan. A draft lesson id opened directly
  must not load.
- **Reader (financial):** anon lesson + quiz as today (096/097 unchanged); once demo sign-in exists,
  signed in as Sam the same lesson loads, and the plan shows Credit Health / Getting Oriented.
- **Negative, any signed-in non-admin:** `select count(*) from prompt_blocks` → 0; an UPDATE on
  `content_approvals` → 0 rows; `rpc('set_lesson_published', …)` → 42501.

## Not in scope / flagged
- `user_configurations` stays readable by every signed-in user (`auth.uid() IS NOT NULL`). It's per-user
  data, outside this brief's list; 078-style own-or-admin is a one-policy follow-up.
- The duplicate write policies on content tables (`admin_can_*` and `lessons_*` / `qq_*` / `qa_*`) are
  redundant but harmless; left alone.
- Dropping the three dead tables (`_segment_dedupe_backup`, the two `_MM_` tables) is a later cleanup; RLS on
  is enough now.
