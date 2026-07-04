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
  | 'generate_questionnaire'      // §2e
  | 'generate_track_content';     // §2f
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
    tone_id: string,        // prompts.id of the segment tone (stable id, NOT the
                            // display name — see §2g). Must be an active tone.
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
quiz result is included in `jobs.result.quiz` (see §2d for shape). Quiz generation
**always replaces** any existing questions for the segment (one quiz per segment —
re-running never duplicates).

`jobs.result` on success (without quiz):
```json
{
  "seg_id": "uuid",
  "sub_segments_inserted": 8,
  "sub_segment_ids": ["uuid", ...],
  "model": "gpt-5.1-2025-11-13",
  "finish_reason": "stop",
  "lint": [
    { "ruleKey": "both-true", "type": "limit", "severity": "warn",
      "card": 0, "match": "both things can be true", "count": 3,
      "message": "Stock phrase repeated - vary the wording." }
  ]
}
```
**`lint`** is the deterministic voice-lint result — advisory hits (AI-tells,
throat-clearing openers, overused/repeated phrases) for the CMS review screen to
surface. It never blocks or alters generation; an empty array means no hits.
Rules live in `voice_lint_rules` (editable in the DB); the matcher engine is in
`src/lib/voiceLint.ts`. `card` is the 1-based card index, or `0` for
segment-scope counts (`limit`/`repeat`). `severity` is `"error"` | `"warn"`.
Runs on segment content + regen only (not quiz/questionnaire).

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
    tone_id: string,    // prompts.id of the segment tone (stable id, not the name; see §2g)
    scope: "whole_segment" | "single_card",
    card_id?: string,   // required when scope = "single_card"
    generate_quiz?: boolean,  // if true, also regenerate the quiz (replaces existing)
    overrides?: {       // per-run prompt overrides — THIS regeneration only
      scope?: string,
      tone?: string,
      structure?: string,            // explicit ## Structure prose; wins over block swap
      structure_block_id?: string,   // swap to a different structure block for this run
      length?: string,           // explicit ## Length prose; wins over size if set
      size_profile_id?: string,  // swap to a different size profile for this run
      size?: {                   // inline numeric tweaks merged over the base profile
        total_words_min?, total_words_max?,
        words_per_card_min?, words_per_card_max?,
        max_sentence_words?, max_bullet_words?, max_bullets_per_card?
      }
    }
  }
}
→ 202 { job_id: string }
```
**Quiz on regen:** by default the quiz is left untouched (so after a card regen it
may be stale relative to the new cards). Pass `generate_quiz: true` to also
regenerate it — which **replaces** the segment's existing questions (never appends),
sharing the job's `correlationId`; the result appears in `jobs.result.quiz`.

**Per-run prompt overrides:** `overrides` lets a reviewer tune the prompt for a
single regeneration when the default output wasn't right. Each present, non-empty
layer replaces that layer's text for this run only; empty/whitespace or absent
falls back to the DB default. **`system_message` is intentionally NOT overridable**,
and `output_schema` is never touched — so the card contract can't break. The
`prompts` row and `prompt_blocks` are **never written** (sources untouched). The
overrides are persisted in `job.input`, and `ai_generation_log` records both the
full rendered prompt and a note listing which layers were overridden, so deviations
from default can be reviewed (and later promoted to defaults — a separate,
super-admin action, not built here). The result echoes `overrides_applied: string[]`
(which may include `"size_profile_id"` / `"size"`).

**Structure (## Structure) resolution precedence:** `structure` prose override →
`structure_block_id` (a different structure block for this run) → the tone's default
`structure_block_id` (see §2g / §2i).

**Size (## Length) resolution precedence:** `length` prose override → `size_profile_id`
(a different profile for this run) with optional inline `size` numeric tweaks merged
on top → the tone's default `size_profile_id` → the legacy length block. So a reviewer
can tweak just `size.total_words_max` for one run without touching the tone (see §2h).

Pre-fill the editor with the current layer texts via:
```
GET /segments/:id/regen-prompt?tone_id=<prompts.id>
Authorization: Bearer <jwt>
→ 200 {
  tone_id: string,
  tone: string,                      // display name
  system_message: string,            // read-only (not overridable)
  editable: { scope, tone, structure, length }  // starting text for `overrides`
}
→ 404 { error: { code: "prompt_not_found", ... } }  // no active tone with that id
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
  "overrides_applied": ["tone", "length"],
  "lint": [ /* voice-lint hits — see §2b */ ],
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
  "overrides_applied": [],
  "lint": [ /* voice-lint hits — see §2b */ ],
  "model": "gpt-5.1-2025-11-13",
  "finish_reason": "stop"
}
```
Both regen paths also run the voice lint (`lint`, same shape as §2b). Note: a
`single_card` regen lints only the one regenerated card, so segment-scope rules
(`limit`/`repeat`) can't see the rest of the segment in that case.

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
    topic_id?: string,        // optional — real topics.id FK on the questionnaire row
    milestone_id?: string     // optional — milestones.id. When present the questionnaire
                              //   is born MAPPED (questionnaire.milestone_id) and is
                              //   suppressible per slice 3 (redundant once the child has
                              //   that fact). Absent → NULL (unsuppressible by
                              //   construction). Validated against milestones; the job
                              //   fails clearly if it doesn't resolve.
  }
}
→ 202 { job_id: string }
```
Two DISTINCT track references — do not conflate: `target_track_id` (what answering
activates; the content spec) vs `host_track_id` (where it lives).

Prompt + output schema are DB-composed (the `prompts` row, `prompt_type =
'questionnaire'`) — not a file. Provider is selected by the `QUESTIONNAIRE_WRITER`
env var (`openai` | `gemini`, default `openai`); the schema is stored in the
permissive `responseSchema` form so it works on either provider.

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
  "milestone_id": null,
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

**Approve / publish (human step).** The atom is created `is_published=false`. Publish it via:
```
POST /questionnaires/:id/publish    → 200 { questionnaire_id, is_published: true, questions_approved }
POST /questionnaires/:id/unpublish  → 200 { questionnaire_id, is_published: false }   // back to draft to edit
```
Publish sets `is_published=true` and marks the questions `approved` (requires ≥1
question → else `409 no_questions`); unpublish reverts both. `404 not_found` if the id is unknown.

**Edit the questionnaire prompt (admin).** The generator's prompt is the DB row
`prompt_type='questionnaire'` (migration 0005). Manage it:
```
GET   /questionnaire-prompt    → 200 { prompt: { id, system_message, output_schema, model, temperature, max_tokens, ... } }
PATCH /questionnaire-prompt    → 200 { prompt }   // body: { system_message?, model?, temperature?, max_tokens? }
```
`system_message` is the editable prompt text; `model`/`temperature`/`max_tokens` are
optional (null = provider default). **`output_schema` is NOT editable** (response
contract). A blank `system_message` is ignored (can't blank the prompt).

---

### 2f. Manage voice-lint rules (admin CRUD) — DELIVERED
JWT-protected CRUD over the `voice_lint_rules` table — the editable phrase list
the deterministic voice lint (§2b `lint`) runs against. Edits take effect on the
**next** content generation (no deploy). All routes require
`Authorization: Bearer <jwt>`; errors use `{ error: { code, message } }`.

**Severity drives prevention vs detection.** A `ban`/`opener` rule with
`severity='error'` is BOTH injected into the segment-content prompt as a hard
"never use this" instruction (prevention — the model avoids it up front) AND
flagged post-generation. `severity='warn'` is detection-only. `limit`/`repeat`/
`conditional` are always detection-only (can't be prevented via prompt). So
flipping a phrase rule to `error` in the CMS makes it actually steer generation.
```
GET    /voice-lint-rules            → 200 { rules: Rule[] }   // all, active + inactive
POST   /voice-lint-rules            → 201 { rule: Rule }      // create
PATCH  /voice-lint-rules/:id        → 200 { rule: Rule }      // partial update (merge + revalidate)
DELETE /voice-lint-rules/:id        → 204                     // hard delete (or PATCH is_active=false to disable)
```
`Rule`:
```ts
{
  id: string; rule_key: string;            // rule_key unique
  type: "ban" | "opener" | "limit" | "conditional" | "repeat";
  pattern: string | null; max: number | null; scope: "card" | "segment" | null;
  requires: string | null; within_chars: number | null; min_words: number | null;
  severity: "error" | "warn"; message: string; tone: string | null;
  is_active: boolean; created_at: string; updated_at: string;
}
```
**Server-side validation** (a bad rule cannot be saved) — required fields per type:
- `ban` / `opener`: `pattern`, `severity`, `message`
- `limit`: `pattern`, `max` (int ≥ 1), `scope`, `severity`, `message`
- `conditional`: `pattern`, `requires`, `within_chars` (int ≥ 1), `message` — **`severity` forced to `warn`**
- `repeat`: `min_words` (int ≥ 2), `scope`, `severity`, `message` (no `pattern`)

Type-irrelevant fields are normalized to `null` on write. PATCH merges the body
onto the existing row then re-validates the whole rule, so a partial edit that
changes `type` still must satisfy the new type's requirements. Errors:
`400 invalid_rule` (validation), `409 duplicate_rule_key`, `404 not_found`.

---

### 2g. Manage tones (admin CRUD) — DELIVERED
JWT-protected CRUD over **segment tones**. A tone = one segment `prompts` row +
its 1:1 voice block (`prompt_blocks`, `block_type='tone'`). Everything selects a
tone by its stable **`id`** (= `prompts.id`); `tone` is just the editable display
name. The "technical" layers (`system_message`, `scope`, `output_schema`,
structure/length blocks) are **not** editable here — only the voice + name/params.
```
GET    /tones            → 200 { tones: Tone[] }   // all segment tones (active + inactive)
GET    /tones/:id        → 200 { tone: Tone }
POST   /tones            → 201 { tone: Tone }       // create from template
PATCH  /tones/:id        → 200 { tone: Tone }       // update voice / name / model / params / is_active
DELETE /tones/:id        → 204                       // removes row + its voice block (if unshared)
```
`Tone`:
```ts
{
  id: string; tone: string | null; is_active: boolean;
  model: string; temperature: number | null; max_tokens: number | null;
  system_message: string; scope: string | null;     // read-only context
  structure_block_id: string | null; length_block_id: string | null;
  size_profile_id: string | null;                    // default content-size profile (§2h)
  voice: { block_id: string; name: string | null; label: string | null; content: string | null } | null;
}
```
**POST (create from template)** — body `{ tone: string (required), voice_content: string (required), label?, model?, temperature?, size_profile_id?, structure_block_id? }`. Clones the shared technical layers (`system_message`/`scope`/`output_schema`/`max_tokens`, and `model`/`temperature`/`size_profile_id`/`structure_block_id` unless overridden) from an existing active tone, creates a new 1:1 voice block (name = slug of `tone`), and a new active tone row. Errors: `400 invalid_tone`, `409 duplicate_voice` (slug collision — rename), `409 no_template` (no existing tone to clone).

**PATCH** — body any of `{ tone, model, temperature, is_active, voice_content, voice_label, size_profile_id, structure_block_id }`. Updates the row and/or the voice block; pass `size_profile_id: null` / `structure_block_id: null` to clear. `404 not_found` if the id isn't a segment tone. `structure_block_id` picks the tone's default structure (see §2i).

**DELETE** — removes the tone row, and its voice block too unless another row still references it. `404 not_found` if missing.

New tones are immediately usable: pass the returned `id` as `tone_id` to
`generate_segment_content` / `regen_segment_content` (§2b/§2c).

---

### 2h. Manage content-size profiles (admin CRUD) — DELIVERED
JWT-protected CRUD over `content_size_profiles` — reusable, structured SIZE config
(word/sentence/bullet budgets) **decoupled from tone/voice**. A tone references one
as its default (`Tone.size_profile_id`, §2g); a regen can override per run (§2c).
At generation time the chosen profile's numbers render into the `## Length`
instruction (replacing the legacy length block; the block is the fallback when no
profile is set). Seeded `short` / `standard` / `long` (migration 014).
```
GET    /size-profiles        → 200 { profiles: SizeProfile[] }
POST   /size-profiles        → 201 { profile: SizeProfile }
PATCH  /size-profiles/:id    → 200 { profile: SizeProfile }
DELETE /size-profiles/:id    → 204   // tones referencing it fall back to the length block (FK SET NULL)
```
`SizeProfile`:
```ts
{
  id: string; name: string;          // name unique (slug); required on create
  label: string | null;
  total_words_min: number | null; total_words_max: number | null;
  words_per_card_min: number | null; words_per_card_max: number | null;
  max_sentence_words: number | null; max_bullet_words: number | null;
  max_bullets_per_card: number | null;
  is_active: boolean; created_at: string; updated_at: string;
}
```
All numeric fields are optional (a non-negative integer or `null`) — the renderer
emits a line only for fields that are set, so a profile can constrain just total
words if you like. Errors: `400 invalid_profile`, `409 duplicate_name`, `404 not_found`.

---

### 2i. Manage structure blocks (admin CRUD) — DELIVERED
JWT-protected CRUD over **structure blocks** (`prompt_blocks` where
`block_type='structure'`) — the reusable "card arc" each tone follows. A tone
references one via `Tone.structure_block_id` (§2g); a regen can swap it per run
(§2c). The handler renders the chosen block as the `## Structure` section.
```
GET    /structure-blocks        → 200 { structure_blocks: StructureBlock[] }
POST   /structure-blocks        → 201 { structure_block }
PATCH  /structure-blocks/:id     → 200 { structure_block }
DELETE /structure-blocks/:id     → 204   // 409 in_use if any tone still references it
```
`StructureBlock`:
```ts
{ id: string; name: string; label: string | null; content: string | null;
  is_active: boolean; created_at: string; updated_at: string }
```
`name` is a unique slug (required on create); `content` required on create.
Errors: `400 invalid_block`, `409 duplicate_name`, `409 in_use` (delete blocked
while a tone references it — repoint first), `404 not_found`.

> Note: the seeded default `sturdy_6_card_arc` carries voice-specific language
> (reassurance, scripts, "both things can be true", repair) and is currently shared
> by all tones. Prefer a neutral structure for non-Sturdy tones; edit/add blocks
> here and repoint via tone PATCH (§2g).

---

### 2j. Classify free-form parent update — slice 1 DELIVERED (enrich-only, dry-run, internal/test)

Layer 3 of the questionnaire roadmap (free-form intake → classify →
enrich/suppress). Built ENRICH-ONLY and DRY-RUN first; INTERNAL/TEST-ONLY
until the distress path (below) is real. A parent's prose is classified against
the live catalog of tracks + the questionnaires that route into them, and the
classifier PROPOSES track activations. It does not apply them yet.

**Two deliberate deviations from the §Conventions defaults — stated so they
don't read as mistakes:**
1. **Synchronous, not 202+poll.** A single classification is short (one LLM
   call) and the CMS harness is interactive tuning — you want the result inline,
   not a poll cycle. So this endpoint returns the classification directly, unlike
   AI *generation* work (which stays async). The future async path — processing
   app-submitted updates off the `user_update_events` log as a job — is separate
   and still `[DESIGN]`.
2. **Not a `POST /jobs` type (for this path).** Because it's synchronous and
   side-effect-free by default, the harness path is a direct endpoint, not a job.
   If/when the app feeds updates for async processing, THAT path may become a
   `classify_update` job type; this one isn't.

Auth: **JWT** — the endpoint verifies ANY signed-in Supabase user itself (mounted
without the admin-only middleware) and has TWO CALLER MODES:
- **Admin console** (caller role `admin`/`super_admin`): trusts body `user_id` /
  `child_id` and body `persist`/`apply` (dry-run allowed) — unchanged behavior.
- **App parent** (any other authenticated user): **SELF-SCOPED** (security). `user_id`
  is derived from the token's auth uid — a mismatched body `user_id` is **rejected
  403**, not silently ignored — and `child_id` must belong to that user
  (`children.parent_id`) or **403**. App semantics are forced server-side, not trusted
  from the client: `persist=true`, `apply=true`, `source='app'`.

Note `children.parent_id` lives in the auth-uid space; the `user` table (consulted
only for the admin role) covers it only partially, so an app parent may have no
`user` row — that just means "not admin", a valid self-scoped caller.

```
POST /classify-update
Authorization: Bearer <jwt>
Body: {
  user_id: string,     // ADMIN only; APP callers: derived from token (mismatch → 403)
  child_id: string,    // APP callers: must be children.parent_id === caller (else 403)
  raw_text: string,
  persist?: boolean,   // default false (ADMIN). APP: always true (forced)
  apply?:   boolean    // default false (ADMIN). APP: always true (forced).
                       // apply=true IMPLIES persist=true (see invariants).
}
→ 200 {
  classification: {
    relevant: boolean,            // false = no actionable signal (the COMMON case)
    signals: [
      { type: string,             // e.g. "milestone" | "concern"
        value: string,            // e.g. "crawling"
        confidence: number,       // 0..1
        evidence_span: string }   // substring of raw_text that triggered it
    ]
  },
  proposed_enrichments: [         // tracks proposed (and, when apply=true, activated)
    { action: "activate_track",
      track_id: string,           // validated against the real catalog before return
      track_name: string,
      confidence: number,
      source_signal: string,
      applied: boolean,           // apply=false → always false; apply=true → true if activated
      reason?: string }           // on a skip: 'already_active' | 'manual_override'
  ],
  milestones_recorded: string[],  // milestone names written this apply ([] unless apply=true)
  ack_message: string | null,     // parent-facing acknowledgment (slice 4). Outcome → template
                                  //   key → one random ACTIVE response_templates variant (excludes
                                  //   the user's last-served for that key). null when distress is
                                  //   present (strain+) — the distress response leads — or no template.
  redundant_questionnaires: [     // SUPPRESS (slice 3): questionnaires this update makes redundant.
    { questionnaire_id: string,   // mapped (questionnaire.milestone_id) to a milestone this update resolves
      questionnaire_name: string,
      milestone_id: string }      // the milestone whose fact makes it redundant
  ],                              // apply=true → the milestone is now a fact; apply=false → PROJECTED (no writes). [] when none.
  distress: {                     // DISTRESS (slice B) — detection LIVE, content PROVISIONAL.
    detected: boolean,            // tier !== 'none'
    tier: 'none'|'strain'|'overwhelm'|'safety',
    evidence_span: string|null,   // verbatim substring that drove the tier; null for none
    response: { message: string, resources: [ {label,value,kind:'phone'|'text'|'url'} ] } | null,
    parse_failed: boolean         // true ONLY when the assessment was UNREADABLE after retries
  },                              //   and defaulted to none (marked + audited, never silent none).
                                  // response = the distress_responses row for the tier (null for none)
  provenance: {
    model: string, prompt_version: string,
    catalog_version: string, correlation_id: string
  }
}
→ error: { error: { code, message } }   // standard envelope (§Conventions)
```

**Invariants that hold as the feature grows (shape never changes):**
- `redundant_questionnaires` (slice 3) and `distress` (slice B) were PRESENT-BUT-
  EMPTY from day one and now both populate — the shape never moved.
- `relevant: false` is a valid, expected, COMMON outcome — not an error. The
  classifier is prompted to prefer it and not stretch for weak matches.
- Proposed `track_id`s are always validated against the real catalog before
  returning; unresolved ids are dropped (anti-hallucination gate, same discipline
  as §2e validating `add_threshold` against real answer scores).
- Nothing mutates user state unless `apply=true`. With `apply=false` (default),
  classification is pure. `apply=true` activates the proposed tracks (slice 2 —
  see below) and each enrichment's `applied` flag reports the outcome.
- **`apply=true` IMPLIES `persist=true`** — an applied classification is always
  logged, because provenance (`user_track_activations.source_ref` /
  `child_milestones.source_ref`) points at a real `user_update_events` row; dangling
  refs are not allowed. The endpoint upgrades `apply=true, persist=false` explicitly.

**App-facing free-text input remains gated:** no REAL PARENTS until the distress
tiers + response content are clinically confirmed (see
`docs/provisional-clinical-decisions.md`). Detection and provisional content being
live does NOT open the gate. The gate MOVED (detection is built), it did not vanish.

**Prompt + catalog:** classifier prompt lives in the DB `prompts` tables
(`prompt_type='classify_update'`), versioned, per the no-hardcoded-prompts rule.
The catalog (every track's name+description + the questionnaires that route into
each, read from `questionnaire_response` via the §7 view) is assembled fresh per
call through one function and stamped as `catalog_version` for provenance — so the
later swap from "whole catalog" to "filtered candidate set" is a one-function
change with no contract impact. Track DESCRIPTIONS are load-bearing here, same
single source of truth as §2a / §2e.

**Append-only log:** `user_update_events` stores raw prose verbatim (`user_id`,
`child_id`, `raw_text`, `source`, `created_at`, `processing_status`,
`correlation_id`) — source of truth, never mutated. Written only when
`persist=true`. Derived classifications are separate linked rows, never
overwriting the prose.

**Build slices:** (1) dry-run classify-and-propose, synchronous, no apply [this
section]; (2) enrich-apply — activate proposed tracks via the existing
`user_active_tracks` machinery when `apply=true`; (3) suppress —
`redundant_questionnaires` populates, gated to suppressible questionnaires only,
clinical screens structurally never-suppressible [DELIVERED, below]; (4) distress
detection + provisional response [PROVISIONAL DELIVERED, below] then app-facing
input (still gated). Later slices only fill fields; they don't change this shape.

**Slice 1 — DELIVERED** (`POST /classify-update`, JWT, synchronous): prompt in DB
(`prompt_type='classify_update'`, migration 016); catalog assembled fresh per call
via `assembleCatalog()` and hashed for `catalog_version`; provider via
`CLASSIFY_WRITER` (default openai). Confidence floor `0.6` (below → dropped, and if
no signal survives → `relevant:false`). Proposed `track_id`s validated against the
catalog; unresolved dropped. `prompt_version` = `sha256(system_message)[:12]`.
`persist=true` writes `user_update_events` (raw prose) + `user_update_signals`
(derived, with `matched`/`matched_track_id` for later unmatched-signal queries).

**Slice 2 — DELIVERED** (`apply=true`, migrations 019–020): activates proposed
tracks as per-user overrides in `user_mlp_mods (action='add')` — the base table the
`user_active_tracks` view unions — and records milestone facts, atomically via the
`apply_classification()` fn. Then `rebuildOneUser()` runs AFTER commit (retryable;
a rebuild failure is logged, not rolled back). Per proposal: skip `already_active`
if the pair is already in `user_active_tracks`; skip `manual_override` if the latest
mod is a human `delete` (no backing `user_track_activations` row) — inference never
overrides an explicit human action. Each activation writes a `user_track_activations`
row (`source='classify'`, `source_ref` = the mod id, confidence) — classify vs manual
is always distinguishable by that row. Milestone-type signals resolve (alias-based)
to `milestones` and write `child_milestones` (first-reach-wins), **independent of
whether any track activated** (so `sleeping_through_night`, which no track serves,
still records). `apply=true` implies event persistence (for `source_ref`).

**Slice 3 — DELIVERED** (SUPPRESS, migration 023): a questionnaire whose answer is
equivalent to a recorded fact stops surfacing for that user. The whole slice rests
on one **structural** rule (no toggle):

- **Suppressibility = having a milestone mapping.** `questionnaire.milestone_id`
  (nullable FK) is the ONE canonical questionnaire↔milestone link. MAPPED = the
  questionnaire is redundant for a user whose child already has that milestone.
  UNMAPPED (NULL) = **unsuppressible by construction** — there is no mapping row to
  consult, so no code path can suppress it. Clinical/safety screens map to nothing
  (no milestone exists for e.g. depression) and stay NULL — they can never be
  inference-suppressed. This is the roadmap's hard rule made structural.
- **Derived, not stored.** Milestones are monotonic (a fact never un-happens), so
  suppression needs no state table, no un-suppress, no contradiction handling. At
  MLP build time (`rebuildOneUser` → `generateFullMLP`, PER-USER, not the pool view
  and not the rpc), a questionnaire mapped to milestone X is excluded for a user
  whose (youngest) child has fact X — computed fresh each rebuild from
  `child_milestones`, same correctness-by-construction as `user_active_tracks`.
- **Default-to-surface.** Any doubt — unresolved/dangling mapping, missing child,
  RLS hiccup, error — logs a warning and yields an EMPTY exclusion: the
  questionnaire SURFACES. Suppression fires ONLY on a positive, resolved
  `(child, milestone)` fact match. A bug here can only over-surface, never silently
  hide a questionnaire.
- **`redundant_questionnaires` in the response** reports the questionnaires this
  update makes redundant (mapped to a milestone it resolves). `apply=true` → those
  milestones are now facts; `apply=false` → PROJECTED from proposed facts, no writes.
- **DEFERRED (on record, not forgotten):** the WRITE direction — a questionnaire
  COMPLETION recording its milestone fact (`source='questionnaire'`) — is the
  answer-level `record_milestone` build. It is NOT in this slice because it is
  answer-dependent and safety-sensitive (a "no, not yet" answer must not record the
  milestone), and completion is app-side today (`completed_items`, no backend
  trigger). When built, it READS `questionnaire.milestone_id` (one link, two
  directions) — do not add a parallel mapping.

**Slice B — PROVISIONAL DELIVERED** (DISTRESS, migrations 024–025): detection is
LIVE, response content is PROVISIONAL, app delivery is slice 4 (still gated). The
clinical owner was unavailable (~2 weeks), so this was built to provisional
clinical calls structured so her review is config/content edits, not rebuilds —
tier boundaries in the DB prompt, copy in `distress_responses` (`is_provisional`).
Every clinical judgment is logged in `docs/provisional-clinical-decisions.md` (the
review agenda; the safety-tier intrusive-thoughts wording is flagged TOP priority).

- **Detection** — the classifier gains a SEPARATE, mandatory distress duty
  (migration 024): a `distress { tier, evidence_span }` object, `tier ∈
  none|strain|overwhelm|safety`. It runs OPPOSITE to track matching — LENIENT, NO
  confidence floor, CONSERVATIVE-UPWARD, safety near-deterministic (any safety
  language → `safety`, not weighed against upbeat content), and it COEXISTS with
  signals (a milestone signal AND tier safety at once). Distress NEVER routes
  through tracks; `proposed_enrichments` is unchanged by tier. False positives are
  acceptable; a missed distress is the failure.
- **Response** — the `distress` field carries the `distress_responses` row for the
  tier (`message` + `resources[]`), `null` for none. `detected = tier !== 'none'`.
- **Persistence** (`persist=true`, which `apply=true` forces): the tier lands on
  `user_update_events.distress_tier`; every strain+ detection also writes a
  `distress_detections` audit row (the item-10 analog log). A `persist=false`
  preview returns the payload but writes nothing (console test data — decision D10).
- **Unreadable assessment never silently becomes none** — a garbled distress tier
  is first NORMALIZED (near-misses like "Safety" coerce), then RE-ASKED (retry up to
  3×), and only then defaulted to none with `parse_failed=true` in the response AND a
  `distress_detections(parse_failed=true)` audit row. The audit distinguishes
  "assessed none" (no row) from "couldn't read it" (parse_failed row) — see decision
  D11. Defaulting toward none in the wrong direction would violate the slice's core
  asymmetry; it doesn't.
- **apply is unchanged by distress** — enrichments, milestone facts, suppression
  all behave identically regardless of tier.
- **The gate MOVED, not vanished:** detection + provisional content live ≠ open
  gate. No real parents until clinically confirmed.

**Parent-facing acknowledgments — DELIVERED (`ack_message`).** `response_templates`
(migration 026) holds AUTHORED ack copy — never generated — with MULTIPLE VARIANTS
per `key`. At response assembly (BACKEND-side, not app-side) the outcome maps to a
key and one ACTIVE variant is drawn at random, **excluding the user's last-served
variant** for that key (`user_template_history`, migration 027, upserted per
user/key). Precedence — ONE rule at the top: **distress (strain+) leads → no ack,
`ack_message: null`** (the distress response carries the moment). Otherwise:
applied track(s) + milestone → `milestone_recorded`; tracks only →
`track_added` / `track_added_plural`; milestone only → `milestone_only`; else →
`nothing_matched`. `{milestone_name}` renders `milestones.label` (never the taxonomy
name). History I/O is non-fatal — a best-effort ack never breaks a classification.
CMS editors manage the copy via the `is_admin()`-gated write policy (same gate on
`distress_responses`).

---

## 2f. Generate track content (batch orchestrator) — DELIVERED

`POST /jobs { type:'generate_track_content', input:{...} } → 202 { job_id }`.
Fans out over the EXISTING per-unit generators (`generate_segment_content` + optional
`generate_quiz`) across ALL of a track's lessons/segments. No new generation logic —
orchestration + progress only.

```
input: {
  track_id: string,           // required
  tone_id: string,            // required — prompts.id of the segment tone (per-unit content)
  mode?: 'fill_missing' | 'replace',  // default 'fill_missing'
  quizzes?: boolean,          // default false — also generate/replace quizzes
  include_approved?: boolean  // default false — replace-only, destructive override
}
```

**Modes.** `fill_missing` (default, IDEMPOTENT — and the resume mechanism): generate
only for segments with NO content; quizzes only where absent (`quizzes=true`).
Re-running is always safe and completes a killed batch. `replace`: regenerate
PENDING/unapproved content (+ quizzes); APPROVED is skipped unless
`include_approved=true`. Never destroys approved work. (Approved = segment
`seg_status='complete'`; quiz = all `quiz_questions.answer_status='approved'`.)

**Units.** A unit = a segment; content and quiz are INDEPENDENT units, each
success/failure recorded separately. One unit failing NEVER fails the batch. Content
lands PENDING exactly as single-unit generation (`seg_status → 'pending'`); quiz rows
insert `answer_status='pending'`. Bounded concurrency (`BATCH_CONCURRENCY`, default 2).
Provenance: every unit logs to `ai_generation_log` with `correlation_id = the batch
job.id` — the whole run is one query.

**Progress / result (CMS polls the jobs row, same as everything else):**
```
jobs.result = {
  status: 'running' | 'succeeded' | 'completed_with_errors',
  total: number,             // planned units
  done: number,              // succeeded
  failed: number,            // failed (never fails the batch)
  skipped_approved: number,  // approved units left alone (replace, !include_approved)
  current_unit: string | null,   // e.g. "content:<seg_id>" | "quiz:<seg_id>"
  errors: [ { unit: string, message: string } ]
}
```
Written incrementally as units complete. `jobs.status` stays `succeeded`/`failed` (the
CHECK constraint); `completed_with_errors` (⇔ `failed>0`) lives in `result.status`. A
catastrophic failure (track/enumeration) → `jobs.status='failed'`.

**Survival.** NO per-unit state table — the content tables ARE the resume checkpoint.
A killed batch (reaper → `failed` after 10 min, last `result` snapshot kept) is
completed by re-running the same mode. `fill_missing` resumes trivially (already-present
content is skipped). `replace` resumes **derivably too**: its planner skips units whose
content/quiz was (re)generated at-or-after the current failed/running batch lineage's
start (the earliest non-succeeded prior batch for this track, from the jobs table) —
`created_at` is the regen time because the write path delete+inserts, so a re-fired
`replace` skips the dead run's completed units for free (no duplicate spend, no
mixed-vintage output). Excludes images (own flow) and lesson-stub creation
(`generate_lessons`); never auto-approves.

---

## 3. MLP recompute — DELIVERED

The recompute logic lives here (`rebuildOneUser()` + the atomic `rebuild_user_mlp`
rpc, migration 007) and writes the production `user_mlp` table (cut over from the
`user_mlp_v2` shadow in migration 017). Two entry points:

**App-facing (mobile) — `POST /mlp/recompute`** — the path the RN app uses after
onboarding / a completed questionnaire.
```
POST /mlp/recompute
Authorization: Bearer <end-user Supabase JWT>   // the app's anon-key session token
Body: {}                                         // user_id is derived from the token, NEVER the body
→ 200 { ok: true, user_id, items_written }        // SYNCHRONOUS — recompute done before responding
→ 401 unauthorized (bad/missing token) · 500 recompute_failed
```
Verifies **any** signed-in Supabase user (not the admin gate), recomputes only
**that** user's MLP, synchronously (one fast rpc — no job/poll; the app can't read
the `jobs` table under its RLS anyway). Dependency: whatever applies a
questionnaire's routing → `user_active_tracks` must run **before** this, or the
recompute won't reflect the new answers.

**Admin/server — `POST /jobs { type:"rebuild_mlp" }`** — `input:{ user_id }` for one
user, or `input:{ scope:"all" }` for a full rebuild. Async (202 + job). Admin JWT
or `INTERNAL_API_KEY`. Used by CMS/tooling.

Ordering inputs: item `priority`, track `priority`/`order`/`weight`,
`age_track_weights`, global `consts`. `user_mlp_mods` (per-user manual overrides)
— **not yet applied by the recompute** (BuildShip did; port pending).

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
same polling model. The authoritative `JobType` union is defined once in §2
("Job types in use") — this list must match it, not restate a divergent copy:
```ts
type JobType =
  | 'generate_sub_segment_image'
  | 'generate_lessons'
  | 'generate_segment_content'
  | 'regen_segment_content'
  | 'generate_quiz'
  | 'generate_questionnaire'    // §2e
  | 'generate_track_content';   // §2f
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
- **Questionnaire atom tables (§2e):** `questionnaire` (`id`, `track_id` = HOST
  track, `age` = single age gate in months, `is_published`, `is_score_based`,
  `intro_text`), `questionnaire_questions` (`answer_status` `pending`/`approved`),
  `questionnaire_answers` (each carries a `score`), and `questionnaire_response`
  (the routing rule — `score_min_range`, `score_max_range`, `track_id` = TARGET
  track, `add`, `tag_id`). Two distinct track refs: host on `questionnaire`,
  target on `questionnaire_response`. Routing is read via the
  `questionnaire_response_with_track_tag` view (§7). The atom is created as a
  draft (`is_published=false`); publish is the human approve step (§2e).

---

## 6. Decisions

**Resolved:**
- Error envelope (`{ error: { code, message } }`), `jobs.status` set, approve/reject
  response bodies (§1c/1d), job retry (no route — re-generate).
- **Lesson stubs (was §6.1):** written directly to `lessons` + one `segments` row
  per lesson. Not returned for the frontend to commit.
- **Content gen grain (was §6.2):** segment-level. One `generate_segment_content`
  job per segment, writes N `sub_segments` rows.
- **Prompt composition:** backend-owned. CMS sends references (`seg_id`, `tone_id`);
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
