# FINDINGS — single-track build-out (content → images, one action, one report)

**Brief:** INVESTIGATE ONLY (Mark, 2026-11-22). One action on ONE track that runs the existing
`generate_track_content` (§2f) then `generate_track_images` (§2g), optionally `review_lesson` (§2k)
per lesson, as one parent job with one correlation id, ending in a per-lesson run report. No new
generation logic. Nothing built, nothing committed, nothing applied. All DB access read-only inside
`BEGIN TRANSACTION READ ONLY … ROLLBACK`.

**Verdict: buildable, and small — two surgical changes to the existing executors plus a new parent
handler. No new generation logic, no migration required.** But the investigation turned up **four
things that are not design questions**, and they should be settled before any code:

1. **§2f destroys APPROVED IMAGES.** `generate_segment_content` purges *every* image on the
   segment's cards — storage file, `image_assets` row and `content_images` row — with no status
   filter, before delete+inserting the new cards. §2f promises it "never destroys approved work";
   that promise holds for content and quiz, **not for images**. Measured on Moosii: **5 segments
   whose content is unapproved carry 17 APPROVED images**, so a `replace` build-out over them today
   loses 17 approved images and their files. (§4)
2. **Chaining images onto content reverses a documented deliberate decision.** §2g says, in the
   contract: *"NOT chained from the content batch (deliberate — content output is pending review;
   images fire on a human decision, not automatically)."* The proposal is that chain. It may well be
   the right call now, but it is Mark's to reverse explicitly, not mine to quietly implement. (§1)
3. **The replace-resume lineage breaks under a new parent job type.** `resumeCutoff` keys on
   `type = 'generate_track_content'`; a parent of a new type finds no lineage, so its cutoff is its
   own `created_at` and a re-fired `replace` **redoes every unit the dead run already paid for**.
   Fixable in three lines, but silent if missed. (§2)
4. **The reaper cannot see a job orphaned less than 10 minutes before a restart.** It runs **once,
   at boot** (`src/index.ts:130`), so such a row stays `running` forever until some later boot. For a
   parent job that means a CMS panel showing a perpetually-running build-out. (§2)

Also noted, unrelated to this slice: **`api-contract.md` numbers 2f and 2g twice** — `### 2f` voice-lint
rules (line 990) vs `## 2f` generate track content (line 1710), and `### 2g` tones (1032) vs `## 2g`
generate track images (1772). The brief's numbering is the second pair. Worth renumbering; flagged,
not changed.

---

## 1. Chaining

### Child jobs vs direct calls — recommend DIRECT, with one refactor

| | child jobs | direct in-process calls |
|---|---|---|
| one `ai_generation_log` query | ✗ correlation id becomes the CHILD job id | ✓ parent `job.id` threads both, free |
| `jobs.result` ownership | ✓ each phase owns its row | ✗ both executors write `jobs.result` for `jobId` — they would clobber each other |
| replace lineage (§2) | ✓ unchanged (type stays `generate_track_content`) | ✗ needs the lineage fix |
| parent machinery | polling child rows, parent sits `running` meanwhile | none |
| CMS visibility | extra rows per phase | one row, one progress object |

Both executors hardwire `correlationId = jobId`
(`generateTrackContent.ts:219`, `generateTrackImages.ts:122`) and both own `jobs.result` for that
id (`generateTrackContent.ts:206-208`, `generateTrackImages.ts:109-111`). So **either** option needs
a change; the question is which change is smaller and which failure mode is worse.

**Recommended: a `build_track` handler that calls the exported functions directly**, with:

- **(a) an injectable progress writer.** `executeTrackContent` / `executeTrackImages` take a
  `writeProgress(partial)` callback instead of owning the `jobs.result` update. The parent passes a
  writer that merges into `result.phases.content` / `result.phases.images`, so one row carries both
  phases and neither phase can clobber the other. Default stays today's behaviour, so §2f and §2g
  keep working unchanged when fired on their own.
- **(b) the lineage fix** in §2 below.

This keeps the correlation id requirement satisfied by construction — one `job.id`, one
`ai_generation_log` thread across content, quiz, image-prompt and image-generate calls, and
`content_images.job_id` on the same id (`generateTrackImages.ts:95`).

It is also consistent with CLAUDE.md's "jobs are WHOLE-UNIT": the parent succeeds or fails
atomically and is resumed by re-firing. (CLAUDE.md's "ONE JOB PER IMAGE" rule is about the
*frontend* fanning out single images; §2f/§2g already settled that a track-level orchestrator is a
job of its own.)

### Should images wait for ALL content, or start per lesson?

**Wait. Phase-sequential, and the reason is not taste — image slots do not exist yet.**

A slot is a `sub_segment` (`generateTrackImages.ts:46-66`), and sub_segments are *created* by content
generation (`generateSegmentContent.ts:333-336`). Measured: the **Adoption** track has 7 lessons, 7
segments and **0 sub_segments**, so `planTrackImages` returns an empty plan today. Images must be
**re-planned after the content phase**, not planned once up front.

Three further reasons to keep the phases sequential:

- **Concurrency posture.** Both executors read `BATCH_CONCURRENCY` independently (default 2,
  `generateTrackContent.ts:45`, `generateTrackImages.ts:42`). Running them concurrently puts **4**
  AI calls in flight. The contract is explicit: *"images are the most expensive unit — the posture is
  kept. Don't raise."*
- **The overlap is worth almost nothing.** Measured below: content runs at 3.4–4.9 s/unit, images at
  7.7 s/image. For Adoption that is ~30 s of content against ~6.8 min of images — interleaving saves
  ~30 s out of ~8 min, for a materially more complex resume story.
- **Re-fire resume stays trivial** when each phase is derivable from the tables at the moment it
  plans.

---

## 2. Survival

### Measured durations (real `jobs` rows, Moosii)

| job type | n | avg | p50 | max |
|---|---:|---:|---:|---:|
| `generate_track_images` | 2 | 320 s | — | **362 s for 47 images → 7.7 s/image** |
| `generate_track_content` | 9 | 17.5 s | 16.4 s | 40.6 s for 12 units → **3.4 s/unit** |
| `generate_segment_content` (single) | 61 | 16.8 s | 15.0 s | 33.5 s |
| `generate_sub_segment_image` (single, succeeded) | 312 | 23.3 s | 13.7 s | 563.7 s |
| `generate_sub_segment_image` (single, **failed**) | 48 | **122.6 s** | 67.3 s | **1244.7 s** |
| `review_lesson` | 20 | 8.2 s | 6.0 s | 25.4 s |

The other content-batch runs give 6 units in 29.3 s (4.9 s/unit) and 10 units in 24.4 s. **Use
3.4–4.9 s per content unit and 7.7 s per image, both at concurrency 2.**

**A full greenfield track therefore runs ~8 minutes** (Adoption: 7 content + 7 quiz + ~53 images),
and a 16-lesson track such as `Fine Motor | Typical Dev` would run **~15 minutes** — over the 10-minute
mark that matters below.

### Does the 10-minute reaper threaten it? No — but something else does

`reapStaleJobs` runs **exactly once, at boot** (`src/index.ts:128-131`; `src/jobs/runner.ts:142-162`).
It is an **orphan detector, not a timeout**: a job running for an hour in a live process is never
touched. CLAUDE.md's "> 10 min as failed on startup" is precise, and Render Starter stays warm, so
there is no spin-down.

The real exposures:

- **A deploy orphans it.** A push to `master` redeploys Render and kills in-process work. An 8–15
  minute build-out is a wide window to land a deploy in. Nothing marks the row at that instant; the
  *next* boot's reaper fails it only if `started_at` is already more than 10 minutes old.
- **The sub-10-minute orphan is invisible.** Orphaned at minute 3, the row is 3 minutes old when the
  boot reaper runs, so it is skipped — and the reaper never runs again until the next boot. The row
  stays `running` indefinitely. Measured: **0 such rows on Moosii today**, so this is latent, not
  live. A periodic reaper (or a reaper pass that also fails `running` rows with no live owner) would
  close it; that is a decision, not part of this slice.
- **No request timeout anywhere.** No `AbortSignal`/timeout on the LLM or image paths; retries live
  inside the provider with ~62 s of total backoff (`src/lib/retry.ts:85-105`). The measured 1244 s
  single image unit is what that looks like in practice — **one pathological unit can consume 20
  minutes of a build-out's budget.**

### How a killed build-out resumes

- **`fill_missing`: fully derivable, no change needed.** Content plan = segments with no non-empty
  card (`generateTrackContent.ts:119-120`); image plan = slots with no `candidate`/`approved` image
  (`generateTrackImages.ts:84-86`). Re-fire and it completes.
- **`replace`: derivable *today*, and this is the trap.** `resumeCutoff`
  (`generateTrackContent.ts:146-160`) finds the earliest failed/running batch for this track since
  the last success, and the planner skips units whose content was regenerated at-or-after it
  (`:105-109`, `:123`, `:134`). That query filters `type = 'generate_track_content'` (`:150`).
  **A parent job of a new type is not in that lineage**, so the cutoff falls back to the parent's own
  `created_at` and nothing is skipped — a re-fired `replace` pays for every unit again and mixes
  vintages. **Fix:** have `resumeCutoff` accept the set of types that count as this track's lineage
  (`['generate_track_content', 'build_track']`) and match on either, so legacy §2f runs and
  build-outs share one lineage. Three lines, and it must not be forgotten.
  (Minor, same function: it loads *all* `generate_track_content` rows and filters `track_id` in JS
  (`:155`). Fine at 9 rows; it should become a SQL filter before this type sees real traffic.)

---

## 3. Safety

### Confirmed: replace skips approved content and quiz

- Content: `contentApproved = seg_status === 'complete' || 'approved'`; if approved and not
  `include_approved`, the unit is **not planned** and `skipped_approved++`
  (`generateTrackContent.ts:118`, `:122`).
- Quiz: `quizApproved = count > 0 && no unapproved question`, same treatment (`:129`, `:133`).
- And an `include_approved` regen cannot *stay* approved: fresh cards insert as `review_state='draft'`
  (056) and `recomputeSegStatus` derives `seg_status='pending'` (`:184`, and
  `makeRunUnit`'s comment at `:181-183`). `seg_status` is never written directly.

### What happens today if replace hits a PUBLISHED lesson

**Nothing stops it on Moosii, and the lesson stays published while its content is replaced.**

- §2c regen has a hard block — `if (lesson.is_published) throw`
  (`src/jobs/handlers/regenSegmentContent.ts:86-89`). **The unit §2f actually calls,
  `generateSegmentContent`, has no such guard** — stated outright in the contract at
  `docs/api-contract.md:540-542`: *"There is no published-lesson guard here (regen has one); on
  financial the 064 trigger blocks it at the DB."*
- So per domain: **financial = block** (migration 064 raises; the unit fails, is recorded, the batch
  continues), **Moosii = warn** — and the "warn" has no code by design
  (`migrations/064_domain_setting_and_edit_guard.sql` header: the state is DERIVED, migration 065 names it in
  `lessons_review_status`).
- The consequence chain on Moosii: cards are purged and delete+inserted → review resets to `draft`
  via the 066 trigger → `seg_status` → `pending` → `lessons.is_published` is **untouched** → the
  lesson is `published_unreviewed` in the 065 view. Because the app reads the **first
  `seg_status='complete'` segment** (CLAUDE.md invariant 10), a single-segment lesson — which is
  every lesson measured here, 1 segment each — has **no segment the app can read**. It is published
  and empty.
  ⚠ Exactly *how* moosii-rn renders that (blank, skeleton, or hidden) is the app seat's to confirm;
  this repo only establishes that the segment the app selects ceases to exist.
- Measured exposure: **0 published lessons in the `live` group** (32 lessons), **7 in `mem`** (39),
  **4 in `legacy`** (84). So the live catalog is safe from this today and `mem` is not.

### Proposal

- **Exclude published lessons at the planner.** `planTrackContent` selects lessons with no
  `is_published` filter (`generateTrackContent.ts:58-59`); add one, and count them
  `skipped_published` in the result so the report says *why* a lesson was left alone. Same for the
  image phase, which has the identical unfiltered select (`generateTrackImages.ts:50-51`).
- **Refuse `include_approved` outright** in the parent's input validation — throw before planning,
  alongside the existing `track_id` / `tone_id` / `mode` checks
  (`generateTrackContent.ts:239-243`). A bulk build-out is the wrong place for a destructive
  override; the per-segment flow keeps it.
- **While there: archived lessons.** The planner does not filter `lessons.archived_at` either.
  Measured: 0 archived lessons in `live`, **3 in `mem`**. Generating content for a lesson no parent
  can see is waste, not damage — a `skipped_archived` count and a filter are cheap.

---

## 4. Images that the content phase destroys

**The premise needs correcting, and in the worse direction.** A rewritten card's candidate image is
not left stale — it is **deleted outright**, and so is an approved one.

`generateSegmentContent` calls `purgeImagesForSubSegments(prevCards)` *before* deleting the cards
(`generateSegmentContent.ts:310-321`), and that helper has **no status filter at all**
(`src/storage/purgeImages.ts:24-30` onward): it clears `sub_segments.image`, deletes the
`content_images` rows, removes the storage objects and cleans up `image_assets`. The ordering is
invariant 5's — storage object before `image_assets`, or the trigger raises P0001.

Measured on Moosii, segments whose content is **not** approved (i.e. reachable by `replace`):

| what a `replace` over those segments destroys | segments | images |
|---|---:|---:|
| **APPROVED images** | **5** | **17** |
| candidate images | 28 | 210 |

The 210 candidates are a non-issue: they die and §2g refills them, which is the behaviour the brief
asks for — reached by deletion rather than superseding. **The 17 approved images are the problem.**
Each represents a human decision plus a storage file, and §2f's stated contract is "never destroys
approved work."

**Proposal, in preference order:**

1. **The build-out excludes segments that carry an `approved` image**, counted
   `skipped_approved_image` with the segment named in the report. Consistent with how it already
   treats approved content and quiz, and it needs no change to the purge path — just the planner.
2. If Mark wants those segments rebuilt anyway, gate it behind its own explicit flag
   (`replace_approved_images`), never the existing `include_approved`, and have the report list
   every image lost.
3. **Superseding instead of deleting** (`status='superseded'`, keep the row and the file) is a change
   to `purgeImages` that affects §2b, §2c and §2f alike, plus the `sub_segments.image` pointer and
   the partial unique index on one `approved` image per owner. Bigger than this slice; worth its own
   brief if an audit trail of replaced images is wanted.

Note the asymmetry that makes (1) sufficient: `generate_track_images` is **fill-only** — plan =
slots with no `candidate`/`approved` image (`generateTrackImages.ts:84-86`) — so it never touches an
existing image either way.

---

## 5. Tone

**There is no per-track tone today.** `tracks` has no tone column (measured: `created_at,
track_name, track_type, description, last_updated, id, priority, order, weight, updated_at,
created_by, archived_at, test_group, mode_archived`). §2f requires `tone_id` in the input and throws
without it (`generateTrackContent.ts:240`).

What does exist:

- **A single global default**: `prompts."default" = true` on exactly one active segment row —
  `67a24417-f694-4cd7-bdea-3fe74d7f2f5f`, *"Conversational Gen-Z Nurse"*. 9 active segment tones in
  all, all `gpt-4o`, `max_tokens` 3000.
- **Per-card provenance**: `sub_segments.tone_id` (migration 030, `api-contract.md:548-555`) — but
  it is **not reliable enough to derive a track's tone from.** Measured across the three `live`
  tracks that have cards: `Feeding: Bottle Feeding` has 1 distinct tone ("Calm clinician") with
  **17 of 34 cards NULL**; `Postpartum Depression` (16 cards) and `Military` (8 cards) have **no
  tone stamped at all**. The contract says so explicitly: *"`null` = not recorded (pre-migration /
  never stamped); never backfilled."*

**Options:**

| | change | verdict |
|---|---|---|
| keep `tone_id` required | none | correct but hostile for a one-click action |
| **default to the `prompts."default"` row when omitted** | ~5 lines, no migration | **recommend now** |
| `tracks.default_tone_id` FK → `prompts(id)` | one migration + CMS field | recommend when the CMS gets a build-out screen; the durable answer |
| derive from the track's most-stamped card tone | moderate | **reject** — the data is 2-of-3 tracks empty |

---

## 6. Plan preview — and what it cannot know

**Both planners are already exported pure reads**, written for exactly this
(`planTrackContent`, `generateTrackContent.ts:51`, *"Pure read — no generation. Exported so the DoD
proofs can assert the plan directly without firing the LLM"*; `planTrackImages`,
`generateTrackImages.ts:46`). A `GET /tracks/:id/buildout-plan` can call both and fire nothing.

**The honest caveat: the image count is unknowable before content exists**, because content creates
the slots (§1). A preview must present two numbers — images for slots that exist now (exact) and an
**estimate** for slots the content phase will create.

**Measured multiplier (Moosii, 77 segments with content):** **7.51 cards/segment** on average;
p50 **8**, p90 **9**, range **4–10**. So
`estimated_new_slots = segments_in_the_content_plan × 7.5` (and quote the 4–10 band, since card
count is model-determined — `api-contract.md:544-546`).

### Measured per-unit cost basis (`ai_generation_log`, Moosii)

| unit | AI calls | model | avg in | avg out | avg total | avg latency |
|---|---:|---|---:|---:|---:|---:|
| content (1 segment) | 1 | `gpt-4o` (86 calls) | 744 | 373 | **1 117** | 5.4 s |
| content | 1 | `gpt-5.1` (3 calls) | 625 | 813 | 1 438 | — |
| quiz (1 segment) | 1 | `gpt-5.1` (73 calls) | 876 | 369 | **1 245** | 5.7 s |
| image (1 slot) — step 1 | 1 | `gpt-4o` (410 calls) | 1 716 | 196 | **1 911** | 3.0 s |
| image (1 slot) — step 2 | 1 | `gemini-3.1-flash-image` (383) | — | — | **per-image, no tokens** | 8.1 s |
| `review_lesson` best_practices | 1 | `gpt-4o` (14 calls) | 1 279 | 221 | 1 500 | 5.7 s |
| `review_lesson` doc_grounded | 1 | `gemini-2.5-flash` / `gpt-4o` | 2 157 | 253 | 2 410 | **17.3 s** |

**An image slot costs two AI calls, one of them priced per image.** `image_generate` records no
`usage` (0 of 383 rows) — image models don't report tokens.

**There is no price table in this repo** (checked `src/lib`, `src/llm`). So the preview can produce
exact token and call counts, and the dollar figure needs a rate card as input:

```
cost ≈ Σ(content units) × (744·in$ + 373·out$)        [gpt-4o]
     + Σ(quiz units)    × (876·in$ + 369·out$)        [gpt-5.1]
     + Σ(image slots)   × (1716·in$ + 196·out$)       [gpt-4o, the prompt writer]
     + Σ(image slots)   × per-image price             [gemini-3.1-flash-image]
```

**Decision for Mark:** where the rates live. A small `app_settings` row (`model_prices` jsonb) keeps
them editable without a deploy and out of code; hard-coding them in the preview route is faster and
goes stale silently. Neither is a secret, so neither conflicts with the secrets rule.

---

## 7. The run report

### What is available per lesson at the end — all of it, without new state

| field | source |
|---|---|
| generated (content / quiz / images) | the executor's `done` counters, keyed by unit → segment → lesson |
| skipped + reason | the planner, if it *records* the reason rather than only counting: `approved`, `approved_image`, `published`, `archived`, `already_present`, `resume_skip`, `no_content` |
| failed + error | `result.errors[]` — already per unit with the message (`generateTrackContent.ts:223`) |
| image counts | `content_images` where `job_id = <parent job.id>` (`generateTrackImages.ts:95`) |
| tokens | `ai_generation_log` where `correlation_id = <parent job.id>`, summing `response->'usage'` — **except image generation, which records none** |
| latency per unit | `ai_generation_log.latency_ms`, same correlation id |
| review findings | `content_findings` rows from the optional §2k phase |

The one gap: today's `skipped_approved` is a **bare integer** (`generateTrackContent.ts:122`), so the
report can say "3 skipped" but not *which* or *why*. Turning the counter into a
`skipped: [{ ref, lesson_id, reason }]` list is the single change the report needs, and it costs
nothing — the planner already knows the reason at the moment it decides.

### Proposed `jobs.result`

```ts
{
  status: 'running' | 'succeeded' | 'completed_with_errors',
  track_id, track_name,
  mode: 'fill_missing' | 'replace',
  phase: 'content' | 'images' | 'review' | 'done',
  phases: {
    content: { total, done, failed, skipped: Skip[], current_unit },
    images:  { total, done, failed, skipped: Skip[], current_unit, estimated_before_content },
    review:  { total, done, failed, findings } | null,
  },
  lessons: [{                         // the report panel renders this directly
    lesson_id, lesson_name, is_published, archived: boolean,
    content: 'generated' | 'skipped' | 'failed' | 'not_planned',
    quiz:    'generated' | 'skipped' | 'failed' | 'not_planned',
    images:  { planned, generated, failed, pre_existing },
    skipped_reason: string | null,
    errors: [{ unit, message }],
    findings: number | null,          // §2k, when the review phase ran
  }],
  totals: { content_units, quiz_units, image_slots, ai_calls, tokens_in, tokens_out, images_priced },
  started_at, finished_at,
}
// Skip = { ref, lesson_id, reason: 'approved' | 'approved_image' | 'published' | 'archived'
//                                 | 'already_present' | 'resume_skip' | 'no_content' }
```

`jobs.status` stays `succeeded`/`failed` per the CHECK constraint; `completed_with_errors` lives in
`result.status`, exactly as §2f/§2g already do.

**CSV** falls straight out of `result.lessons` — one row per lesson, columns in that order, which is
why the shape is a list of flat per-lesson objects rather than a map. No separate export path needed:
the CMS can serialise what it already polls.

---

## 8. Measured plan — what a fill-missing build-out would do today

Read-only on Moosii, 2026-11-22, replicating both planners' predicates in SQL.

**First, the headline: 24 of the 30 `live` tracks have NO lessons at all.** A build-out on them plans
nothing and generates nothing — they need `generate_lessons` (§2a) first. Only 6 carry lessons:

| track | lessons | published | segs | approved | content plan | quiz plan | slots | image plan | skipped_no_content |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Adoption | 7 | 0 | 7 | 0 | **7** | 7 | 0 | **0** | 0 |
| Feeding: Bottle Feeding | 6 | 0 | 6 | 1 | **2** | 2 | 34 | **26** | 0 |
| Postpartum Depression | 6 | 0 | 6 | 0 | **4** | 4 | 16 | **0** | 0 |
| Stay-At-Home Parent Support | 6 | 0 | 6 | 0 | **6** | 6 | 0 | **0** | 0 |
| Twins and Multiples | 6 | 0 | 6 | 0 | **6** | 6 | 0 | **0** | 0 |
| Military | 1 | 0 | 1 | 0 | **0** | 0 | 8 | **8** | 0 |

Every lesson in these tracks has exactly **1 segment**, and **none is published** — so the §3
published-lesson hazard does not bite the live catalog today.

### The three sample tracks, end to end

**1. `Adoption` — greenfield, the case that proves images must be re-planned**

7 lessons, 7 empty segments, **0 sub_segments**. `planTrackImages` returns **0** right now; after the
content phase it will find ~7 × 7.5 ≈ **53 slots**.

| phase | units | est. time | est. tokens |
|---|---:|---:|---:|
| content | 7 | 24–34 s | ~7.8 k |
| quiz (`quizzes=true`) | 7 | 24–34 s | ~8.7 k |
| images | ~53 | **~6.8 min** | ~101 k + 53 priced images |
| **total** | **~67** | **~8 min** | **~117 k tokens + 53 images** |

**2. `Feeding: Bottle Feeding` — partially built, and the one with an approved segment**

Content plan 2 of 6 segments, quiz plan 2, 34 existing slots of which **26 have no image**. Per
lesson: `Cleaning and Sterilizing` 8 cards / 8 images (complete); `Mastering Paced` and `Recognizing
Hunger` 9 cards / 0 images; `Choosing the Right Formula` 8 cards / 0 images and **`seg_status`
approved** — a `replace` would skip it (`skipped_approved`), `fill_missing` leaves it alone anyway;
`Formula Preparation` and `Relaxing and Bonding` have no content at all.

After content, ~2 × 7.5 ≈ 15 new slots → **~41 images ≈ 5.3 min**; content+quiz ~15–20 s. **Total
~5.5 min.** Its cards are the only ones in the live group carrying a tone — "Calm clinician", on 17
of 34 cards (§5).

**3. `Military` — pure image gap**

1 lesson, content complete, 8 slots, **8 images to fill, nothing else planned**. **~62 s.** The
cheapest possible proof that the chain works end to end.

### Recommended first live exercise

**`Military` → `Adoption`.** `Military` is a single-phase, ~1-minute run that exercises the image
path and the report with 8 units. `Adoption` is the real test: greenfield, 7 lessons, and the only
one of the three that forces the re-plan-after-content behaviour to be correct. Both have zero
published lessons and zero approved images, so neither can trip §3 or §4.

---

## Decisions for Mark

1. **Reverse §2g's "not chained" decision?** (§1) The contract states it deliberately: images fire
   on a human decision, not automatically. Chaining spends image money on content nobody has
   reviewed — ~53 images for Adoption. Yes/no, and if yes the contract line changes with it.
   → **DECIDED NO (Mark, 2026-11-24):** two separate batches — content, then images. No chained
   `build_track` job; §2g's decision stands and the contract line is unchanged.
2. **Approved images: exclude, gate, or accept?** (§4) 17 approved images on 5 segments are
   destroyable today by a `replace`. Recommend excluding those segments from the build-out.
3. **Published lessons: confirm exclusion + `include_approved` refusal.** (§3) Recommend both. Also
   whether archived lessons are excluded (3 rows, `mem` only).
4. **Tone:** default to the global `prompts."default"` now, or add `tracks.default_tone_id` in this
   slice? (§5) Recommend the default now, the column when the CMS screen exists.
5. **Where do model prices live** for the cost estimate — `app_settings` row, or hard-coded in the
   preview? (§6)
6. **Per-unit deadline?** (§2) There is no timeout anywhere; one image unit measured 1244 s. A
   deadline would cap a build-out's worst case but adds a failure mode that does not exist today.
7. **Periodic reaper?** (§2) Out of this slice's scope, but the sub-10-minute orphan leaves a row
   `running` forever and a parent job makes that visible in the CMS.
8. **Does the review phase belong in the parent at all?** §2k is read-only and cheap (8.2 s/lesson,
   1.5–2.4 k tokens), but `doc_grounded` averages 17.3 s and needs linked source documents. Content
   + images first, review as a later flag, is the smaller first slice.

---

## Appendix — files read

| what | where |
|---|---|
| content orchestrator, planner, resume cutoff | `src/jobs/handlers/generateTrackContent.ts:51`, `:105-109`, `:118-137`, `:146-160`, `:197-234` |
| image orchestrator + planner | `src/jobs/handlers/generateTrackImages.ts:46-89`, `:101-137` |
| the card write path + image purge | `src/jobs/handlers/generateSegmentContent.ts:310-336`; `src/storage/purgeImages.ts:11-30` |
| the published-lesson block that §2f lacks | `src/jobs/handlers/regenSegmentContent.ts:86-89` |
| job runner, reaper, boot call | `src/jobs/runner.ts:31-37`, `:107-140`, `:142-162`; `src/index.ts:128-131` |
| retry policy (no timeout) | `src/lib/retry.ts:85-105` |
| handler registry | `src/jobs/registry.ts:30-45` |
| contract: §2f / §2g / §2k | `docs/api-contract.md:1710-1808`, `:1478-1500` |
| contract: no published guard, per-card tone | `docs/api-contract.md:540-542`, `:548-555` |
| per-domain published-edit policy | `migrations/064_domain_setting_and_edit_guard.sql` (header) |
