# CLAUDE.md — Moosii CMS Content-Generation Backend

## What this is
The content-generation backend for Moosii's CMS (phase 2). Moosii is a parenting-
education mobile app; this backend powers the internal admin tool that creates and
approves the content the app delivers. This service specifically owns AI-assisted
content generation (starting with lesson images, expanding to lesson/quiz content).

It is an INTERNAL ADMIN TOOL: ~3 trusted users, desktop, not a public product.
Priorities, in order: fast to build, easy to maintain, easy to debug. Scale,
concurrency, and hardening against untrusted users are explicitly NOT priorities.
Solo developer who leans on AI assistance and values control, visibility, and
debuggability over managed convenience.

## Invariants and traps
Read this first. **Hard cap ~12 entries:** an invariant earns a slot ONLY if violating it
breaks something across a surface boundary (CMS↔app, backend↔DB, provider↔caller) or
corrupts data. Anything narrower belongs in `api-contract.md` or a code comment. If this
section is full, one must be argued out before another goes in. Format is fixed: one line
of rule, one line of file/line evidence.

1. **The MLP algorithm is FROZEN** — flag any slice that touches it before writing code.
   → `src/mlp/generateFullMLP.ts:1-12` (faithful BuildShip port: "logic kept IDENTICAL except deliberate changes").
2. **`card_positions` = role-by-position** (first/body/takeaway derived from `sequence`), SHARED by every segment-gen prompt and the reviewer; card edits keep `sequence` contiguous 1..N; never pin a role per card.
   → `card_positions_v1` block ("TAKEAWAY CARD — always the final card"); `src/jobs/handlers/generateSegmentContent.ts:160-164`; renumber in `src/routes/subSegments.ts` (DELETE).
3. **No real users exist** — prefer structural safety (constraints/FKs/NOT NULL) over behavioral rules; wipe-and-rebuild usually beats careful migration.
   → `migrations/045_archive_exclude_tracks_active_set.sql` ("no live users exist yet"); `ON DELETE RESTRICT` in 038/040 (raises 23001).
4. **Shared infra breaks the OTHER consumer** — CMS and app share ONE Supabase project; name the second consumer before calling an auth/RLS/LLM-provider change done.
   → `src/llm/index.ts` `providerForModel` (review 404: provider was chosen independently of the row's model); `migrations/037_user_active_tracks_fn.sql` (fn + view "must stay in sync").
5. **Fresh-user landmines** — several bugs were paths only an aged, privileged account exercised; assume a brand-new user hits a different path.
   → migration 034 (NULL questionnaire priority sorted recruiters to the bottom); the age gate was unwired until migration 041.
6. **Archival is DERIVED, never stamped** — a lesson is archived if `lessons.archived_at IS NOT NULL` OR its track's is; archiving a track does not bulk-update lessons.
   → `migrations/045_archive_exclude_tracks_active_set.sql` (header); `migrations/046_archive_exclude_lessons_item_pool.sql`.
7. **Purge-order trap (P0001)** — remove the storage object BEFORE deleting `image_assets`, or the storage-delete trigger raises P0001.
   → `src/storage/purgeImages.ts:11-20`.
8. **Cascade fires on DELETE, not UPDATE** — single-card regen UPDATEs a card in place, so it must explicitly clear that card's `content_images` and `content_findings`.
   → `src/jobs/handlers/regenSegmentContent.ts:252-259`.
9. **Actor from the verified JWT, never the request body** — approvals and recompute take the user id from the token.
   → `migrations/043_content_approvals.sql` (header); `src/routes/mlp.ts:76` (recompute user_id from token).
10. **MLP selection converges on two objects** — `user_active_tracks_for_user` + `mlp_item_pool`; age gate, suppression, and archival all flow through them, so touching either touches every user's plan.
    → `src/jobs/handlers/rebuildMlp.ts:369,415`; migrations 041/045/046.

## The founding rule: no BuildShip, ever
The previous CMS used BuildShip (a visual workflow platform) for AI orchestration.
It was abandoned because it was an opaque, hard-to-debug black box. NEVER suggest,
add, or reintroduce BuildShip or any equivalent visual-workflow platform. Everything
is code the developer owns and can read, version, and debug. This is non-negotiable.

## Stack
- Express + TypeScript, deployed on Render (paid Starter tier — must stay warm, not
  the free spin-down tier, because in-process jobs would be orphaned on sleep).
- Supabase: Postgres (data) + Storage (image files). Backend uses the SERVICE-ROLE
  key and intentionally bypasses RLS.
- Build: `npm install && npm run build`; start: `npm start`. Render injects PORT.
- Auto-deploys on push to `master` (the repo's only/default branch).

## Architecture: async job pattern
Long AI work (image gen 15–30s, LLM 5–60s, chains 1–3 min) does NOT fit Supabase
Edge Functions, so it lives in this service. The pattern:
- POST /jobs inserts a `queued` row and returns a job_id IMMEDIATELY (202). It does
  NOT hold the connection open while work runs.
- Work runs fire-and-forget in-process (direct kickoff). A stale-job reaper marks
  any job `running` > 10 min as `failed` on startup (handles orphaned jobs from
  restarts). No external queue, no worker process — not needed at this scale.
- Status is tracked on the `jobs` row. Frontend polls (or reads Supabase directly).
- Jobs are WHOLE-UNIT: a job succeeds or fails atomically. On failure, retry the
  whole job. NO partial-resume / step-checkpoint machinery. (If retry cost ever
  becomes painful, that's the signal to consider a durable workflow tool like
  Trigger.dev — but not before.)

## Job granularity
ONE JOB PER IMAGE. "Generate all images for a lesson" (typically 5–8) is a FRONTEND
concern that fans out into N independent jobs. The backend has no concept of a
lesson batch. Each image has its own independent lifecycle (generate, review,
approve/reject, retry) without affecting the others.

(Content-generation jobs are different — a single content job is itself a chained
multi-step bundle; see the content roadmap below.)

## Prompt model: base + overlay
The prompt that an LLM uses to WRITE an image prompt is assembled from two layers,
concatenated and sent together every call:
- BASE (`prompts/image/base.md`): universal rules — brand aesthetic, color palette
  (#441C44 purple, #FC570D orange, #BEB400 yellow on white/cream), safety rules
  (bare crib, baby on back), no text, no iconography, "depict a scene/moment not a
  symbol", output format, the metadata template.
- OVERLAY (`prompts/image/topics/{topic_name}.md`): short, topic-specific guidance — WHO
  is in the image by default, emotional register, topic-specific traps to avoid.
  Keyed by `topics.name`. The overlay is NOT a fallback; it's the per-topic nudge
  layered onto the base.
The SEGMENT CONTENT drives the actual scene; base+overlay only shape HOW it's
depicted. Overlays are written/tuned in response to observed failure modes, not all
guessed upfront. v1 may ship with a generic overlay plus a few real ones.

Known prompt history: images regressed from "too busy" to "too sterile" (icon-on-
white-background) because rules for minimalism/single-focal-object/negative-space
compounded. The fix direction is "depict a real moment with people, restraint within
a scene, no iconography." This is empirical tuning work, best done inside the CMS.

## Model abstraction (general, multi-provider, addressed by name)
LLM access is a GENERAL primitive, not image-specific, because content generation
reuses it heavily. Build `getLLMClient(provider)` where provider is
'gemini' | 'openai' | 'anthropic' (extendable) — NOT a single getConfiguredLLM().
Reason: the cross-model critique pipeline needs MULTIPLE providers available
SIMULTANEOUSLY (generate with one, critique with another), so a single swappable
default is insufficient.
- Image prompt-writing is just ONE caller: getLLMClient(process.env.PROMPT_WRITER).
- Content steps call providers by name per step (generate → openai, critique →
  anthropic, etc.).
- Interface shape: generate(instructions, input) -> { text, raw, model, version }.
- `ImageGenerator` stays a SEPARATE interface (prompt -> image bytes); image-gen and
  text-gen are independent swappable concerns.
Gemini (text) and OpenAI are both implemented. Anthropic pending. Swapping =
new implementation + factory entry + env var (PROMPT_WRITER, IMAGE_GENERATOR).
Every generated artifact (image OR content) records which provider/model/version
and which instruction version produced it — full provenance, so regressions are
diffable. (This black-box recorder is the thing the BuildShip-era setup lacked.)

## Data model
- `jobs`: id, type (text), status (queued/running/succeeded/failed), input (jsonb),
  result (jsonb), error (jsonb), created_at/started_at/finished_at. Generic across
  job types.
- `content_images`: polymorphic across the content tree — exactly one of lesson_id /
  segment_id / sub_segment_id is set (enforced by check constraint). Holds
  storage_path, status (candidate/approved/superseded/rejected), image_prompt,
  final_prompt, prompt_writer + image_generator name/version, instruction_version
  base/overlay, topic_name (stored as text, not FK, to preserve historical
  accuracy), job_id. A partial unique index enforces at most one `approved` image
  per owner.
- Content hierarchy: lesson → segment → sub_segment. Currently 1:1 lesson:segment
  (may expand later). Existing tables: `lessons`, `segments`, `sub_segments`,
  `topics`, and the quiz tables (questions/answers/responses). The existing image
  column on `sub_segments` stays as the app's "live image" pointer; the backend
  writes to it on approval IN ADDITION to inserting into content_images. The app's
  read path is unchanged.
- `sub_segments.image_path` (added migration 004): deliberate redundant convenience
  mirror of the approved image's storage_path, written on approval alongside
  `sub_segments.image`. Canonical source is `content_images.storage_path`; this
  column exists for easy access in the Supabase UI during build and is safe to
  remove later.
- `sub_segments.tone_id` (migration 030): the tone (`prompts.id`) each card was last
  written in — PER CARD (single-card regen can retone one card without relabeling its
  siblings). Nullable = not recorded; NEVER backfilled. Stamped by generate/regen and
  the batch. The CMS reads it for the per-card tone badge.
- `content_images.scene` (migration 031): the SCENE each image depicts (WHAT, not the
  STYLE) — the `userPrompt` sent to the prompt-writer LLM. Image gen is ONE fused LLM
  call: STYLE (base+overlay) is the model's instructions, the scene is its userPrompt. A
  human may OPTIONALLY supply the scene on generate/regen (image regen = re-fire
  `generate_sub_segment_image`); non-empty → used verbatim, skips deriving from card
  content; empty/absent → derived exactly as before. Stamped on every new row via the
  shared core (single + `generate_track_images` batch). NULL = whole prompt hand-supplied
  (`prompt_override`, LLM skipped) or pre-migration; NEVER backfilled. `image_prompt`
  stays the full rendered prompt. Pass 1: no scene REUSE on regen (empty always re-derives).
- `questionnaire_response.repeat_after_days` (migration 033): PER SCORE-BAND recurrence
  interval (days). Questionnaires are normally one-shot (any `completed_items` row
  excludes them from the MLP forever). When a band has a non-null interval, the rebuild
  (`rebuildOneUser`) turns that exclusion into a "not yet DUE" check: it takes the LATEST
  `completed_items` row per (user, questionnaire), finds the band(s) whose score range
  contains that row's `score` with a non-null interval (SHORTEST wins), and RE-INCLUDES
  the questionnaire once `now - created_at >= interval`. Null score / no matching band /
  NULL interval → one-shot (byte-identical to pre-033). Independent of `add`. Suppression
  stays a separate sibling filter (a due-again questionnaire whose milestone fact exists is
  still excluded — no coupling). Derived fresh each rebuild, no state table; re-surfaces
  only when a recompute runs. Per-user routing itself is DERIVED too:
  `questionnaire_responses_tracks` is a VIEW (`completed_items ⨝ questionnaire_response`,
  score-in-band) — nothing external writes routing; writing the ANSWER is what routes.
- IMAGE STORAGE / regen purge (non-obvious): `sub_segments.image` is an FK to
  `image_assets.url`, and `image_assets` is populated by an OUT-OF-BACKEND storage
  trigger (no `src` code writes it — auto-INSERT on upload, auto-DELETE on remove).
  Content regen PURGES the regenerated cards' images (content_images rows + storage
  files + image_assets rows) via `src/storage/purgeImages.ts`, so no orphaned-file
  bloat. Order matters: remove the storage object BEFORE deleting image_assets, or the
  storage-delete trigger raises P0001.
- (Content phase) A `content_drafts` table — to be designed — mirrors content_images
  (candidate/approved/superseded, prompts + model provenance, approval metadata) and
  holds the draft content BUNDLE until a human approves it.
- Content prompt composition (Level 1.5): `prompts` extended with system_message,
  scope, output_schema, model/temperature/max_tokens and FKs tone_block_id /
  structure_block_id / length_block_id / size_profile_id; `prompt_blocks`
  (block_type tone|structure|length) + `prompt_block_versions`; `content_size_profiles`
  (structured size); `voice_lint_rules` (AI-tell detection). `lessons` gained
  `band_rationale` + `safety_sensitive`.

## Scope
- v1 (complete): image management — generate images per sub-segment,
  candidate/approve flow, non-destructive (candidates don't overwrite the live image
  until approved; prior images kept as history).
- v1.5 (delivered): lesson generation — `generate_lessons` composes its prompt from
  the DB (`prompts` row, `prompt_type='lesson'`) and emits the nine-field stub
  contract (name, internal_name, description, topic [resolved by name → topic_id],
  min/max child age, priority via the 6-band 100–2000 rubric, band_rationale,
  safety_sensitive; internal_name = curator catalog handle, migrations 0008/047), inserting
  lessons + their segments atomically via `create_lessons_with_segments`. (The old
  `prompts/lessons/generate.md` file is retired.)
- v2 (delivered): sub-segment CONTENT + QUIZ — `generate_segment_content` /
  `regen_segment_content` / `generate_quiz`, composed per-tone from the DB (see
  "Content prompt composition & tone management" below). NOT the critique pipeline yet.
- NOT yet built: lesson/segment-level images; the generate→critique→revise pipeline.
  MLP recompute is DELIVERED (`rebuild_mlp` single + `scope:'all'`, cut over to production
  `user_mlp`; app-facing `POST /mlp/recompute`) — see `docs/api-contract.md` §3.
- Frontend: Vite + React SPA (separate repo). The backend API contract is defined
  in `docs/api-contract.md`. FlutterFlow transition is complete — the React SPA is
  the only frontend.

## Roadmap beyond v1: content creation (post–image-management)
After image management, this backend absorbs the remaining BuildShip content
flows. Same architecture as images — same job runner, same candidate/approve
lifecycle, same versioned-prompts-with-provenance discipline. The new work is
text-shaped handlers, text prompt files, and multi-step chaining.

### Content prompt composition & tone management (DELIVERED)
Segment content composes its prompt from the DB, not files. A "tone" = one segment
`prompts` row + a 1:1 voice block (`prompt_blocks`), selected by stable `prompts.id`
(NOT the editable display name). Layers:
- VOICE — per-tone `prompt_blocks` (block_type='tone'), managed via `/tones`.
- STRUCTURE — `prompt_blocks` (block_type='structure'), a reusable library via
  `/structure-blocks`; default `standard_arc` (neutral) vs `sturdy_6_card_arc`
  (Sturdy/Good-Inside).
- SIZE — structured `content_size_profiles` (word/sentence/bullet budgets) rendered
  into the length instruction; per-tone default + `/size-profiles` CRUD.
- TECHNICAL (shared, not user-editable) — system_message, scope, output_schema.
`regen_segment_content` supports per-run OVERRIDES of any editable layer (prose, a
different block/profile, or inline size numbers) without changing the tone, plus an
optional `generate_quiz` (quiz generation always REPLACES, never appends). A
deterministic voice LINT (`voice_lint_rules` + `src/lib/voiceLint.ts`) flags AI-tells
post-generation into `jobs.result.lint` (advisory; never blocks). These admin tables
are reached via JWT routes; the backend reads/writes them with the service role
(RLS bypassed), so the CMS manages THESE tone/structure/size/lint admin tables through the
API, not direct Supabase writes. (Sanctioned CMS-direct write paths DO exist elsewhere —
`screen_help`, `sub_segments` title/content edits, `tracks.archived_at`; see
`docs/rls-sweep.md`. Whether `sub_segments` INSERT is RLS-permitted is undetermined and
parked with the consolidated RLS sweep.)

### Content generation is a BUNDLE, not a single text blob
Generating a lesson also generates its QUIZ in the same act. A content-generation
job produces:
- Lesson text (sub-segment snippets — small, human-feeling; see voice rules below)
- The quiz: questions, each with multiple answer options, and a per-answer RESPONSE
  shown to the user (the explanation for each correct/incorrect choice).
Current shape: one quiz per lesson (1:1 lesson:segment model). A content job writes
to multiple tables atomically (lesson/sub_segment content + quiz tables); the
candidate/approve lifecycle must cover the whole BUNDLE, not just the prose. The
`content_drafts` table holds the draft bundle until a human approves it.

### The generate → critique → revise pipeline (chained job)
Content generation is multi-step orchestration (the workload the async-job design
was chosen for; ~1–3 min):
1. GENERATE draft with one model (currently ChatGPT) from a tight, structured
   prompt (persona + hard voice constraints).
2. CRITIQUE with a DIFFERENT model (cross-model: each model is blind to its own
   tells) playing an adversarial "skeptical reader who spots AI instantly" role,
   producing specific edits, not vague notes.
3. REVISE per critique.
4. Human does a fast voice + accuracy pass (~60s), then approves.
Add the critique pass only after proving a single strong-prompt generation isn't
enough; measure (blind-rank processed vs. raw) before adding pipeline complexity.
Over-chaining can homogenize output to "smooth" rather than human.

### Making AI content feel human (why this matters)
Goal: content must NOT read as AI — Moosii's audience (tired, emotionally raw new
parents) and the broader anti-AI-content backlash make this a trust issue, not a
nicety. Most of the fix is at the prompt level + a light human "voice pass."
Key prompt moves: specific persona with opinions; one idea per snippet (not
comprehensive); short/varied sentences, fragments OK; ban throat-clearing openers
and hedging phrases ("It's important to," "Many parents find," "At the end of the
day," etc.); make direct claims; concrete/sensory anchors; ~7th-grade conversational
voice. Detailed generation + critique prompts live in a separate May 29 chat — bring
them in when this phase starts; they are the starting point, then tune empirically.

### Risk stratification (content-phase concern, handler-level)
Content is NOT one uniform pipeline. Medical, safety-critical, and emotionally
loaded topics (SIDS, allergic reactions, when-to-call-doctor, car seats, choking,
PPD/PPA, infant loss) require a HIGHER bar: human-written-first with AI for polish
only (the reverse of the default), plus credentialed human review. AI critique
passes catch VOICE, never factual accuracy — never treat "the second AI approved it"
as accuracy review. This likely becomes a `risk_tier` on content jobs that routes
handling. Later concern; noted so it's on the record.

### Disclosure / trust (product decision, not backend)
Leaning toward disclosing AI-assisted drafting + human review, ideally with named
credentialed reviewers ("Reviewed by [name], RN, IBCLC"). Build the trust story
before launch, not after a journalist asks. Not a backend concern, but it shapes
what metadata content rows may need to carry (reviewer identity, review status).

## Auth
- **SPA routes** (the CMS admin surface): Supabase **JWT** — the browser sends the access
  token (`Authorization: Bearer <jwt>`); the backend verifies via `supabase.auth.getUser()`
  and checks `users_internal.role` (`src/middleware/jwtAuth.ts`). The current route set
  lives in `src/index.ts`; per-route detail in `docs/api-contract.md`. Not re-listed here —
  a hardcoded route list drifts.
- **Server-to-server** (`/jobs`): `INTERNAL_API_KEY` shared secret
  (`Authorization: Bearer <key>`). Internal tooling/testing only; never sent by the SPA.
- `/health` is unauthenticated.

## API conventions
- **Errors:** `{ error: { code: string, message: string } }` with appropriate
  HTTP status. Helper: `apiError(res, status, code, message)` in `src/lib/errors.ts`.
- **Async jobs:** return `202 { job_id }` immediately; frontend polls the `jobs`
  table directly via Supabase (not via a backend polling endpoint).

## Secrets discipline (strict)
- `.env` is gitignored and holds real secrets locally. `.env.example` (committed) is
  the empty template.
- The Supabase SERVICE-ROLE key bypasses all RLS — it lives ONLY in `.env` and
  Render env vars. NEVER in code, NEVER committed, NEVER sent to any frontend.
- Always verify staged files before committing — confirm `.env` is excluded.

## AI generation logging
Every AI API call is logged to `ai_generation_log` (migration 005) via
`logAiCall()` in `src/lib/aiLog.ts`. Rules:
- Log in the **handler**, not the provider — handlers have entity context.
- One log row per AI call. Multi-step handlers (e.g. `generateSubSegmentImage`
  makes an LLM call then an image-gen call) produce multiple rows tied by a
  shared `correlation_id` (UUID generated once at the top of the handler).
- `related_entity_id` is null for intermediate calls (e.g. the prompt-writing
  LLM call before a `content_images` row exists). Set it once the entity ID
  is known.
- Logging failure must NEVER throw or break generation — `logAiCall` catches
  all errors internally.
- Operation naming: `<artifact>_<action>` — e.g. `image_prompt_generate`,
  `image_generate`, `lesson_generate`. Use consistent names so log queries
  are predictable.
- After running a new schema migration, regenerate `database.types.ts` and
  remove any `(supabase as any)` cast added as a temporary bridge.

## Conventions
- Build each piece as a standalone, independently-testable module; compose at the
  end. Test in isolation before wiring together (this is how each build step is
  de-risked).
- Prompt instructions: IMAGE prompts are versioned files (`prompts/image/`).
  CONTENT prompts (lesson/segment/quiz/questionnaire) are DB-composed (`prompts` +
  `prompt_blocks` + `content_size_profiles`), managed via admin CRUD, not files.
- Prefer minimal formatting and minimal dependencies. Keep it debuggable.
- Database types (`src/types/database.types.ts`) are generated from the live schema via
  PostgREST introspection; regenerate after any schema migration and drop the temporary
  `(supabase as any)` bridge in the same pass. **Known current gap:** missing `archived_at`
  (045/046) and `curator_note` (044) — code bridges those with `(supabase as any)` until a
  regen. (There is no clean "types through migration N" — it's a patchwork; don't cite one.)

## Status pointers
- **Delivered work** — routes, jobs, payloads, semantics: `docs/api-contract.md` is canonical.
- **Migration high-water** — `migrations/README.md`'s reconciliation list is the only reliable number (currently **046** main / **0007** prompt track).
- This file is **architecture + invariants, not a slice ledger** — do NOT add per-slice `[x]` entries here (that ledger was deliberately removed).

## Docs map
- `docs/api-contract.md` — delivered routes/jobs/payloads/semantics (canonical delivered-work reference).
- `migrations/README.md` — the reconciliation list + migration high-water (the only reliable high-water).
- `docs/rls-sweep.md` — content-bearing tables needing RLS; sanctioned CMS-direct vs backend-only write paths.
- `docs/provisional-clinical-decisions.md` — distress/clinical content decisions pending credentialed review.
- `docs/questionnaire-evolution-roadmap.md` — forward plan for questionnaire mechanics.

## Doc maintenance (part of DoD)
Docs are updated **unprompted, in the same commit** as the change that necessitates them.
- **`api-contract.md`** — every contract-touching change (route, payload, job type, semantics), plus the migration number that carried it.
- **`migrations/README.md`** — every SQL-editor-applied migration gets a reconciliation entry AND the high-water bump; this is the only reliable high-water.
- **SQL-editor migration apply gate** — a migration file is committed as **DRAFT (pending apply)**; its reconciliation entry + the high-water bump flip to **applied ONLY on Mark's confirmation he ran it**. Confirming an apply is its own step and its own commit — never assumed from the file existing (these migrations have no code commit to ride along with, since Mark applies them later).
- **`CLAUDE.md`** — ONLY when an architectural invariant, trap, or convention changes. Never per-slice. If unsure whether something is architectural, say so in the report/PR — do not write it in.
- **`database.types.ts`** — regenerate after any schema migration; remove the temporary `(supabase as any)` bridge in the same pass.
- Do not invent or update docs outside this repo.

## Not yet built / parked
- [ ] Cross-model generate→critique→revise pipeline (content quality).
- [ ] Lesson/segment-level images (track-image batch is sub-segment-level only).
- [ ] React SPA frontend (separate repo).
- [~] PARKED (2026-07-25, until a large real content set exists): **multi-age MLP
      weighting** — for a household with children of DIFFERENT ages, tilt the plan toward
      the YOUNGER child's lessons. This is the whole reason `tracks.track_type='Age'`
      exists (its ONLY functional use: `generateFullMLP` scales an `Age` track's weight by
      the active age brackets; younger brackets weigh more — newborn 4 / infant·toddler 2 /
      older 1). The mechanism is BUILT but DORMANT: the recompute feeds only the youngest
      child's age (`rebuildMlp.ts` computeUserMlp: `ages: [ageMonthsUsed]`, "v1: youngest
      child only"), so multiple brackets never activate; and the pool age FILTER also keys
      off youngest only (`isAgeEligible(youngestAgeMonths, …)`), so an OLDER child's
      age-specific lessons are dropped entirely, not just under-weighted. Difficulty is
      LOW (~half a day incl. proof) — the `children` table already has per-child
      birth_year/month (recompute reads it, just `.limit(1)`), and `generateFullMLP`
      already loops multiple ages. Changes: load ALL child ages in `loadUserMlpInputs`;
      pass them to `ages`; change the pool filter to "ANY child overlaps" (a `.some()`);
      thread all-ages into `questionnaireStatus.ts` (age_gated flag) for consistency; decide
      the preview `ageMonthsOverride` semantics. Real work is DECISIONS not code: (a)
      any-child filter → bigger MLPs incl. older-targeted content (confirm wanted); (b) the
      `weight * (totalAgeWeight/totalTrackWeight)` magnitude gives the right DIRECTION but
      the tilt amount needs eyeballing real mixed-age output — only meaningful once real
      content exists, which is why it's parked. `track_type` is otherwise vestigial
      (free-text, ~15 inconsistent values incl. test junk; `'milestone'` drives only a CMS
      badge).
