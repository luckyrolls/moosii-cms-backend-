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

## 9. A new candidate image sends an approved card back to DRAFT

**Added 2026-11-24** on a separate INVESTIGATE-ONLY brief, after the CMS walk-through: when an image
job lands a new candidate, an approved card drops to `draft` and its lesson to `pending`. It belongs
in this document because §4 and §2g already turn on what a new image costs. Read-only; a fuller
standalone write-up of the same investigation is in `docs/FINDINGS-image-candidate-reset.md`.

### 9.1 The exact path — it is **not** a trigger

It is explicit application code, in two places, and both pass `'draft'`:

| # | Call site | When |
|---|---|---|
| 1 | [generateSubSegmentImage.ts:297](../src/jobs/handlers/generateSubSegmentImage.ts:297) — `await resetCardsToDraft(subSeg.seg_id!, [sub_segment_id])` | the `generate_sub_segment_image` job, step 8, on the **non-`auto_approve`** branch. Comment: *"A new candidate image means THIS card is no longer fully reviewed → reset it to 'draft'"* |
| 2 | [subSegments.ts:297](../src/routes/subSegments.ts:297) — `await resetCardsAndReport(segId!, [subSegmentId])` | `POST /sub-segments/:id/upload-image`, step 9, after the candidate row is inserted |

Both reach [cardReview.ts:47-48](../src/lib/cardReview.ts:47) →
`set_card_review_state(p_seg_id, [card], 'draft', NULL, NULL)` (**migration 056**). `p_from_state` is
`NULL`, which the RPC reads as "any current state", so there is no floor: a `clinically_approved`
card goes straight to `draft`.

**What it resets, precisely:**

| | before | after |
|---|---|---|
| editorial approval | held | **lost** |
| clinical approval | held | **lost** |
| `segments.seg_status` | `complete` | **`pending`** — `recompute_seg_status` runs inside the same RPC (056) and requires ≥1 card AND *every* card `clinically_approved` |
| `segments.approved_by` | set | **NULLed** by `recompute_seg_status` when the result is `pending` |
| `lessons_review_status.content_state` (065) | `published_reviewed` | `published_unreviewed` — and the lesson becomes **un-openable in the app** (065 §B.4: moosii-rn `useLesson.ts` selects `.eq('seg_status','complete')` and throws when nothing matches) |

**Why it looks like a trigger but is not.** `sub_segments.image` *used* to be in the 066 trigger's
column list, and that was the **092** bug — approving an image un-approved the card it had just
approved. 092 removed it; the live trigger is `AFTER INSERT OR DELETE OR UPDATE OF title, content,
sequence` (confirmed on both projects). 092 deliberately **kept** the code reset for the candidate
paths: *"A NEW image (generate / upload) never touches `image` — it inserts a `content_images`
candidate and resets the card explicitly in code … The card is re-reviewed when the candidate
appears, not when the reviewer approves it."* So the behaviour is intended; how far it resets was
never revisited.

**The inconsistency.** Migration **093** (Mark, 2026-09-21) settled the neighbouring case — an
*approved* image swapped onto a `clinically_approved` card — and chose the lighter penalty:

| event | penalty today | where |
|---|---|---|
| a **candidate** arrives (generate / upload) | `clinically_approved` → **`draft`** (both stages) | code, §9.1 |
| an **approved** image replaces a different approved one | `clinically_approved` → **`editorial_reviewed`** (clinical only) | `sub_segments_image_swap_review` trigger, 093 |

The merely-proposed picture costs more review than the one that actually goes live.

**Live cost (Moosii, read-only 2026-11-24):** **7** cards are `draft` while holding *both* an approved
image and a newer candidate — i.e. they had a finished picture, a regenerate dropped a candidate
beside it, and the card lost its whole review. 244 more are `draft` with a candidate and no approved
image (same mechanism, nothing lost, but indistinguishable in the queue). **No `clinically_approved`
card anywhere holds a candidate** — necessarily, because a candidate resets it. 23 of the 50 pending
segments have the property that every draft card in them holds a candidate.

### 9.2 Proposal, as specified

Three parts, matching the brief.

**(a) A new candidate keeps the card's TEXT (editorial) approval.** Change both call sites from
`'draft'` to a **demotion floored at `editorial_reviewed`**: a `clinically_approved` card →
`editorial_reviewed`; a card already `editorial_reviewed` or `draft` → unchanged. `set_card_review_state`
already takes `p_from_state`, so this is `set_card_review_state(seg, [card], 'editorial_reviewed',
'clinically_approved', NULL)` — the existing RPC, no migration needed for this part, and the
`IS DISTINCT FROM` / `p_from_state` guard makes it a no-op on an unapproved card.

This is exactly 093's rule, applied to the candidate event. Two bonuses: it makes all three image
paths agree (`auto_approve` already skips the reset and ends `editorial_reviewed` via 093), and it
stops a regenerate from costing an editor a second pass over text they never changed.

**(b) Image approve = editorial capability — already true, nothing to change.**
[images.ts:17](../src/routes/images.ts:17) is `if (!hasCapability(req.user, "editorial"))`, documented
at `api-contract.md:200`: *"cap: EDITORIAL. A picture is an editorial choice; the clinical consequence
is handled by the database."* Confirmed, no work.

**(c) Clinical on image approve stays as today — 093 untouched.** Approving a different picture on a
`clinically_approved` card keeps dropping it to `editorial_reviewed`
(`sub_segments_image_swap_review`, `AFTER UPDATE OF image … WHEN OLD.review_state =
'clinically_approved'`). Nothing in (a) interferes: by the time the image is approved the card is
already `editorial_reviewed`, so 093's `WHEN` clause is false and the trigger simply does not fire.

### 9.3 ⚠ What (a) alone does **not** give you

> *"the lesson is not complete again until the image is approved"*

**Demotion alone does not enforce that.** It makes the lesson *not complete until the card is
clinically re-approved* — which is a different condition, and strictly weaker in one direction and
stronger in another:

* **Weaker:** `POST /segments/:id/clinical-approve` gates only on *card* state —
  `countDraftInScope` ([segments.ts:178-187](../src/routes/segments.ts:178)) refuses with
  `409 editorial_review_required` when a card is `draft`, and a card at `editorial_reviewed` passes
  cleanly. So a clinician can promote the card and return the segment to `complete` **with the
  candidate still unapproved** and the card's live picture still the old one. Today's `draft` reset
  accidentally blocks that, because `draft` trips the 409.
* **Stronger:** approving the image is not *sufficient* either — 093 then demotes, so a clinical
  sign-off is still required. That is part (c), as intended.

To make the requirement structural, `complete` has to know about the image. The minimal form:
extend **`recompute_seg_status`** so a segment is `complete` only when ≥1 card AND every card
`clinically_approved` **AND** no card holds an *unadjudicated candidate* — a `content_images` row
with `status='candidate'` created after that card's current approved image was approved (any
candidate if the card has none). `rejected`/`superseded` never count, so
`POST /content-images/:id/reject` ([images.ts:80](../src/routes/images.ts:80), writes
`status='rejected'`) is the escape hatch and already exists. It needs one companion trigger on
`content_images` — `AFTER INSERT OR DELETE OR UPDATE OF status`, whose **only** action is
`PERFORM recompute_seg_status(<owning segment>)`, never a card-state write — so the gate closes when
a candidate lands and re-opens when it is approved or rejected, whoever did it. `content_images`
carries no trigger on either project today, so that part is additive.

**Measured impact of the gate change:** **7** currently-`complete` segments hold an unadjudicated
candidate and would go `pending`. All 7 also have unapproved cards (no `clinically_approved` card
anywhere holds a candidate), so all 7 are already inside the 25 stale-`complete` segments that
`docs/FINDINGS-complete-with-draft-cards.md` recommends re-deriving. **Effect on correctly-complete
segments: 0.** **0** segments move the other way. On financial: 0 either way.

⚠ Only **1** `rejected` row exists on Moosii against 269 candidates, so the CMS needs a visible
reject action before the gate ships or editors will be stuck behind candidates nobody adjudicated.
CMS-seat follow-up.

### 9.4 Classification

| part | class | why |
|---|---|---|
| (a) demotion floored at `editorial_reviewed` | **code only, no migration** | two call sites, uses `set_card_review_state`'s existing `p_from_state`. It cannot make anything more approved than today — it only stops a demotion going too far |
| (b) editorial capability on image approve | **no change** | already the case |
| (c) 093 behaviour | **no change** | explicitly preserved |
| (d) the `recompute_seg_status` gate + `content_images` trigger | **REVIEW REQUIRED** | replaces **the single writer of `seg_status`** — the only function on either project whose body writes it. md5 guard per CLAUDE.md: live value `660ed036da2cf30d2886244d850e7dab` (`md5(replace(pg_get_functiondef(oid), chr(13), ''))`), **identical on both projects**; re-grant EXECUTE per 094 after the replace. It also **tightens an app-facing gate** — 056 promised *"seg_status keeps its EXACT shape/meaning"*, and the app plus three RLS SELECT policies key on `complete`, so a segment going `pending` makes the lesson un-openable. That is the intent for an unreviewed picture, but it is a visible catalog change |

**Sequencing:** (a) can ship alone, immediately, as a strict improvement. (d) should land **with or
after** the stale-`complete` repair, or the 7 overlapping segments get re-derived twice for two
reasons and neither verification is separable.

### 9.5 What else depends on the current behaviour

| depends on "a new candidate resets the card to `draft`" | effect of the change |
|---|---|
| **092's safety argument** ([092 header](../migrations/092_card_reset_ignores_image_pointer.sql:19), *"WHY THIS LOSES NO RESET"*) rests on the code reset existing for the generate/upload paths — it is the reason dropping `image` from 066's column list was safe | still holds: (a) keeps a reset, just floored at `editorial_reviewed`. The header's wording needs updating, not its logic |
| **`countDraftInScope`'s 409** ([segments.ts:178](../src/routes/segments.ts:178), `api-contract.md:275`) today blocks a clinical approve after an image generate, because the card is `draft` | **changes behaviour**: the card is `editorial_reviewed`, so clinical-approve now succeeds. This is the §9.3 hole — intended under (a)+(d), a regression under (a) alone |
| **`approve_segment_bundle`'s 093 ordering** (093 §2: remember the `editorial_reviewed` cards, approve images, then promote only those) | **improves**: cards demoted by a candidate are now in the remembered set, so one whole-lesson approve finishes them. Under today's `draft` they are excluded from promotion and the bundle silently leaves them behind |
| **`POST /lessons/:id/approve`'s image pre-check** ([lessons.ts:120-140](../src/routes/lessons.ts:120)) collects the latest linkable candidate per card and 409s `image_not_linkable` | unaffected — keys on `content_images` + `image_assets`, never on `review_state` |
| **Batch image planning**: `POST /segments/:id/generate-images` modes `unapproved` / `gaps` ([segments.ts:56-70](../src/routes/segments.ts:56)) and `planTrackImages` ([generateTrackImages.ts:72-78](../src/jobs/handlers/generateTrackImages.ts:72)) | unaffected — both key on `content_images.status IN ('candidate','approved')`, never on `review_state` |
| **`POST /sub-segments/:id/upload-image` returns `approval_reset`** ([subSegments.ts:312](../src/routes/subSegments.ts:312)) — the boolean, though not the `approval_reset_detail` breakdown | **the value changes meaning**: it will report a demotion, not a full reset. Still `true` when the card was clinically approved; now `false` where the card was already `editorial_reviewed`. (Correcting my own earlier report: this route *does* return the boolean — only the detail object is deliberately absent) |
| **`api-contract.md:203-211`** documents the current split in so many words, including *"The card was already reset to draft when the candidate was generated/uploaded (migration 092)"* | must be rewritten with the change |
| **`FINDINGS-cover-image.md`** path table (rows 1 and 11) states *"new candidate resets the card to draft"* as the behaviour the cover slice mirrors | the cover slice's design inherits this; its lesson-level variant was already specified as *"never touches any card or its review state"*, which (a) brings the card-level path closer to |
| **Tests** | **none.** No test in `package.json`'s list covers the image-reset behaviour, so (a) ships with no red suite and no safety net — it needs a new unit test, and the `test` script updated (CLAUDE.md) |
| **`docs/FINDINGS-reset-audit.md`** | none of these resets writes an audit row today, so the change is invisible in `content_approvals` either way |
| **§4 of this document** (approved images the content phase destroys) | unchanged — §4 is about `purgeImagesForSubSegments` deleting approved rows on a content replace, a different path |

### 9.6 Decisions (image reset) — separate from the eight above

| # | Decision | Recommendation |
|---|---|---|
| **I1** | (a) alone, or (a) + (d)? | **Both.** (a) alone leaves the §9.3 hole *and* removes the accidental block that `draft` currently provides, so shipping it by itself makes "complete without an approved image" easier than it is today. |
| **I2** | Floor at `editorial_reviewed` (as briefed), or no state change at all plus (d)? | **As briefed** — it is the smaller change, it needs no migration for part (a), and it matches 093. Noting the trade-off once: a demotion still spends the clinical sign-off on a picture that may be rejected seconds later, whereas "no state change + (d)" would make rejecting an unwanted generation cost nothing. Your call; the briefed version is what §9.2 specifies. |
| **I3** | Ship (d) before, with, or after the stale-`complete` repair? | **With or after** (7 segments overlap). |
| **I4** | CMS reject action before (d) ships? | **Yes** — 1 `rejected` row against 269 candidates says the action is not being used today. |

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
