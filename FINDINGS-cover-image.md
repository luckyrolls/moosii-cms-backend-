# FINDINGS — cover-image policy per domain (2026-09-21)

Investigation only. No code, no migrations. Moosii was probed in **rolled-back transactions only**
(candidate-image count identical before and after); the CMS and app repos were read, not edited.

Decision being implemented later (Mark, made): `imagePolicy: 'per_card' | 'cover'`, per domain.
Moosii = `per_card` (unchanged). Financial = `cover`: one image per lesson, generated from the
lesson's title and description, stored so it renders on the lesson's first card, never purged by a
card-text regen, regenerated only by an explicit action; batch and track generation make one image
per lesson.

---

## 0. First: a live bug on Moosii that decides the approval question

**Approving a lesson whose cards have new images reports success but leaves the lesson
unapproved.** Proven on live Moosii, rolled back:

| Probe (rolled back) | Result |
|---|---|
| A clinically approved card; `approve_content_image` on one of its candidate images | card `review_state` → **`draft`** |
| `approve_segment_bundle` on a 7-card segment, all cards editorial-reviewed, 7 linkable candidates | returned `"seg_status": "complete"`; afterwards **all 7 cards `draft`, segment `pending`** |

Cause: `approve_segment_bundle` promotes the cards (`set_card_review_state`, and computes the status
it returns), THEN calls `approve_content_image` per image. That function's step 3 writes
`UPDATE sub_segments SET image = …, image_path = …` — and migration 066's trigger
`sub_segments_reset_review_trg AFTER … UPDATE OF title, content, image, sequence` resets any card
whose `image` column is written, with no check on the value or the writer. Live since 066
(2026-09-11). The POST response and the approval log both say "approved"; the database says draft.
This is the likely cause of the repeated approval of "Getting enough sleep" noted in
FINDINGS-unarchive-approvals.md.

Evidence: `approve_segment_bundle` (live def: cards first, then the image loop);
`approve_content_image(uuid,uuid,text,text)` step 3; `migrations/066_content_edit_review_reset.sql:111-114`;
`src/routes/lessons.ts:94-146` (the route that calls the bundle).

**Recommended fix (separate slice, both projects, before any cover work):** take `image` out of the
066 trigger's column list. Every path that legitimately changes a card's picture already resets
review explicitly in code (`generateSubSegmentImage.ts:292-296` on a new candidate,
`subSegments.ts:272-274` on upload), and no CMS-direct path writes `image` (066's own header lists
reorder, add-card and quiz edit as the direct paths). Writing the approved image's URL is the
approval itself and must not undo it. Alternative if Mark prefers to keep the column: reorder the
bundle so images are approved before cards — but the standalone `POST /images/:id/approve` would
still reset its card. Needs its own before/after proof on Moosii.

The cover work depends on this: the cover's pointer lives in card 1's `image`, so every cover
approval and every re-point would reset card 1.

---

## 1. Path inventory

`owner` = which `content_images` column holds the image. Under `cover` the cover is a
**lesson-owned** row (`content_images.lesson_id`), which the schema already supports: the
one-owner CHECK, the `lesson_id` FK (ON DELETE CASCADE) and a unique index
`content_images_one_approved_per_lesson` all exist; there are 0 lesson-owned rows on Moosii today.
The app keeps reading card 1's `sub_segments.image`, which becomes a pointer to the approved cover.

| # | Path | Where | Today (Moosii, stays byte-identical) | Under `cover` |
|---|---|---|---|---|
| 1 | Per-card generate | `POST /sub-segments/:id/generate-image` → `generate_sub_segment_image` (`subSegments.ts:21-32`; handler `generateSubSegmentImage.ts:124-306`) | card-owned candidate; prompt from card title+content; new candidate resets the card to draft | Not offered. The route answers 409 `cover_policy` (the CMS hides it). The cover has its own job (below). |
| 2 | Segment batch | `POST /segments/:id/generate-images` (`segments.ts:35-98`), modes all / unapproved / gaps | one job per card | At most ONE job: the lesson's cover, same mode semantics at lesson level (gaps = no candidate/approved cover; unapproved = no approved cover). |
| 3 | Track batch | `generate_track_images` (`generateTrackImages.ts:46-96`, `planTrackImages`) | plan unit = card without a candidate/approved image, in a segment with content | Plan unit = LESSON without a candidate/approved cover, whose segment has content. `planTrackImages` gains a lesson-level branch; the orchestration (concurrency, progress, resume) is unchanged. |
| 4 | New cover job | — | — | `generate_lesson_cover { lesson_id, scene? }`: lesson-owned candidate; metadata = track + lesson title + description (no card text). Same prompt-writer → image model → upload → provenance as today. A new candidate never touches any card or its review state. |
| 5 | Content generate / whole-segment regen | `generateSegmentContent.ts:352-357`; `regenSegmentContent.ts:192-200` — purge card images, DELETE all cards, INSERT new | card images purged with the cards | The cover is lesson-owned, so `purgeImagesForSubSegments` (filters `sub_segment_id`) never touches it. But card 1 is deleted and re-inserted, so the NEW card 1 has no pointer → re-point it to the approved cover after the insert. |
| 6 | Single-card regen | `regenSegmentContent.ts:251` — `purgeImagesForSubSegments([card_id])`, then UPDATE title/content | purges that card's images AND clears its pointer | Must NOT clear card 1's pointer. Purge only card-owned rows (none exist under `cover`) and skip the pointer clear when it points at the lesson cover. The in-place UPDATE sets only title/content/tone, so the pointer and the cover's approval both survive. |
| 7 | Card delete | `DELETE /sub-segments/:id` (`subSegments.ts:135-181`): purge, delete, renumber, re-gate | purges that card's images | Deleting card 1 renumbers another card to 1 → re-point the new card 1 to the cover. |
| 8 | Reorder / add card (CMS-direct) | moosii-cms `src/data/cards.ts:218-260` (`renumberContiguous`, two-phase sequence rewrite); add-card insert (066 row 11) | no image effect | A different card can become card 1 WITHOUT the backend. The pointer must follow position 1 inside the database: a trigger on `sub_segments` (sequence change / insert / delete) that, under `cover`, moves the cover pointer to the card at sequence 1 and clears it elsewhere. Needs the policy visible to the DB — see §4. |
| 9 | Ordered purge | `purgeImagesForSubSegments` (`purgeImages.ts:24-61`): clear pointer → content_images → storage file → image_assets | unchanged | New sibling `purgeLessonCover(lessonId)` with the SAME order: clear the pointer on whichever card holds the cover URL → delete the lesson-owned rows → remove files → image_assets safety net. |
| 10 | Lesson delete | `DELETE /lessons/:id` (`lessons.ts:355-385`); `planLessonDelete` counts lesson-/segment-owned images (`contentTeardown.ts`) and REFUSES 409 `unpurgeable_images` if any exist | never triggers (0 such rows) | Would refuse every financial lesson with a cover → call `purgeLessonCover` before the delete instead of refusing. |
| 11 | Upload | `POST /sub-segments/:id/upload-image` (`subSegments.ts:191-290`) | card-owned candidate, resets the card | Lesson-level variant (`POST /lessons/:id/upload-cover`): lesson-owned candidate, no card reset. |
| 12 | Approve one image | `POST /content-images/:id/approve` (`images.ts:9-50`) → `approve_content_image` | supersede → approve → write the pointer on the OWNING card | For a lesson-owned row `v_sub_segment_id` is NULL, so step 3 updates nothing and **no pointer is written**. Needs a cover branch: write the pointer onto the card at sequence 1 of the lesson's segment. |
| 13 | Approve whole lesson | `POST /lessons/:id/approve` (`lessons.ts:67-147`) → `approve_segment_bundle(p_images)` | latest candidate per card, pre-checked against `image_assets` | Include the lesson's latest cover candidate instead (same image_assets pre-check). |
| 14 | Reject | `POST /content-images/:id/reject` (`images.ts:53-87`) | status only | Unchanged (works on any owner). |
| 15 | Unapprove lesson | `unapprove_segment_bundle` (`lessons.ts:175-190`) | approved images → candidate, pointer cleared | Must also revert the lesson-owned cover and clear card 1's pointer. |

Not affected: image style prompts (out of scope); `sub_segments.image → image_assets.url ON DELETE
RESTRICT` (the cover pointer is an ordinary image URL); the app (`moosii-rn useLesson.ts:61` reads
`card.image` per card; card 1 carries the cover).

One code gap the cover job exposes (not a style-prompt change): `buildUserPrompt`
(`src/prompts/assemble.ts:90-99`) always sends a Sub-segment and Content line, and the financial
base says the card's Section and Content are the brief (`prompts/image/financial/base.md:20,129`). A cover passes lesson title + description instead; the
assembler needs a lesson-level user-prompt variant that says so.

---

## 2. Proof that Moosii stays byte-identical

Same discipline as the domain-scoped image prompts (capture before, change, compare):

1. **One gate.** Every branch in §1 goes through one pure function, `imagePolicy(DOMAIN)`, and the
   `per_card` branch is the existing code path unchanged — not a rewritten equivalent. Unit tests
   pin `imagePolicy('moosii') === 'per_card'` and `imagePolicy('financial') === 'cover'`.
2. **Planner capture (live, read-only).** Before the change, run `planTrackImages` for every Moosii
   track and the segment-batch selection (`all` / `unapproved` / `gaps`) for every segment; save the
   JSON. After, re-run with `DOMAIN=moosii` and require a byte-identical file (both are pure reads).
3. **Path capture (local restore).** On a local restore of Moosii's schema (PG 17,
   `PGCLIENTENCODING=UTF8`) with a fixture lesson (cards, candidate + approved images, quiz), run
   each mutating path — per-card generate (stubbed LLM/image calls), single-card regen, whole-segment
   regen, card delete, image approve, lesson approve, unapprove, lesson delete — with storage calls
   recorded instead of executed. Snapshot `content_images`, `sub_segments` (image, image_path,
   review_state, sequence) and the recorded storage calls. Before vs after must be identical.
4. **Database objects.** Any new trigger or function is gated on the DB-side policy (§4) exactly as
   064's guard is gated on `app_settings.domain`: on Moosii it returns on its first line. Prove with
   the md5 of each touched function before and after on Moosii, plus a rolled-back probe (reorder a
   published Moosii segment → `sub_segments.image` unchanged).
5. **The §0 fix is proven separately**, since it deliberately changes Moosii behaviour.

---

## 3. Approval: does the cover survive a card-1 text regen?

**Yes — once §0 is fixed.**

- The cover's approval lives on the lesson-owned `content_images` row (`status = 'approved'`), not
  on card 1. A card-text regen (paths 5 and 6) only touches card-owned rows and card columns, so
  the cover row keeps `approved`.
- Card 1's own `review_state` still resets on a text regen — correctly, since its words changed.
- The pointer: path 6 today clears it (purge step 1). Under `cover` it must be skipped for the
  cover URL; path 5 re-points the new card 1.
- **The catch is §0.** Writing the pointer (approval, re-point after regen or delete, the reorder
  trigger) is an `UPDATE OF image`, and 066 resets card 1 to draft on it. Without the §0 fix, every
  cover approval or re-point would un-review card 1 and block the lesson's clinical gate.

**Approve-whole-lesson route:** yes, it needs to know — path 13 collects card candidates today and
must collect the lesson's cover candidate under `cover`, with the same image_assets pre-check.

**Published-edit guard (064):** on financial (the `block` domain) the guard refuses every write to
`sub_segments` of a published lesson — including the pointer update. So "new cover" on a published
lesson is refused with `published_content_locked` until it's unpublished, like every other content
edit there. That matches "a cover is content"; if Mark wants covers replaceable while published, the
guard needs an explicit exemption for pointer maintenance. **Decision for Mark.**

---

## 4. Where the setting lives

- **Backend:** a new `src/lib/domainConfig.ts` keyed by `DOMAIN`, holding both per-domain
  behaviours: `{ moosii: { ageAxis: true, imagePolicy: 'per_card' }, financial: { ageAxis: false,
  imagePolicy: 'cover' } }`. `domainHasAgeAxis` (`src/lib/ageAxis.ts`) folds into it, so adding a
  domain is one entry. A domain missing from the map fails the build (typed `Record<Domain, …>`).
- **CMS:** `imagePolicy` on `DomainConfig` (`moosii-cms/src/domains/types.ts`), set in `moosii.ts` /
  `financial.ts`. The bootstrap already fetches `/version` for the domain
  (`src/domains/useDomainBootstrap.ts:26-32`); add `image_policy` to `/version` and have the
  bootstrap refuse to render on a mismatch, as it already does for the domain.
- **Database:** the pointer-follow trigger (path 8) runs where the backend isn't — CMS-direct
  reorders — so the DB must know the policy too. Recommended: an `app_settings` row
  `('image_policy', 'cover')`, cross-checked at boot exactly like `app_settings.domain` (mismatch →
  exit). **Decision for Mark**: the brief placed the setting in backend config + CMS registry; the
  DB copy is the price of CMS-direct reorders.

---

## 5. CMS surface — flag for the moosii-cms seat (no UI design here)

- Lesson level: "Generate cover" (no approved cover yet) / "New cover" (replace), upload cover,
  approve / reject the candidate, and show the current cover on the lesson.
- Hide the per-card image controls under `cover`: `CardImageSection.tsx` (generate / upload /
  approve per card) and the "generate images" batch in `CardsTab.tsx:810`.
- `GenerateTrackImagesModal.tsx` + `src/data/trackImages.ts` (client-side plan preview) must mirror
  the lesson-level plan (one unit per lesson).
- `isPublishedContentLocked` messaging applies to "new cover" on a published financial lesson.
- Card 1 in the card list will show the cover as its image; the editor should read it as the
  lesson's cover, not a card image (label only).

---

## 6. Proposed build order, by repo

1. **Backend + DB, both projects (P1, independent of covers):** the §0 fix — drop `image` from the
   066 trigger (or reorder the bundle, if Mark prefers). Before/after proof on Moosii with rolled-back
   probes. Financial first, then Moosii.
2. **Backend:** `domainConfig.ts` (fold `ageAxis`), `/version` → `image_policy`; migration: the
   `app_settings.image_policy` row + boot cross-check. Capture Moosii planner output first (§2.2).
3. **Backend + DB (financial-gated):** cover-aware approval (path 12), `purgeLessonCover` (9),
   lesson delete (10), unapprove (15), the pointer-follow trigger (8). Local-restore proof (§2.3–2.4).
4. **Backend:** `generate_lesson_cover` + lesson-level user prompt; gate paths 1, 2, 3, 5, 6, 7, 11,
   13 on the policy. Contract §1/§2 updated.
5. **CMS (moosii-cms seat):** `imagePolicy` in the registry + bootstrap check; lesson cover
   controls; hide per-card controls; track-images plan preview.
6. **App / web reader:** nothing — verify card 1 renders the cover on a financial lesson.

**Decisions needed from Mark:** the §0 fix shape (drop the column vs reorder the bundle); whether a
cover may be replaced on a published financial lesson (guard exemption or not); the DB copy of the
policy (§4).
