# FINDINGS — doc-grounded ("informed") segment-content generation

**Brief:** INVESTIGATE-FIRST (2026-10-08). Nothing in `src/`, `prompts/` or `migrations/` was changed.
**Goal under study:** an option at generation time that puts the lesson's linked source documents into
the prompt so cards are written with the docs in view. The existing `doc_grounded` review stays as it is
and remains the after-the-fact check.
**Method:** read the code (citations are `file:line` + function), plus read-only queries against both
databases (`BEGIN READ ONLY … ROLLBACK`, `default_transaction_read_only=on`). Project identity was
confirmed before trusting each connection:

| project | `app_settings.domain` | system_identifier | PG |
|---|---|---|---|
| financial | `financial` | 7678069749886157684 | 17.6 |
| Moosii | `moosii` | 7481590244898220655 | 15.8 |

---

## 1. Prompt composition

**One composer, and every path uses it.** `composeUserMessage()` in
`src/jobs/handlers/generateSegmentContent.ts:123-194` builds the user message. The system message is
`promptRow.system_message`, passed through as is. The call goes through `callAndParseCards()`
(`generateSegmentContent.ts:214-270`).

| path | entry | composer | LLM call |
|---|---|---|---|
| `generate_segment_content` | `generateSegmentContent()` `generateSegmentContent.ts:291` | `composeUserMessage` (:326) | `callAndParseCards` (:342) |
| `regen_segment_content` whole_segment | `regenSegmentContentHandler()` `regenSegmentContent.ts:53` | `composeUserMessage` (:136) | `callAndParseCards` (:163) |
| `regen_segment_content` single_card | same handler | same call, with `regenTarget` set (:150-156) | same |
| `generate_track_content` | `realRunUnit()` `generateTrackContent.ts:166` → `generateSegmentContent()` (:168) | inherited | inherited |

The batch has no composition of its own. It calls the same core with `generate_quiz:false` and the
batch `correlationId` (= `job.id`).

**Rendered order** (system message first, then the user message, joined with blank lines; a section is
left out when it is empty):

| # | layer | source | heading |
|---|---|---|---|
| — | **system_message** | `prompts.system_message`. Not overridable (`regenSegmentContent.ts:113`) | (the `instructions` arg) |
| 1 | **scope** | `prompts.scope`, or `overrides.scope` (regen) | none (raw text) |
| 2 | **voice** | `prompt_blocks[tone_block_id]`, or `overrides.tone` | `## Tone` |
| 3 | **structure** | `overrides.structure` prose > `overrides.structure_block_id` > `structure_block_id` | `## Structure` |
| 4 | **card_positions** | `prompt_blocks[card_positions_block_id]` (shared singleton, never overridable) | `## Card Positions` |
| 5 | **size** | `overrides.length` prose > size profile (override id / inline, then the tone default) > legacy `length_block_id` (`resolveLengthContent()` :83-96) | `## Length` |
| 6 | **avoid** | error-severity voice-lint bans (`loadPromptBanInstruction()`) | `## Avoid` |
| 7 | **guidance** | `input.guidance` (regen only; generate has no such input) | `## Author Feedback (a prior version was REJECTED — apply this)` |
| 8 | **runtime data** | `contentContextLines()` `src/lib/contentContext.ts`: lesson title, age line, kind line, "Lesson part" (only when it differs from the title), description | `## Context` |
| 9 | **single-card target** | `regenTarget`: target sequence/total, old title, prev/next card text | `## Regeneration Target` |

"Overrides" are not a separate section. Each one replaces the text of its own layer (1, 2, 3, 5). The
order of the user message cannot be changed by an override.

**Where a "Reference documents" section fits: right after `## Context`, before `## Regeneration
Target`.** Reasons:
- It is runtime data about *this lesson*, like Context. Everything above Context is reusable tone or
  policy text.
- It keeps the large block out of the middle of the instruction layers (Tone → Length → Avoid →
  Feedback). Those layers stay together and come before the data.
- `## Regeneration Target` stays last, so the single-card instruction ("output exactly ONE card") keeps
  its end-of-prompt position.
- It is one optional field on `composeUserMessage`. When the field is absent the output is
  byte-identical to today's, and that is unit-testable because the composer is pure. It currently has
  **no tests**; `contentContext.test.ts` covers only the Context lines.

## 2. Source documents today

**Schema** (`migrations/036_source_documents_doc_grounded.sql:39-56`, unchanged since then apart from
RLS in 102):
- `source_documents(id, name NOT NULL, body NOT NULL, origin_url, version_label NOT NULL, authority_note, created_at, updated_at)`.
  `body` holds pasted, already-extracted text. There is no PDF path.
- `lesson_source_documents(lesson_id → lessons ON DELETE CASCADE, source_document_id → source_documents ON DELETE CASCADE, created_at, PK(lesson_id, source_document_id))`.
  The link is at **lesson** level, not segment or card.
- `content_findings` adds `source_document_id` (ON DELETE SET NULL), `source_version_label`,
  `finding_kind`, `claim_quote` and `source_passage`.

**Routes** (`src/routes/sourceDocuments.ts`, mounted behind `jwtAuthMiddleware` at `src/index.ts:67`):
`GET /` (list, no body), `GET /:id` (body + `linked_lessons`), `POST /`, `PATCH /:id`, `DELETE /:id`,
`POST /:id/links` (upsert, so idempotent), `DELETE /:id/links/:lesson_id`. **There is no
lesson → docs read route.** The CMS cannot ask "which docs does this lesson have?" without a direct
Supabase read. That matters if the CMS needs to grey out the new option.

**How the review loads and renders docs:**
- Loader: `loadLinkedDocs(lessonId)` `src/jobs/handlers/reviewLesson.ts:83-93`. It is
  **module-private** (not exported). It makes two queries: the link rows for the lesson, then
  `source_documents.select("id, name, version_label, authority_note, body").in("id", ids)`.
  **There is no ORDER BY**, so doc order is not deterministic. It returns `[]` when nothing is linked.
- Zero-docs guard: in `reviewLesson()` (:222-227), not in the loader. The message is
  `No source documents linked to lesson <id> — link at least one before a doc_grounded review.`
- Rendering: inside `composeReviewUserMessage()` (:169-189), appended after the cards:
  ```
  ## Source documents (designated authority — check the cards for CONSISTENCY with these)
  Each is prefixed with its doc_id; set source_document_ref to the doc_id a finding concerns.

  [doc_id: <uuid>] <name> (version: <version_label>)
  Authority: <authority_note>        ← only if set
  <body>
  ---                                ← between docs
  ```

**Can generation reuse it unchanged?**
- **Loader: yes, as is.** It has to be exported, or better, moved to a shared module such as
  `src/lib/sourceDocuments.ts`. That move does not change review behaviour. The generation side should
  sort the result (by name, then id) so a rendered prompt is stable and diffable. Adding the sort inside
  the shared loader would also reorder the docs in the review prompt. That is harmless, but it is a
  change, so it should be the caller's choice.
- **Renderer: no.** The review's doc section carries review-only instructions ("check for
  CONSISTENCY", "set source_document_ref") and `doc_id` UUIDs. For generation, the doc_ids are noise
  that the model could echo into card text. `contentContext.ts:1-3` already records that the model
  "echoes labels back". Generation needs its own small pure renderer: name, version, body, and no
  doc_id. Whether it includes `authority_note` is an open question (Q4).

## 3. Size and budget

Query results (read-only, 2026-10-08):

| | financial | Moosii |
|---|---|---|
| `source_documents` rows | **0** | **1** |
| body length min / avg / max (chars) | — | 1,252 / 1,252 / 1,252 |
| the doc | — | "NIH Safe to Sleep — Ways to Reduce Baby's Risk", `AAP-2022-aligned (retrieved 2026-07)`, has an authority_note |
| link rows / lessons linked | 0 / 0 | 3 / 3 |
| lessons with 1 / 2 / 3+ docs | 0 / 0 / 0 | **3** / 0 / 0 |
| doc chars per linked lesson (min/avg/max) | — | 1,252 / 1,252 / 1,252 |
| lessons total (unarchived) | 12 (12) | 154 (151) |
| `content_findings` doc_grounded | 0 | 8 findings across 2 runs |

**Models on the active rows:**

| row | financial | Moosii |
|---|---|---|
| `segment` (tones) | 1 active, "Plain Money": `gpt-4o`, temp 1.0, max_tokens 3000 | 9 active, **all `gpt-4o`**, temp 1, max_tokens 3000 ("Short" is inactive) |
| `quiz` | `gpt-5.1` | `gpt-5.1` |
| `review_doc_grounded` | `gemini-2.5-flash`, 0.1, 6000 | `gemini-2.5-flash`, 0.1, 6000 |

`max_tokens` is the output cap, so input docs do not eat into it. gpt-4o's context window is 128k
tokens; today's whole corpus is about 300 tokens.

**Truncation or size guard: none anywhere.** The review loads every linked body in full
(`loadLinkedDocs`, `composeReviewUserMessage`); there is no length check, cap or truncation.
`sourceDocuments.ts` `buildPatch()` (:19-32) validates only that fields are non-empty. Body size has no
limit at ingestion.

**Observed latencies** (`ai_generation_log` / `jobs`, Moosii):
- `segment_content`: 84 calls, avg 5.5 s, max 18 s; avg prompt 2,844 chars.
- `content_review_doc_grounded`: 7 calls, avg 16.8 s, max 41.9 s; avg prompt 7,396 chars.
- `generate_segment_content` jobs: 57, avg 17 s, max 34 s (includes the chained quiz).

Financial's numbers are smaller (10 `segment_content` calls, avg 5.7 s). Note that Moosii has 7
doc_grounded log rows but only 2 `review_lesson` doc_grounded jobs, so the other 5 calls came from
outside the job path (dry-run scripts, presumably).

**Implication:** budget is not a constraint at today's volumes. The risk is a future pasted guideline
of 100k+ chars. The proposal is a **legible fail-closed guard** (a total-chars cap that throws before
the LLM call), not truncation. Silently cutting a document would make "informed by doc X" false.

## 4. Provenance

**Stamped today, per artifact:**
- **Card** (`sub_segments`): only `tone_id` (generate :378, whole-seg regen :211, single-card :270).
  It has no job_id, correlation_id or model column. The row has `content, created_at/by, updated_at/by,
  review_state, sequence, tone_id, image*` (`database.types.ts`).
- **Segment**: nothing about generation. `seg_status` is derived.
- **`ai_generation_log`** (`logAiCall()` `src/lib/aiLog.ts:20-40`): `correlation_id, operation
  (segment_content | segment_content_regen | quiz), prompt` (the **full rendered** `[SYSTEM]…[USER]…`
  text), `response` (raw), `model, latency_ms, related_entity_type/id` (segment, or sub_segment for
  single_card), `notes` (tone name + id; regen adds scope + `overrides: [...]`), and `blocks` (jsonb of
  block ids: `{tone, structure, length, card_positions}`).
  - Inaccuracy: `blocks` always records the **tone's default** ids. A regen that swaps
    `structure_block_id` or `size_profile_id` still logs the defaults (`regenSegmentContent.ts:172-177`),
    and a size profile is never logged at all (`length` = `length_block_id`). Only `notes` shows that
    something was overridden.
- **`jobs.input`**: stored verbatim (`src/routes/jobs.ts:8-16`, no whitelist), so any new input flag is
  persisted automatically. **`jobs.result`**: model, finish_reason, lint, ids, overrides_applied.
- **Link gap:** standalone generate/regen use `randomUUID()` as the correlationId
  (`generateSegmentContent.ts:296`, `regenSegmentContent.ts:62`), not `job.id`, and do not return it in
  `jobs.result`. So a job cannot be joined to its log rows except by entity id and time. Review and the
  track batch do use `job.id`.

**How the review persists `source_version_label`:** per finding, at insert time. It resolves the model's
`source_document_ref` against the loaded docs and copies `doc.version_label` into
`content_findings.source_version_label` (`reviewLesson.ts:343-349`). It is a copied snapshot, not a
live FK to a version (036:66). A finding whose ref is unknown keeps NULL doc/version and logs a warning.

**Where a `{source_document_id, version_label}` snapshot could live, cheapest first:**

| option | schema change | what it gives | what it misses |
|---|---|---|---|
| A. `jobs.result.grounding = { documents:[{id, name, version_label, chars}] }` + a `notes` suffix in `ai_generation_log` | **none** | Structured per-run record. `jobs.input` already holds the flag. The log's `prompt` column already holds the full doc text and version labels verbatim. | Not reachable from a card: cards carry no job/correlation id. |
| B. A `blocks`-style key in `ai_generation_log` | none (jsonb), but `blocks` is typed `Record<string, string\|null>` and means "block ids" | — | Bends the meaning of `blocks`. Rejected. |
| C. `sub_segments.grounding jsonb NULL` (or `grounded_sources`), stamped on every card write the way `tone_id` is | **one additive column** | A per-card answer to "written against which doc versions?", so the CMS can compare with `source_documents.version_label` live, the same staleness model as findings. It works for single-card regen too, where siblings keep their own stamp, as with `tone_id`. | A migration plus a types regen. The CMS-direct "add card" path would leave it NULL, which correctly means "not grounded". |

Recommendation: **A in the smallest slice; C only if Mark wants per-card visibility in the CMS** (Q2).
Also: return `correlation_id` in `jobs.result` for generate/regen. That costs one field and closes the
job↔log gap for every content job, grounded or not.

## 5. Quiz

**Confirmed.** `generateQuiz()` `src/jobs/handlers/generateQuiz.ts:142-298` reads, as source material,
only `sub_segments.select("id, title, content, sequence").eq("seg_id", seg_id).order("sequence")`
(:151-157). Its other inputs are the active quiz prompt row + tone block, `question_count`, the avoid
bans, and optional `guidance` (`composeQuizUserMessage()` :71-96). It never touches `lessons`,
`lesson_source_documents` or `source_documents`. Every chained call runs **after** the new cards are
written (`generateSegmentContent.ts:393-395`, `regenSegmentContent.ts:227-229, 281-283`), and so do the
batch quiz units (`generateTrackContent.ts:174`). So a quiz built from grounded cards is grounded
indirectly and **needs no change.** Caveat: grounding is only as good as the cards. The quiz cannot
check the docs itself, which is the review's job.

## 6. Chaining a doc_grounded review after a grounded generation

**Mechanically, yes.** `reviewLesson({ lesson_id, review_type:"doc_grounded", correlationId })` is
already an exported core that takes a correlationId (`reviewLesson.ts:202-207`, "so a later batch can
drive it"). It would be called right after the cards insert, exactly like `generateQuiz`.

**Cost:**
- **One extra LLM call, on a different provider**: `gemini-2.5-flash` on both projects, chosen by
  `providerForModel` (:215). Cross-model checking is a real benefit.
- **Duration:** observed review avg 17 s, max 42 s, on top of generate avg 17 s, max 34 s. That gives
  roughly 35–75 s per segment, far under the 10-minute reaper. In `generate_track_content`
  (concurrency 2) it would about double batch wall-time.
- **Writes:** `content_findings` rows only. Read-only on content, so invariants 2, 5 and 10 are
  untouched.

**Problems that argue against chaining in the first slice:**
1. **Failure semantics.** The cards are already committed when the review runs. A review throw (parse
   failure, truncation, provider error) would mark the job `failed` even though the content was replaced
   successfully. The chained quiz has the same flaw today. Chaining would need a soft-fail
   (`result.review = { error }`, job still succeeded), which contradicts "jobs are whole-unit".
2. **Lesson scope vs segment scope.** The review reads **every** card of the lesson (`loadLessonCards()`
   :144-164). After a single-card regen it would re-flag the untouched siblings and stack duplicate
   findings, because cross-run dedup is deferred (§2k "slice 3"). It only fits whole-segment
   generate/regen, and only while lesson:segment is 1:1.
3. **Lesson-level findings pile up.** Regen deletes card-level findings (cascade or explicit), but
   lesson-level ones (`sub_segment_id NULL`) survive. Each chained run adds another set.
4. It is already one click away: `review_lesson` exists as a job the CMS can fire after the content job.

Verdict: **do not chain in the smallest slice.** Revisit together with review dedup (slice 3).

## 7. Zero-docs behaviour

**Fail in the handler, before the LLM call and before any destructive step, with the review's wording.**
Both handlers load the lesson early, then compose, then call, then destroy:
- `generateSegmentContent()`: after the lesson load (:307-312), before the prompt row and blocks load
  (:315). The destructive delete is at :363-368, after the LLM call, so failing early also spends
  nothing.
- `regenSegmentContentHandler()`: after the published-lesson guard (:81-86), before step 3 (:110).
  Generate-before-destroy holds anyway.

Suggested message, mirroring `reviewLesson.ts:225`:
`No source documents linked to lesson <id> — link at least one or turn off use_source_documents.`

Put it in one shared helper (`loadDocsForGrounding(lessonId)` = loader + zero check + size cap) so
generate and regen cannot drift. **`generate_track_content`:** a per-unit throw is recorded in
`result.errors[]` and the batch continues (`executeTrackContent()` :203-209). That is legible and costs
no LLM spend for ungrounded lessons. A `fill_missing` re-run retries them once docs are linked. Whether
the batch should get the option at all is Q3.

## 8. Contract drift (`docs/api-contract.md` vs code)

**§2b Generate segment content**
1. "reads the `segment_content` prompt row". In code the row is `prompt_type='segment'`, active,
   selected by `prompts.id` (`loadSegmentPromptRowById()` :45-63). `segment_content` is only the
   `ai_generation_log.operation` name.
2. The provider is **hardcoded OpenAI** regardless of the row's model (`callAndParseCards()` :220,
   `getLLMClient("openai")`; quiz too, `generateQuiz.ts:183`). The contract says nothing about this.
   CLAUDE.md "Model abstraction" says DB-composed callers derive the provider from the row
   (`providerForModel`). It is latent today because every segment row is `gpt-4o`, but a `gemini-*`
   tone would 404. This is CLAUDE.md drift more than contract drift; backlog candidate.
3. It does not say that first-time generate also **purges the old cards' images** (storage +
   `image_assets`) before delete+insert (:363-364). §2c covers only the regen case.
4. It does not say that **standalone generate's correlationId is a fresh UUID, not `job.id`**, and that
   `jobs.result` does not echo it (see §4 above).
5. No published-lesson precondition on generate (regen has one, `regenSegmentContent.ts:81`). The
   contract claims none, so this is not drift, but on financial the 064 trigger blocks it at the DB
   instead.

**§2c Regenerate segment content**
6. whole_segment: "Removes all the segment's images (cascade)". The code **explicitly purges** first
   (`purgeImagesForSubSegments` :196), then the cascade drops the rows. The "Images on regen" paragraph
   is correct; the scope paragraph is not.
7. whole_segment: "Resets `seg_status → 'pending'` and `approved_by → null`". The code never writes
   either. Fresh cards default to `draft`, and `recomputeSegStatus()` (:224) derives pending and nulls
   `approved_by` (056 `recompute_seg_status`). The outcome is the same but the stated mechanism
   contradicts the "derived, never written" rule.
8. single_card: it does not say the handler also **deletes that card's `content_findings`** (:258-264).
   That is stated only in §2k.
9. "ai_generation_log records … which layers were overridden". True for `notes`, but
   `ai_generation_log.blocks` records the tone's default block ids even when `structure_block_id` or
   `size_profile_id` is overridden, and never records a size profile (:172-177).
10. `GET /segments/:id/regen-prompt` "current layer texts": `editable.length` is the **legacy
    `length_block_id` text** (`src/routes/segments.ts:117-121`), not what generation renders, which is
    the size profile via `resolveLengthContent`. For any tone with `size_profile_id`, the pre-fill
    differs from the real prompt. Sending it back unchanged as `overrides.length` would *replace* the
    size profile with the legacy block. Real bug-class drift, flagged for backlog.

**§2k Review lesson content**
11. "provider via `REVIEW_WRITER`, default `openai`". The provider is **derived from the row's model**
    (`providerForModel`, :215); `REVIEW_WRITER` is only the fallback for a model-less row. Live
    `review_doc_grounded` rows are `gemini-2.5-flash` on both projects, so `result.provider` is
    `gemini` (the example shows `openai`/`gpt-4o`).
12. The `content_findings` column list omits **`category`**, which the handler writes for
    best_practices (:326). The column **exists live on both projects**, but **no migration file in the
    repo creates it** (`grep category migrations/*.sql` finds nothing on content_findings). That is a
    repo-reconciliation gap.
13. The best_practices output shape is different: `{category, card_title, note, quote}`, anchored by
    **card title**, severity forced to `info`, unknown category → dropped (:285-332). The contract
    describes card_ref anchoring for all types.
14. Not described: `{{card_positions}}` substitution into the review system message, which aborts if
    the token is present without a block (`resolveReviewSystemMessage()` :112-124). Also not described:
    only non-empty cards are loaded, and the job fails on "no segments" / "no content cards" (:153, :162).
    It reviews cards of **all** the lesson's segments, not just the one the app reads.

**§2k-doc doc_grounded review**
15. The kind → severity mapping (contradicted → `issue`, others → `warning`) is **prompt-only**. The
    server accepts any valid severity the model returns and defaults to `info` (:341).
16. `claim_quote` / `source_passage` are stored as the model returns them. They are **not checked** to
    be real substrings, although the contract says "exact source text".
17. An unknown `source_document_ref` keeps the finding with NULL `source_document_id` /
    `source_version_label` (:347-349). Undocumented.
18. Doc order in the prompt is unspecified (no ORDER BY in `loadLinkedDocs`). "ALL linked docs into one
    call" is accurate: no cap, no truncation.

**§2l Source documents**
19. `POST /:id/links` returns `{ ok, lesson_id, source_document_id }`, not `{ ok }` (additive).
20. Undocumented errors: a link to a missing lesson/doc → **404 `not_found`** (23503 mapped, :102); a
    missing link on DELETE → 404; an empty PATCH → 400 `invalid_source_document`; PATCH **cannot clear**
    `name`/`body`/`version_label` (blank values are ignored), but blank `origin_url`/`authority_note`
    clear to NULL.
21. There is no lesson-scoped read (docs for a lesson). The contract doesn't claim one; this is noted
    as a gap for the new option's UI.

Also outside the contract: CLAUDE.md "Stack" still says financial has "no content, no prompt rows".
Migrations 084/089 seeded both (financial has 12 lessons and active `segment`/`quiz`/`review_*` rows).
CLAUDE.md is not edited here; that is for Mark to decide.

---

## Proposed smallest slice — `use_source_documents` (informed mode only)

**Contract (additive):** an optional `use_source_documents?: boolean` (default false) on the
`generate_segment_content` and `regen_segment_content` inputs (both scopes). Absent or false gives
today's behaviour **byte-for-byte**.

**Build:**
1. `src/lib/sourceDocuments.ts`. Move `loadLinkedDocs` here unchanged and re-import it in
   `reviewLesson.ts` (review behaviour identical). Add `loadDocsForGrounding(lessonId)` = loader + sort
   (name, id) + zero-docs throw (§7) + total-chars cap throw (e.g. 200,000 chars ≈ 50k tokens, well
   inside gpt-4o's 128k; the exact number is Q5). Add a pure `renderReferenceDocuments(docs)` with no
   doc_ids.
2. `composeUserMessage` gains an optional `referenceDocuments?: string`, rendered as
   `## Reference Documents` **after `## Context`, before `## Regeneration Target`**. The framing text
   is a code constant, following the precedent of the `## Author Feedback` header. It says: use these
   as the factual basis; do not contradict them; do not cite, quote at length or name them in the card
   text; the tone, structure, card positions and length rules still govern; content the documents don't
   cover may still be written. That last clause is what makes it *informed* rather than *strict*.
3. Both handlers: if the flag is set, call `loadDocsForGrounding(lesson.id)` right after the lesson
   load. Pass the rendered section to the composer. Add `grounded: [id@version,…]` to `notes`. Return
   `grounding: { documents: [{ id, name, version_label, chars }] }` and `correlation_id` in
   `jobs.result`.
4. Tests (new files added to `package.json` `test`): composer byte-identical without the option;
   section placement with it, including with `regenTarget`; renderer output (no doc_id, stable order);
   zero-docs and over-cap throws of the pure guard.
5. Docs in the same commit: `api-contract.md` §2b/§2c (the new input, the result field, the failure
   message).

**Not touched:** the `card_positions` block and its loading (READ-ONLY, per the brief and invariant 2),
the review, the quiz, `generate_track_content`, the MLP, the CMS. **No migration.** No new
`prompts`/`prompt_blocks` rows. Moosii and financial get identical code. Financial has zero docs, so the
option there can only fail legibly until docs exist.

**Alternatives rejected:**
- **A DB-editable grounding block** (a `prompt_blocks` singleton like card_positions, or a column on
  `prompts`). This needs a migration plus an admin route, and the framing is policy that is better
  pinned while informed-mode is proven. Revisit if Mark wants to tune the wording in the CMS (Q1).
- **Reusing `composeReviewUserMessage`'s doc section.** It carries review instructions and doc_id
  UUIDs that the generator would echo.
- **Per-tone grounding (a flag on the `prompts` row).** Grounding depends on the lesson's docs, not on
  the voice. A run-level flag matches the brief ("an OPTION at generation time").
- **Truncating oversized docs.** It silently falsifies "informed by". Fail closed instead.
- **Chaining the doc_grounded review in-job.** See §6: soft-fail semantics, lesson vs segment scope,
  duplicate findings.
- **Per-card provenance column (`sub_segments.grounding`).** A real option (§4 C), but a migration
  that the smallest slice doesn't need. It is held behind Q2.
- **Track-batch support now.** It is about two lines, but the zero-docs batch semantics need a decision
  (Q3).
- **Segment- or card-level doc linking.** The schema is lesson-level by design (036); out of scope.

**Migration needed by the smallest slice: none.** If Q2 is yes: `110_sub_segments_grounding.sql`
(number per `migrations/README.md`), adding `ALTER TABLE sub_segments ADD COLUMN grounding jsonb NULL`
plus a comment. It is additive; NULL means not grounded; both projects; then a types regen. Not written.

## Open questions for Mark

1. **Framing text in code or in the DB?** The proposal pins it as a code constant, like the
   `## Author Feedback` header. Do you want it CMS-editable from day one? That needs a migration and a
   route.
2. **Per-card provenance?** Is `jobs.result.grounding` + the log enough, or should the CMS show
   "written against NIH Safe to Sleep @ AAP-2022-aligned" per card, with staleness? That needs the
   `sub_segments.grounding` column.
3. **`generate_track_content`:** include the option now? If yes, should a lesson with no docs fail its
   unit (legible, retried by fill_missing) or be skipped and generated ungrounded?
4. **Include `authority_note` in the generation prompt?** It helps the model weigh the docs, but it is
   human/clinical commentary ("designated by Michelle…") that could leak into card text.
5. **Size cap value**, and should it also be enforced at ingestion (`POST/PATCH /source-documents`) so
   the failure happens when a doc is pasted rather than at generation time?
6. **A citation lint?** Should voice-lint get a rule against "according to the document / NIH …" so
   leaks show up as advisory `lint` hits? That is a seed row, not code.
7. **Should the CMS get `GET /lessons/:id/source-documents`** so it can disable the option for lessons
   with no docs, instead of letting the job fail?
8. Backlog candidates found along the way (not in this slice): hardcoded OpenAI provider in
   content/quiz (§8.2); regen-prompt `editable.length` showing the legacy block (§8.10); no migration
   file for `content_findings.category` (§8.12); `blocks` logging defaults under overrides (§8.9).
