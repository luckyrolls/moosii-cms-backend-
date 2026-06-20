# Moosii Backend — API Contract

> Shared interface contract between `moosii-cms-backend` (Node/TS + Express on
> Render — **live**) and `moosii-cms` (the SPA).
>
> **Single source of truth lives in the backend repo** at `docs/api-contract.md`.
> The CMS repo should point here rather than keep a copy — keeping two copies in
> sync is a maintenance trap.
>
> Items marked **DELIVERED** reflect actual returned shapes from running code —
> build the frontend client against them as written. Items marked `[DESIGN]` are
> designed-in-principle but not yet built.

---

## 0. What the rewrite is and isn't

**Is:** porting all backend logic out of BuildShip into Express + TypeScript on
Render. BuildShip was an opaque, buggy visual-orchestration black box; everything
it did becomes readable, versioned, debuggable code.

**Isn't:** a redesign of the data model, the job system, or the
candidate/approve lifecycle. Those are kept — the image slice already proves the
pattern. The DB contract (`content_images`, `jobs`, the atomic approve function)
is the *model*, not something to replace.

**Founding rules carried forward:** no BuildShip, ever. No Trigger.dev (plain
service is enough). AI work runs as async in-process jobs with a stale-job
reaper. Service-role key server-side (bypasses RLS). API keys live only on the
backend.

**Remaining work** is translating the not-yet-ported BuildShip flows
(questionnaire/MLP logic) into routes + TS functions. Content, quiz, and lesson
generation have been ported and are delivered.

---

## Conventions (decided)

- **Base URL:** Render service URL — frontend `VITE_API_BASE_URL`.
- **Auth — DELIVERED: JWT.** Browser calls send the Supabase access token
  (`Authorization: Bearer <jwt>`, from `supabase.auth.getSession()`). Backend
  verifies the token and checks `users_internal` for CMS access. No
  `INTERNAL_API_KEY` browser path. Keep `INTERNAL_API_KEY` only for any
  server-to-server/cron path.
- **Content type:** `application/json`.
- **Async pattern (delivered):** AI/long work returns a `job_id` immediately
  (HTTP 202). The frontend polls the `jobs` table **directly via Supabase** — the
  backend provides **no** polling endpoint. Fire-and-forget, whole-job retry on
  failure (= re-fire generation; no dedicated retry route), no partial-resume.
  Jobs run in-process; a stale-job reaper marks abandoned `running` jobs failed
  (keys off `jobs.started_at`).
- **Errors — DELIVERED:** `{ error: { code: string, message: string } }` with
  appropriate HTTP status.
- **Health check — DELIVERED:** `GET /health → 200 { status: "ok" }`, **no
  auth**. Use for a "backend reachable?" indicator (the two halves deploy
  separately).

---

## 1. Image endpoints — DELIVERED (live; actual returned shapes)

Live on Render. Shapes below are what the backend actually returns — build the
frontend client against these.

### 1a. Generate image for one sub-segment
```
POST /sub-segments/:id/generate-image
Authorization: Bearer <jwt>
Body: {
  instructions_override?: string,   // edits the image_prompt (LLM-written) path
  prompt_override?: string          // skip the LLM, use this as the final prompt
}
→ 202 { job_id: string }
```
Single `generate_sub_segment_image` job → new `content_images` candidate row
carrying this `job_id`. Backs "redo this one" + the prompt-tweak/compare loop.

### 1b. Batch generate for a segment
```
POST /segments/:id/generate-images
Authorization: Bearer <jwt>
Body: {
  mode: "all" | "gaps" | "unapproved",
  concurrency?: number              // default 2 (Gemini rate-limit guard)
}
→ 202 { jobs: [{ sub_segment_id: string, job_id: string }] }
```
Fans out into N independent per-sub-segment jobs. Concurrency-capped. Each job
is returned paired with its `sub_segment_id` so the UI maps job → card directly.
- `all` — regenerate everything (tuning).
- `gaps` — only sub-segments lacking a *complete* image (resume failed/partial).
- `unapproved` — only sub-segments lacking an *approved* image.

### 1c. Approve a candidate
```
POST /content-images/:id/approve
Authorization: Bearer <jwt>
Body: { approved_by?: string }
→ 200 { ok: true, content_image_id, sub_segment_id, status, public_url, approved_at }
```
Wraps the atomic `approve_content_image(p_public_url, p_storage_path, ...)`
Postgres function. One transaction: supersede prior approved → approve target →
write `sub_segments.image` + `image_path`. The response returns `public_url`
directly so the frontend can update optimistically.

### 1d. Reject a candidate
```
POST /content-images/:id/reject
Authorization: Bearer <jwt>
→ 200 { ok: true, content_image_id, status: "rejected" }
```
Sets `status='rejected'` only; never touches the pointer; guarded against
rejecting an already-approved row.

### 1e. Job retry — RESOLVED: no dedicated route
Retry = re-fire generation (1a for one card, 1b `gaps` for a batch's stragglers).
The frontend's "regenerate" buttons call 1a/1b again.

---

## 2. Content / lesson / quiz endpoints — DELIVERED

All flows below run through the same `POST /jobs` async-job pattern as images.
The backend reads prompts and model parameters from the DB (`prompts` +
`prompt_blocks` tables) — **the CMS sends references, not prompt text.**

### Job types in use
```ts
type JobType =
  | 'generate_sub_segment_image'  // §1a
  | 'generate_lessons'            // §2a
  | 'generate_segment_content'    // §2b
  | 'regen_segment_content'       // §2c
  | 'generate_quiz'               // §2d
  | 'generate_questionnaire';     // §2e
```

---

### 2a. Generate lesson stubs — DELIVERED
```
POST /jobs
Authorization: Bearer <jwt>
Body: {
  type: "generate_lessons",
  input: {
    track_id: string,         // required — track name + description read from `tracks`
    min_child_age: number,    // required — developmental window lower bound (months)
    max_child_age: number,    // required — developmental window upper bound (months)
    max_lessons: number,      // required — CEILING on lessons (max, not target); >= 1
    additional_info?: string, // optional — author instructions (authoritative override)
    created_by?: string       // optional — user email/id stamped on inserted rows
  }
}
→ 202 { job_id: string }
```
System prompt + output schema + model/params are composed from the DB `prompts`
row (`prompt_type = 'lesson'`, `is_active = true`) — NOT a source file. The
runtime user message supplies only data under bare section headers: TRACK
(name/description/developmental window/max lessons), AVAILABLE TOPICS (the
`topics.name` set, injected verbatim), EXISTING LESSONS IN THIS TRACK (for dedup),
and AUTHOR INSTRUCTIONS (only when `additional_info` is non-empty).

Produces up to `max_lessons` lesson **stubs**, each with the full eight-field
contract: name, description, topic, min/max child age, priority, priority-band
rationale, and `safety_sensitive`. The model returns a `topic` NAME per lesson,
resolved to `topic_id` via a normalized (case-insensitive, trimmed) lookup against
`topics.name`. **Any unresolved topic fails the whole job before insert** (no
partial write) — surfaced as an error naming the offending lesson(s) and topic
string(s).

**Writes directly to `lessons`** (not returned for the frontend to commit), via
the `create_lessons_with_segments` transaction: all lessons + their segments
commit atomically, or none do. Also creates one `segments` row per lesson
(1:1 lesson:segment model).

`jobs.result` on success:
```json
{
  "lessons_inserted": 8,
  "segments_inserted": 8,
  "lesson_ids": ["uuid", ...],
  "lessons": [
    {
      "id": "uuid", "lesson_name": "...", "priority": 110,
      "topic": "feeding", "band_rationale": "...", "safety_sensitive": true
    }
  ],
  "author_instructions_used": false,
  "model": "gpt-4o-2024-08-06"
}
```

---

### 2b. Generate segment content — DELIVERED
```
POST /jobs
Authorization: Bearer <jwt>
Body: {
  type: "generate_segment_content",
  input: {
    seg_id: string,
    tone: string,           // selects the prompt row, e.g. "Sturdy Leadership"
    generate_quiz?: boolean // if true, also generates the quiz in-sequence
                            // (same job, shared correlationId — see §2d)
  }
}
→ 202 { job_id: string }
```
Backend reads the `segment_content` prompt row for the given tone from the DB
(`prompts` + `prompt_blocks`). Composes system + user message from DB fields;
uses `output_schema` from the row as `response_format`. No prompt text in the
request — the backend owns prompt composition.

Generates a **cards arc** (typically 5–9 cards; count is model-determined).
Writes one `sub_segments` row per card (`title`, `content`, `sequence` 1…N),
replacing any existing sub_segments for the segment. The final card is the
takeaway — no special field, just the last card in order.

When `generate_quiz: true`, quiz generation runs after cards complete, sharing
the same `correlationId` so both `ai_generation_log` entries are linked. The
quiz result is included in `jobs.result.quiz` (see §2d for shape).

`jobs.result` on success (without quiz):
```json
{
  "seg_id": "uuid",
  "sub_segments_inserted": 8,
  "sub_segment_ids": ["uuid", ...],
  "model": "gpt-5.1-2025-11-13",
  "finish_reason": "stop"
}
```
With `generate_quiz: true`, result also includes:
```json
{
  "quiz": {
    "questions_requested": 1,
    "questions_written": 1,
    "question_ids": ["uuid"],
    "model": "gpt-5.1-2025-11-13"
  }
}
```

---

### 2c. Regenerate segment content — DELIVERED
```
POST /jobs
Authorization: Bearer <jwt>
Body: {
  type: "regen_segment_content",
  input: {
    seg_id: string,
    tone: string,
    scope: "whole_segment" | "single_card",
    card_id?: string   // required when scope = "single_card"
  }
}
→ 202 { job_id: string }
```
**Precondition:** the segment's lesson must not be published (`lessons.is_published
= false`). If published, the job fails immediately with a clear message: "Unpublish
the lesson first, then retry." Does NOT silently unpublish.

**Generate-before-destroy guarantee:** new content is generated and validated
before any existing content is deleted. A failed generation leaves existing
content intact.

**`scope = "whole_segment"`**: replaces all cards (same as first-time generation).
Removes all the segment's images (cascade). Resets `segments.seg_status →
'pending'` and `segments.approved_by → null` so freshly generated content cannot
ride a stale approval.

**`scope = "single_card"`**: regenerates one card in-place — same row ID, same
sequence, card count unchanged. Neighbor cards (prev/next) are passed as context
so the replacement fits the arc. Removes only that card's image (explicit delete
before UPDATE — cascade does not fire on UPDATE). Also resets segment approval.

`jobs.result` (whole_segment):
```json
{
  "scope": "whole_segment",
  "seg_id": "uuid",
  "sub_segments_inserted": 8,
  "sub_segment_ids": ["uuid", ...],
  "approval_reset": true,
  "model": "gpt-5.1-2025-11-13",
  "finish_reason": "stop"
}
```
`jobs.result` (single_card):
```json
{
  "scope": "single_card",
  "seg_id": "uuid",
  "card_id": "uuid",
  "card_sequence": 5,
  "approval_reset": true,
  "model": "gpt-5.1-2025-11-13",
  "finish_reason": "stop"
}
```

---

### 2d. Generate / regenerate quiz — DELIVERED
```
POST /jobs
Authorization: Bearer <jwt>
Body: {
  type: "generate_quiz",
  input: {
    seg_id: string
  }
}
→ 202 { job_id: string }
```
Reads the segment's **current** `sub_segments` as source material, so it is
correct both when called after fresh generation and when called after a reviewer
has edited cards. Loads the `quiz` prompt row from the DB (`prompt_type='quiz'`).

**`question_count`** is a column on the `prompts` row (currently 1, adjustable by
the co-founder in the DB without a code change). Output is always an array — 1→N
is a config change, not a refactor.

Writes one `quiz_questions` row per question and four `quiz_answers` rows per
question (separate tables, not jsonb). Each answer has `answer_text`, `is_correct`
(exactly one `true` per question), and `response` (per-answer feedback in the
same voice as the content).

**Partial success:** if the model returns a malformed question (wrong answer count,
multiple correct, missing response), that question is dropped and logged. The job
succeeds if at least one valid question is written. Zero valid questions is a
failure. `shortfall` in the result is non-null when fewer questions were written
than requested.

**Generate-before-destroy:** existing questions for the segment are deleted only
after valid replacements are in hand.

`jobs.result` on success:
```json
{
  "seg_id": "uuid",
  "questions_requested": 1,
  "questions_written": 1,
  "question_ids": ["uuid"],
  "model": "gpt-5.1-2025-11-13",
  "shortfall": null
}
```
On partial success (`shortfall` populated):
```json
{
  "questions_requested": 3,
  "questions_written": 2,
  "shortfall": "2 of 3 questions written"
}
```

**One-action flow vs standalone:** passing `generate_quiz: true` on a
`generate_segment_content` job (§2b) runs quiz generation in-sequence after
cards complete, sharing one `correlationId` so both `ai_generation_log` entries
are linked. The standalone `generate_quiz` job runs independently (e.g. after a
reviewer edits the cards), replacing existing questions.

---

### 2e. Generate questionnaire — DELIVERED
```
POST /jobs
Authorization: Bearer <jwt>
Body: {
  type: "generate_questionnaire",
  input: {
    target_track_id: string,  // required — the track the response rule ADDS when
                              //   answered. Its name + description is the SPEC the
                              //   whole atom is generated against; description must
                              //   be non-empty or the job fails.
    host_track_id: string,    // required — the questionnaire's own track FK
                              //   (placement/visibility only; does NOT shape content)
    age_months: number,       // required — single age gate (months) the questionnaire surfaces at
    topic?: string,           // optional — free-string theme (NOT a topics.id)
    topic_id?: string         // optional — real topics.id FK on the questionnaire row
  }
}
→ 202 { job_id: string }
```
Two DISTINCT track references — do not conflate: `target_track_id` (what answering
activates; the content spec) vs `host_track_id` (where it lives).

Prompt is currently read from the file `prompts/questionnaires/generate.md` (NOT
the DB `prompts` table yet — pending the same cutover §2a got). Provider is
selected by the `QUESTIONNAIRE_WRITER` env var (`openai` | `gemini`, default
`openai`).

Generates ONE questionnaire **atom** as a **DRAFT** (`is_published = false`;
publishing is the human approve action, out of scope here). The LLM returns
`questionnaire_name`, `intro_text`, `questions[]` (each answer carries a `score`),
and `add_threshold`. The handler owns score math + validation (OpenAI strict
schemas can't enforce it): every question needs ≥2 answers whose scores spread,
and `add_threshold` must fall in `[1 .. real_max]`, where `real_max` = sum of the
highest answer score per question. On a parse/validation miss it **retries up to 3
times**, then fails clearly.

**Writes (all as draft):** one `questionnaire` row (`track_id = host_track_id`),
its `questionnaire_questions` (status `pending`) + `questionnaire_answers`, and one
`questionnaire_response` routing rule — score in `[add_threshold .. real_max]` →
ADD `target_track_id`. (Scores below the threshold add nothing; no remove rule is
fabricated.)

`jobs.result` on success:
```json
{
  "questionnaire_id": "uuid",
  "is_published": false,
  "host_track_id": "uuid",
  "target_track_id": "uuid",
  "age_months": 6,
  "questions_written": 5,
  "answers_written": 15,
  "response_rule_id": "uuid",
  "add_threshold": 7,
  "real_max": 12,
  "score_range": { "min": 7, "max": 12 },
  "provider": "openai",
  "model": "gpt-4o-2024-08-06",
  "attempts": 1,
  "correlation_id": "uuid"
}
```

---

## 3. MLP recompute — [DESIGN]

```
POST /mlp/recompute                    // [DECIDE] all users? one user? trigger scope
Body: { user_id?: string, ... }        // [DECIDE]
→ 202 { job_id: string }
```
Repopulates the materialized `user_mlp` table. **There is no recompute function
in the DB** — this logic lives here (port from BuildShip / app logic). Inputs to
the ordering algorithm: item `priority`, track `priority`/`order`/`weight`,
`age_track_weights` (age-bracketed), global `consts` (`weight_factor`,
`mlp_limit`, `daily_limit`). Triggered when tracks change (CMS) or a user answers
a questionnaire (runtime — `[DECIDE]` whether that path is backend or app/edge).
`user_mlp_mods` holds per-user manual overrides the recompute must respect.

---

## 4. Job polling (frontend → Supabase, not the backend)

```ts
const { data } = await supabase
  .from('jobs')
  .select('id, type, status, result, error, started_at, finished_at')
  .eq('id', jobId)
  .single();
```
- TanStack Query `refetchInterval` (~2–3s) while `status` ∈ {queued, running};
  stop on terminal status.
- **Resting state keys off content tables, not `jobs`**: a missing complete row =
  a gap, regardless of job history. Job status is the live overlay.
- Image batch watches two queries: `jobs` (progress/errors) + `content_images`
  by owner (candidates, `created_at DESC`), joined via `job_id`.

`jobs.status` value set — **DELIVERED:** `queued → running → succeeded | failed`.
Poll while `queued`/`running`; stop on `succeeded`/`failed`. Define once as a
shared constant; the reaper and the frontend poll both key off these strings.

All content/quiz/lesson job types flow through the same `jobs` table and the
same polling model. New `jobs.type` values in use:
```ts
type JobType =
  | 'generate_sub_segment_image'
  | 'generate_lessons'
  | 'generate_segment_content'
  | 'regen_segment_content'
  | 'generate_quiz';
```

---

## 5. Data shapes (authoritative — from database_types.ts)

`content_images` and `jobs` confirmed present in the regenerated types. Facts the
backend must preserve and the frontend leans on:

- **`jobs`:** `id`, `type` (text), `status` (text, default `queued`),
  `input jsonb` (NOT NULL `{}`), `result jsonb`, `error jsonb`, `created_at`,
  `started_at`, `finished_at`. Generic + self-describing — one job table for all
  `type`s. Reaper keys off `started_at`.
- **`content_images` owner:** exactly one of `lesson_id`/`segment_id`/
  `sub_segment_id` non-null — DB CHECK `content_images_one_owner`
  (`num_nonnulls(...) = 1`). Backend must set exactly one.
- **At most one `approved` per owner:** three partial unique indexes
  (`WHERE status='approved' AND <owner>_id IS NOT NULL`). Approve can't create
  two live images even under a race.
- **`status` is loose `text`, not a PG enum** on both tables — types surface it
  as `string`. Define unions in code:
  ```ts
  type ImageStatus = 'candidate' | 'approved' | 'superseded' | 'rejected';
  type JobStatus   = 'queued' | 'running' | 'succeeded' | 'failed'; // DELIVERED
  ```
- **Prompts:** `image_prompt` = editable LLM-written prompt (the override path);
  `final_prompt` = resolved base+overlay sent to the model (provenance, NOT NULL).
- **Live image pointer:** `sub_segments.image` (URL). `sub_segments.image_path`
  is a redundant mirror — written in the same approve transaction, otherwise
  ignored.
- **Provenance columns** (`prompt_writer_name/version`,
  `image_generator_name/version`, `instruction_version_base/overlay`,
  `topic_name`) record which models + prompt versions produced a candidate — the
  backend populates these on generation.
- **Segment content approval:** `segments.seg_status` (`'pending'` / `'complete'`)
  and `segments.approved_by`. Regen resets both to un-reviewed state.
- **Quiz tables:** `quiz_questions` (`question_id`, `question_text`, `type`,
  `segment_id`, `lesson_id`, `answer_status`) and `quiz_answers` (`id`,
  `question_id`, `answer_text`, `is_correct`, `response`, `score`). Separate rows,
  not jsonb. See §7 for the legacy tables these replace.

---

## 6. Decisions

**Resolved:**
- Error envelope (`{ error: { code, message } }`), `jobs.status` set, approve/reject
  response bodies (§1c/1d), job retry (no route — re-generate).
- **Lesson stubs (was §6.1):** written directly to `lessons` + one `segments` row
  per lesson. Not returned for the frontend to commit.
- **Content gen grain (was §6.2):** segment-level. One `generate_segment_content`
  job per segment, writes N `sub_segments` rows.
- **Prompt composition:** backend-owned. CMS sends references (`seg_id`, `tone`);
  backend fetches `prompts` + `prompt_blocks` from DB and composes. No prompt text
  in API requests.

**Still open — `[DESIGN]` slices (decide when built):**
1. MLP recompute scope + trigger paths, including whether the
   questionnaire-answer runtime recompute is backend or app/edge (§3).
2. Status standardization (cross-cutting): whether to make status columns real PG
   enums — if so, regenerated types give the unions for free.

---

## 7. Legacy — do NOT carry into the new backend

The rewrite is the moment to leave BuildShip-era cruft behind. Do not read as
live or write to:
- **Tables:** `answers_legacy`, `questions_legacy`, `image_assets` (retired —
  superseded by `content_images`). Note `questionnaire_user_answers` + quiz
  runtime still FK the legacy answer/question tables — don't delete those out
  from under the app during the app rewrite. Quiz generation writes to the
  **current** `quiz_questions` / `quiz_answers` tables, not the legacy ones.
- **`segments` legacy cols:** `chatgpt_image_prompt`, `image_prompt`,
  `full_prompt`, `tone`, `video_url`, `anchor_text`.
- **`sub_segments` legacy col:** `image_prompt`.
- **`lessons` legacy cols:** `image_url`, `task_image`, `article`,
  `min_questionnaire_score_range`, `max_questionnaire_score_range` (routing now
  lives in `questionnaire_response`).
- Routing rules live in `questionnaire_response` (the actions table — score range
  → add/remove track-or-tag), read via `questionnaire_response_with_track_tag`.
  Don't confuse with `questionnaire_user_answers` (real user answers).
