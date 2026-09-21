# CLAUDE.md — Moosii CMS Content-Generation Backend

## What this is
The content-generation backend for Moosii's CMS (phase 2). Moosii is a parenting-
education mobile app; this backend powers the internal admin tool that creates and
approves the content the app delivers, plus a few app-facing routes (MLP recompute,
update classification) and, on the financial deployment, a partner facts intake.
One codebase serves TWO deployments — `moosii` and `financial` — each with its own
Render service and its own Supabase project (see invariant 4).

It is an INTERNAL ADMIN TOOL: ~3 trusted users, desktop, not a public product.
Priorities, in order: fast to build, easy to maintain, easy to debug. Scale,
concurrency, and hardening against untrusted users are explicitly NOT priorities.
Solo developer who leans on AI assistance and values control, visibility, and
debuggability over managed convenience.

## Invariants and traps
Read this first. **Hard cap ~12 entries:** an invariant earns a slot ONLY if violating it
breaks something across a surface boundary (CMS↔app, backend↔DB, provider↔caller, partner↔DB) or
corrupts data. Anything narrower belongs in `api-contract.md`, `docs/architecture-notes.md` or a
code comment. If this section is full, one must be argued out before another goes in. Format is
fixed: one line of rule, one line of file/line evidence.

1. **The MLP algorithm is FROZEN** — flag any slice that touches it before writing code. The ONE sanctioned deviation is CHANGE 4 (2026-09, defect fix only): no usable age → no age tilt, plus a finiteness guard that throws `MlpInvalidWeights` where the round-robin used to loop forever; ranking for every valid input is byte-identical, proven by `npm test` against a frozen pre-fix copy + snapshot.
   → `src/mlp/generateFullMLP.ts:1-20` (faithful BuildShip port: "logic kept IDENTICAL except deliberate changes"); proof `src/mlp/__tests__/generateFullMLP.hang.test.ts`.
2. **`card_positions` = role-by-position** (first/body/takeaway derived from `sequence`), ONE block SHARED by every segment-gen prompt and the reviewer; card edits keep `sequence` contiguous 1..N; never pin a role per card.
   → `prompts.card_positions_block_id`: `src/jobs/handlers/generateSegmentContent.ts:314`, `regenSegmentContent.ts:127`, reviewer `{{card_positions}}` `reviewLesson.ts:107-121`; renumber `src/routes/subSegments.ts:153` (DELETE).
3. **No real users exist** — prefer structural safety (constraints/FKs/NOT NULL) over behavioral rules; wipe-and-rebuild usually beats careful migration. App free text stays gated: no real parents until clinical sign-off (invariant 11).
   → `migrations/045_archive_exclude_tracks_active_set.sql` ("no live users exist yet"); `ON DELETE RESTRICT` in 038/040 (raises **23503** — verified on PG 17, 2026-09-12; 038's header still says 23001 and is wrong).
4. **Shared infra breaks the OTHER consumer — and the OTHER project.** Within a project the CMS and app share one Supabase; across deployments one codebase + one schema serve moosii AND financial. `DOMAIN` env must equal that database's `app_settings.domain` row or the backend exits at boot. Name the second consumer and the second project before calling an auth/RLS/schema/LLM-provider change done.
   → `src/lib/domain.ts:44` + `src/lib/domainCheck.ts:42` (FATAL mismatch); migration 064; `src/llm/index.ts:24` `providerForModel`; `migrations/037_user_active_tracks_fn.sql` (fn + view "must stay in sync").
5. **Image purge traps** — remove the storage object BEFORE deleting `image_assets` (else the storage-delete trigger raises P0001); and cascade fires on DELETE, not UPDATE, so an in-place card UPDATE must explicitly clear that card's `content_images` and `content_findings`.
   → `src/storage/purgeImages.ts:11-20`; `src/jobs/handlers/regenSegmentContent.ts:251-260`.
6. **Archival is DERIVED, never stamped** — a lesson is archived if `lessons.archived_at IS NOT NULL` OR its track's is; archiving a track does not bulk-update lessons. Archive/unarchive touches no review state.
   → `migrations/045_archive_exclude_tracks_active_set.sql` (header); `migrations/046_archive_exclude_lessons_item_pool.sql`; `FINDINGS-unarchive-approvals.md`.
7. **Actor from the verified JWT, never the request body; a publish and its audit row are ONE transaction.** Approvals, publish and recompute take the user id from the token; `set_lesson_published` raises (no publish) if the audit insert fails or the actor is null — the inverse of `logApproval`'s forgiving contract, for publish only.
   → `migrations/043_content_approvals.sql` (header); `src/routes/mlp.ts:96`; `migrations/068_set_lesson_published_atomic.sql`, called at `src/routes/lessons.ts:211`.
8. **MLP selection converges on two objects** — `user_active_tracks_for_user` + `mlp_item_pool`; age gate, suppression, fact routing and archival all flow through them, so touching either touches every user's plan.
   → `src/jobs/handlers/rebuildMlp.ts:459,506`; migrations 041/045/046/074.
9. **Lesson creation is IDEMPOTENT per (track_id, lesson_name)** — the RPC is insert-or-select, returning the EXISTING row (`created:false`) instead of a duplicate; it never overwrites, and archived rows are exempt so a name can be reused. Before this, the ONLY duplicate protection anywhere was a sentence in an LLM prompt.
   → `migrations/061_lessons_track_name_unique.sql` (partial unique index = the conflict target); `migrations/062_create_lessons_insert_or_select.sql`; readers use `src/lib/lessonCreateResult.ts`.
10. **`lessons.with_quiz` is DERIVED and READ-ONLY — never set it** (a BEFORE trigger overwrites any value you supply). It means "an approved question exists on the segment the APP reads" — first `seg_status='complete'` segment by `segment_order` NULLS LAST, then `quiz_questions` by `segment_id` only (never `lesson_id`), mirroring moosii-rn `useLesson.ts`/`useQuiz.ts`. To give a lesson a quiz, APPROVE A QUESTION.
    → `migrations/063_with_quiz_derived.sql` (`lesson_with_quiz_derive(uuid)` is the single definition; triggers on `quiz_questions`, `segments` AND `lessons`).
11. **Safety distress is NEVER downgraded, and outranks everything.** Response order: safety > health emergency > same_day > overwhelm/strain > routine > ack; any distress tier or a same_day/emergency band replaces the ack. Child-symptom narrowing happens at TWO layers — the prompt (rule 6: parent state, not child symptoms) and code — and may only lower strain/overwhelm. The model extracts findings; CODE picks the band from the child's age and the rules. Every clinical threshold and copy row is `is_provisional` pending the clinical owner.
    → `src/classify/distressNarrowing.ts:6`; `src/classify/responsePrecedence.ts:5`; `migrations/083_classify_prompt_child_health.sql` (rule 6); migrations 080–082; `docs/provisional-clinical-decisions.md` (D1–D13, H-D1..H-D9).
12. **Facts are banded tokens, never amounts, and history is append-only.** A `user_facts` value must be authored vocabulary (FK to `fact_values`, RESTRICT on update AND delete so history cannot be rewritten) and pass the no-numeric CHECK; current value is DERIVED latest-wins. Retire a value by adding a new one.
    → `migrations/070_user_facts.sql:65-72`; `migrations/071_user_facts_latest.sql` (latest-wins view); `docs/api-contract.md` §8.

## The founding rule: no BuildShip, ever
The previous CMS used BuildShip (a visual workflow platform) for AI orchestration.
It was abandoned because it was an opaque, hard-to-debug black box. NEVER suggest,
add, or reintroduce BuildShip or any equivalent visual-workflow platform. Everything
is code the developer owns and can read, version, and debug. This is non-negotiable.

## How work is run (Mark ↔ this seat)
- **One Claude seat per repo.** Other repos (moosii-cms, moosii-rn) are read-only, and only when a
  brief asks; follow-ups for them are flagged in the report for that seat, never edited here.
- **Brief types.** *Investigate / propose* → report with file:line, change nothing. *GO / BUILD-NOW*
  → build to the stated DoD. Decisions Mark states in a brief are settled — don't re-litigate them.
- **Commit locally and HOLD** unless told to push. A push to `master` deploys Render, so it is
  Mark's call. Report per project (financial / Moosii) whenever a change touches both.
- **Verify against live Moosii without writing data**: dry runs (`persist=false, apply=false` on
  `/classify-update`), SQL checks wrapped in a rolled-back transaction, read-only sessions. Do not
  create test rows in Moosii to exercise a path; if the needed data doesn't exist, say so and use
  another method (e.g. re-run the pure function with the missing input).
- Unscheduled work goes in `docs/backlog.md` (P1–P3); investigation reports in `FINDINGS-*.md`.

## Stack
- Express + TypeScript, deployed on Render (paid Starter tier — must stay warm, not
  the free spin-down tier, because in-process jobs would be orphaned on sleep).
- Supabase: Postgres (data) + Storage (image files). Two projects: **Moosii** (live catalog,
  PG 15) and **financial** (PG 17, built from a Moosii schema dump; no content, no prompt rows and
  no auth users yet — so DB-composed prompt jobs fail there until it gets its own content). The
  backend uses the SERVICE-ROLE key and intentionally bypasses RLS.
- Build: `npm install && npm run build`; start: `npm start`; tests: `npm test` (new test files
  must be added to the `test` script in `package.json`). Render injects PORT.
- Auto-deploys on push to `master` (the repo's only/default branch).
- Boot fails fast on: unset/unknown `DOMAIN`; `DOMAIN` ≠ `app_settings.domain`; ANY failure to read
  `app_settings` other than "table does not exist" (42P01/PGRST205 — pre-064 only), which catches a
  wrong `SUPABASE_URL` (it must be the bare origin, no `/rest/v1`) or a key from another project
  (`src/lib/domainCheck.ts` `classifyDomainReadError`); a malformed image prompt file;
  missing/invalid `FACTS_API_KEY` on financial (`src/index.ts:83-101`).

## Architecture: async job pattern
Long AI work (image gen 15–30s, LLM 5–60s, chains 1–3 min) does NOT fit Supabase
Edge Functions, so it lives in this service. The pattern:
- POST /jobs inserts a `queued` row and returns a job_id IMMEDIATELY (202). It does
  NOT hold the connection open while work runs.
- Work runs fire-and-forget in-process (direct kickoff). A stale-job reaper marks
  any job `running` > 10 min as `failed` on startup. No external queue, no worker
  process — not needed at this scale.
- Status is tracked on the `jobs` row. Frontend polls (or reads Supabase directly).
- Jobs are WHOLE-UNIT: a job succeeds or fails atomically. On failure, retry the
  whole job. NO partial-resume / step-checkpoint machinery.
- MLP rebuilds are COALESCED: `enqueueRebuildAllIfIdle` / `enqueueRebuildUserIfIdle`
  (`src/jobs/runner.ts`) join an existing QUEUED job rather than stacking duplicates.

## Job granularity
ONE JOB PER IMAGE. "Generate all images for a lesson" is a FRONTEND concern that fans
out into N independent jobs. The backend has no concept of a lesson batch. (Content
jobs differ — a content job is itself a chained multi-step bundle.)

## Prompt model: base + overlay (images)
The prompt that an LLM uses to WRITE an image prompt is two layers, concatenated every call:
- BASE (`prompts/image/base.md`): universal rules — brand aesthetic, color palette
  (#441C44 purple, #FC570D orange, #BEB400 yellow on white/cream), safety rules
  (bare crib, baby on back), no text, no iconography, "depict a scene/moment not a
  symbol", output format, the metadata template.
- OVERLAY (`prompts/image/topics/{topic_name}.md`): short, topic-specific guidance — WHO
  is in the image, emotional register, topic traps. Keyed by `topics.name`. Not a fallback.
The SEGMENT CONTENT drives the scene; base+overlay only shape HOW it's depicted. Tuning
history: `docs/architecture-notes.md`.
**Domain-scoped (2026-09-18):** a domain with its own folder — `prompts/image/<domain>/` holding
`base.md`, `topics/<name>.md` and `topics/_generic.md` — resolves entirely from it and never falls
back to another domain's files (`imagePromptRoot`, `src/prompts/assemble.ts`). Financial has one
(flat vector, muted palette, hard NO text/numbers/charts/logos). Moosii has none and resolves from the
root, byte-identically (proven against a 45-case pre-change capture). Boot validation covers every
domain folder.

## Model abstraction (general, multi-provider, addressed by name)
LLM access is a GENERAL primitive: `getLLMClient(provider)` where provider is
'gemini' | 'openai' | 'anthropic' — NOT a single getConfiguredLLM(), because a
cross-model pipeline needs MULTIPLE providers simultaneously.
- DB-composed callers derive the provider FROM the row's model (`providerForModel`), never
  choose them independently.
- Interface shape: generate(instructions, input) -> { text, raw, model, version }.
- `ImageGenerator` stays a SEPARATE interface (prompt -> image bytes).
Gemini (text) and OpenAI are implemented; **Anthropic throws "not yet implemented"**
(`src/llm/index.ts:13-14`). Swapping = new implementation + factory entry + env var
(PROMPT_WRITER, IMAGE_GENERATOR).
Every generated artifact (image OR content) records which provider/model/version and
which instruction version produced it — full provenance, so regressions are diffable.

## Data model
- `jobs`: id, type, status (queued/running/succeeded/failed), input/result/error (jsonb),
  created_at/started_at/finished_at. Generic across job types.
- `content_images`: polymorphic — exactly one of lesson_id / segment_id / sub_segment_id
  (check constraint). storage_path, status (candidate/approved/superseded/rejected),
  prompts, provider/model provenance, topic_name (text, not FK), scene, job_id. A partial
  unique index allows at most one `approved` image per owner.
- Content hierarchy: lesson → segment → sub_segment (1:1 lesson:segment today), plus
  `topics` and the quiz tables. `sub_segments.image` stays the app's live-image pointer;
  the backend writes it on approval in addition to `content_images`.
- Review state is DERIVED upward: card `review_state` (draft → editorial_reviewed →
  clinically_approved) → `segments.seg_status` via `recompute_seg_status` only (056) →
  `lessons_review_status` view (065). Content edits reset review via backend routes AND the
  066 triggers (CMS-direct paths). Resets are NOT audited today (backlog P3).
- Users: `public."user"` only partially covers the auth-uid space (an app parent may have no
  row); `user.email` is UNIQUE, NULLs allowed (079). Per-user FKs that must cover every
  signed-in user target `auth.users(id)`.
- Facts (069–076): `fact_keys`/`fact_values` vocabulary, append-only `user_facts`
  (FK auth.users ON DELETE CASCADE, 076), `user_facts_latest` view, `fact_track_rules`.
- Classify: `user_update_events` (+ `health_band`), `distress_detections` (+ `downgraded_from`),
  `health_detections` — audits, backend-only; reference tables `health_red_flags`,
  `health_urgency_rules`, `health_responses` (080–082). Classify writes nothing when
  `persist=false`.
- Per-column rationale (image_path, tone_id, scene, repeat_after_days, image storage
  trigger): `docs/architecture-notes.md`.

## Content prompt composition & tone management (DELIVERED)
Segment content composes its prompt from the DB, not files. A "tone" = one segment
`prompts` row + a 1:1 voice block (`prompt_blocks`), selected by stable `prompts.id`
(NOT the editable display name). Layers: VOICE (per-tone block, `/tones`); STRUCTURE
(reusable library, `/structure-blocks`); SIZE (`content_size_profiles`, `/size-profiles`);
CARD POSITIONS (shared singleton, `/card-positions`); TECHNICAL (system_message, scope,
output_schema — not user-editable). `regen_segment_content` supports per-run overrides of any
editable layer without changing the tone, plus an optional `generate_quiz` (always REPLACES).
A deterministic voice LINT (`voice_lint_rules` + `src/lib/voiceLint.ts`) flags AI-tells into
`jobs.result.lint` (advisory; never blocks). The CMS manages these admin tables through the
API, not direct Supabase writes. Sanctioned CMS-direct write paths are listed in
`docs/rls-sweep.md`.

## Scope
- DELIVERED: image management (v1); lesson generation (`generate_lessons`, nine-field stub
  contract, DB-composed); segment content + quiz (v2); lesson review; MLP recompute
  (`rebuild_mlp`, app-facing `POST /mlp/recompute`); questionnaires/check-ins;
  `/classify-update` (updates, distress, child health — PROVISIONAL); facts intake
  (`POST /facts`, financial only). Canonical detail: `docs/api-contract.md`.
- NOT built: lesson/segment-level images; the generate→critique→revise pipeline and a
  `content_drafts` bundle table; the Anthropic client; the email digest
  (`POST /cron/email-digest`). Digest decisions (2026-09-12, `FINDINGS-financial.md` §F.3): email
  only; send only when there is news; an IANA timezone column waits for the cadence slice; the
  legacy daily-reminder function is retired (reference copy in `docs/legacy/daily-reminder/`).
  Roadmap and rationale: `docs/architecture-notes.md`.
- Frontends live in other repos: the CMS (Vite + React SPA, moosii-cms) and the app (moosii-rn).

## Auth
- **CMS admin routes**: Supabase **JWT** (`Authorization: Bearer <jwt>`) verified via
  `supabase.auth.getUser()`, role and review capabilities from `public."user"` (`role`,
  `can_review_editorial`, `can_approve_clinical`; `users_internal` is NOT read —
  `src/middleware/jwtAuth.ts:6-27`). The route
  set lives in `src/index.ts`; per-route detail in `docs/api-contract.md`.
- **App-facing** (`/classify-update`, `/mlp`): verify the END-USER's Supabase JWT themselves and
  scope to that user; admin callers get the wider mode. Mounted without the admin gate.
- **`/jobs`**: `INTERNAL_API_KEY` shared secret (server-to-server) OR a CMS admin JWT.
- **Partner intake** (`POST /facts`, financial only — 404 elsewhere, checked BEFORE auth):
  `FACTS_API_KEY`, its OWN key scoped to that one route — `INTERNAL_API_KEY` is rejected; compared
  constant-time. Required at boot when `DOMAIN=financial` (≥32 chars, no surrounding whitespace,
  distinct from `INTERNAL_API_KEY`). `GET /facts/:user_id` is admin JWT. See `api-contract.md` §8.
- `/health` and `/version` are unauthenticated.

## RLS posture (after migration 078)
The backend bypasses RLS (service role); RLS governs the app's and CMS's direct clients.
- Per-user tables (`user`, `children`, `completed_items`, `user_facts`, …): own row, or
  `is_admin()` (plain admin, not only super_admin), or service; anon none. Blanket
  `USING (true)` reads are gone.
- Views over them are `security_invoker`, so the base-table policies bind. `is_admin()` /
  `is_super_admin()` are SECURITY DEFINER (required, or policies recurse).
- Audit tables (`distress_detections`, `health_detections`) are RLS-on with NO policy —
  backend-only. Reference config (health rules, fact vocabulary) is signed-in read, admin write.
- **Traps:** a plain (non-invoker) view runs as its owner and bypasses RLS — including when nested
  inside an invoker view. A policy that calls a function reading another RLS table recurses unless
  that function is SECURITY DEFINER. The `postgres` role has BYPASSRLS, so a policy is only tested
  under `SET LOCAL ROLE authenticated` + `request.jwt.claims`.
- Table-by-table list and known app gaps: `docs/rls-sweep.md`.

## API conventions
- **Errors:** `{ error: { code: string, message: string } }` with appropriate HTTP status.
  Helper: `apiError(res, status, code, message)` in `src/lib/errors.ts`.
- **Async jobs:** return `202 { job_id }` immediately; frontend polls the `jobs` table directly
  via Supabase (not via a backend polling endpoint).
- **Additive responses:** app-facing response shapes only GROW — new fields are added, existing
  fields keep their meaning (e.g. `/classify-update` gained `child_health` and `responses[]`).

## Secrets discipline (strict)
- `.env` is gitignored and holds real secrets locally (including `FINANCIAL_DB_URL` /
  `MOOSII_DB_URL` for psql). `.env.example` (committed) is the empty template.
- The Supabase SERVICE-ROLE key bypasses all RLS — it lives ONLY in `.env` and Render env vars.
  NEVER in code, NEVER committed, NEVER sent to any frontend.
- Always verify staged files before committing — confirm `.env` is excluded. Never print tokens,
  user emails or connection strings in output (redact `postgres(ql)://…`).
- **Enforced by `.githooks/pre-commit` (fails closed):** any staged `.env` / `.env.*` at any depth,
  except `.env.example`, refuses the commit; so does any failure to read the staged list.
  `core.hooksPath=.githooks` is set by `npm install` (`prepare`). `.gitignore` covers `.env*` too.
  Never bypass it with `--no-verify` for a `.env` file.
- **The ONE sanctioned secret in the database: a job-scoped key in Supabase Vault.** `pg_net`
  must authenticate the `pg_cron` tick, so each project's Vault holds a key (`CRON_API_KEY`,
  same value as that project's backend env) that gates ONE enqueue-only route
  (`POST /cron/email-digest`, planned). NEVER `INTERNAL_API_KEY`, never the service-role key,
  and no other secret goes in the database. Decided 2026-09-12 (`FINDINGS-financial.md` §F.3).

## AI generation logging
Every AI API call is logged to `ai_generation_log` (migration 005) via `logAiCall()` in
`src/lib/aiLog.ts`. Rules:
- Log in the **handler**, not the provider — handlers have entity context.
- One log row per AI call. Multi-step handlers produce multiple rows tied by a shared
  `correlation_id` (UUID generated once at the top of the handler).
- `related_entity_id` is null for intermediate calls; set it once the entity ID is known.
- Logging failure must NEVER throw or break generation — `logAiCall` catches internally.
- Operation naming: `<artifact>_<action>` — e.g. `image_prompt_generate`, `image_generate`,
  `lesson_generate`.

## Migrations
- **Apply gate.** A migration file is committed as **DRAFT (pending apply)**. Claude applies it
  with `psql` (`FINANCIAL_DB_URL` / `MOOSII_DB_URL`) **only after Mark's go for that batch**:
  FINANCIAL first — confirm the project identity, then pre-check, migration, verification per
  file, stop on any failure — then a report; MOOSII only after a second go, same steps, same
  report. Each project's apply is recorded in its reconciliation entry + high-water, in its own
  commit. If Mark applies by hand in the SQL editor, the entry flips only on his confirmation.
  Never apply without a go; never assume an apply from a file existing.
- **Confirm the project before trusting a connection.** psql is
  `C:/Program Files/PostgreSQL/17/bin/psql.exe`; check the `postgres.<ref>` user,
  `pg_control_system().system_identifier` and `app_settings.domain`. Non-apply sessions are
  read-only. (A local PG 17 service also listens on 5432 — it is not Supabase.)
- **Project-scoped files say so.** A migration that belongs to one project only (data seeds,
  prompt rows) carries `*** MOOSII ONLY ***` / FINANCIAL ONLY in its header and a pre-check on
  `app_settings.domain`. A schema dump carries objects, not rows: seeds never reach the other
  project by themselves.
- **Test before the first apply** on a throwaway local PG 17 cluster restored from a schema-only
  dump of Moosii (stub `anon`/`authenticated`/`service_role`/`authenticator` roles; `auth.uid()` /
  `auth.role()` copied from live). Harnesses: `docs/drafts/rls-078/`, `docs/drafts/facts-v1/local-test/`.
  Trap: `pg_ctl start` hangs unless its stdout/stderr are redirected.
- **Prompt-rewrite migrations are hash-guarded.** They RAISE unless the live `system_message` md5
  is exactly the expected prior text, and they preserve the row's line endings (live rows may be
  CRLF — compare and write after normalizing). Worked example: 083.
- **Migration first, then code; code tolerates the old schema.** Push = deploy, so a feature must
  degrade cleanly if its migration isn't live yet (e.g. classify's child health is `null` unless
  the health tables load AND the prompt's `output_schema` requires `child_health`,
  `src/routes/classifyUpdate.ts:102,142`).
- **Per-project high-water.** From 069 the projects can differ (financial-only or Moosii-only
  files exist). `migrations/README.md` is the only reliable number — never cite one elsewhere.
- **No `CONCURRENTLY`** in migration files — it cannot run in a transaction and a partial run
  leaves an INVALID index. Use the plain form inside `BEGIN`/`COMMIT`.
- **A function return-type change needs DROP + CREATE in ONE transaction** —
  `CREATE OR REPLACE` fails with 42P13; re-grant any explicit privileges the DROP discards.
- **FK errors are 23503** for both RESTRICT and NO ACTION; unique violations are 23505.
- Full rules and worked examples: `migrations/README.md` ("Applying a new migration").

## Conventions
- Build each piece as a standalone, independently-testable module; compose at the end. Test in
  isolation before wiring together. Pure logic goes in pure functions with unit tests (e.g.
  `src/classify/*`, `src/facts/validate.ts`); route files orchestrate.
- Prompt instructions: IMAGE prompts are versioned files (`prompts/image/`). CONTENT and
  classification prompts are DB-composed (`prompts` + `prompt_blocks` + `content_size_profiles`),
  managed via admin CRUD or migrations, not files.
- Prefer minimal formatting and minimal dependencies. Keep it debuggable.
- **Database types** (`src/types/database.types.ts`) are generated from the MOOSII schema via the
  Supabase CLI; regenerate after any schema migration and drop any temporary `(supabase as any)`
  bridge that existed only for a MISSING COLUMN in the same pass:
  `npx supabase@latest gen types typescript --project-id <ref> > <scratch>/new.ts`, verify, then
  move it over. **Never redirect straight onto the real file** (`>` truncates it first). The
  committed file is **CRLF**; the CLI emits LF, so convert on the way in. The ~27 remaining
  `(supabase as any)` bridges are mostly for VIEWS and RPCs the generator does not type — those
  stay.
- **Ad-hoc scripts:** run scripts that import repo code from the repo root (`npx tsx`), so imports
  and `.env` resolve; delete them afterwards. supabase-js on Node 20 needs `ws` for realtime — for a
  one-off query use psql or `fetch` against PostgREST instead.

## Status pointers
- **Delivered work** — routes, jobs, payloads, semantics: `docs/api-contract.md` is canonical.
- **Migration high-water** — `migrations/README.md`, per project from 069.
- This file is **architecture + invariants, not a slice ledger** — do NOT add per-slice `[x]`
  entries here.

## Docs map
- `docs/api-contract.md` — delivered routes/jobs/payloads/semantics (canonical).
- `migrations/README.md` — reconciliation list, per-project high-water, apply rules.
- `docs/rls-sweep.md` — RLS posture per table; sanctioned CMS-direct vs backend-only write paths.
- `docs/provisional-clinical-decisions.md` — distress + child-health decisions pending credentialed review.
- `docs/architecture-notes.md` — column rationale, content-phase roadmap, parked work (multi-age MLP).
- `docs/questionnaire-evolution-roadmap.md` — forward plan for questionnaire mechanics.
- `docs/backlog.md` — prioritised unscheduled work (P1–P3).
- `FINDINGS-*.md` (repo root) — investigation reports (`FINDINGS-financial.md` holds the
  financial-deployment decisions); `docs/drafts/` — proposals and local test harnesses;
  `docs/legacy/` — retired code kept for reference.

## Doc maintenance (part of DoD)
Docs are updated **unprompted, in the same commit** as the change that necessitates them.
- **`api-contract.md`** — every contract-touching change (route, payload, job type, semantics),
  plus the migration number that carried it.
- **`migrations/README.md`** — every applied migration gets a reconciliation entry AND the
  high-water bump, per project (see Migrations above).
- **`CLAUDE.md`** — ONLY when an architectural invariant, trap, or convention changes. Never
  per-slice. If unsure whether something is architectural, say so in the report — do not write it in.
- **`database.types.ts`** — regenerate after any schema migration; remove the temporary bridge
  in the same pass.
- **Clinical decisions** — any new or changed clinical threshold, tier or copy is recorded in
  `docs/provisional-clinical-decisions.md` and seeded `is_provisional = true`.
- Do not invent or update docs outside this repo.
