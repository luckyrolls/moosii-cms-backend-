# FINDINGS — generating an image sends an approved card back to draft

**Brief:** investigate read-only (Mark, 2026-11-24, from the CMS walk-through). Report the exact
behaviour, then propose: a new candidate image keeps the card's text approval, and the lesson needs
the image approved before it is complete again. No code, no migrations, no commits.
All live readings: `BEGIN TRANSACTION READ ONLY; … ROLLBACK;` on both projects, 2026-11-24
(Moosii sysid `7481590244898220655`, PG 15.8; financial sysid `7678069749886157684`, PG 17.6).

---

## 1. The behaviour — and it is **not** a trigger

**It is explicit application code, in two places.** Both pass `'draft'`, so a
`clinically_approved` card loses **both** stages of review — editorial as well as clinical — the
moment a candidate image appears.

| # | Call site | When |
|---|---|---|
| 1 | [generateSubSegmentImage.ts:297](../src/jobs/handlers/generateSubSegmentImage.ts:297) — `await resetCardsToDraft(subSeg.seg_id!, [sub_segment_id])` | `generate_sub_segment_image` job, on the **non-`auto_approve`** branch (step 8). The comment states the intent: *"A new candidate image means THIS card is no longer fully reviewed → reset it to 'draft'"* |
| 2 | [subSegments.ts:297](../src/routes/subSegments.ts:297) — `await resetCardsAndReport(segId!, [subSegmentId])` | `POST /sub-segments/:id/upload-image`, step 9, after the candidate row is inserted |

Both reach `resetCardsToDraft` → `setCardsReviewState(segId, [cardId], "draft", null, null)`
([cardReview.ts:47-48](../src/lib/cardReview.ts:47)) → the `set_card_review_state` RPC (056), which
writes `review_state = 'draft'` with **no `from_state` guard** (`p_from_state` is `null`, i.e. "any
current state") and then calls `recompute_seg_status`. So:

* a `clinically_approved` card → `draft`;
* the segment recomputes to `pending` (056's rule: complete iff ≥1 card **and every** card
  `clinically_approved`);
* the lesson reads `published_unreviewed` in `lessons_review_status` (065) and, if published, becomes
  un-openable in the app (065's own header: moosii-rn `useLesson.ts` requires `seg_status='complete'`
  and throws otherwise).

### Why no trigger does this (and why it reads like one)

`sub_segments.image` **used to** be in the 066 trigger's column list, and that *was* the 092 bug —
approving an image un-approved the card it had just approved. Migration 092 removed `image` from the
list, and the live trigger is now `AFTER INSERT OR DELETE OR UPDATE OF title, content, sequence`
(confirmed on both projects). 092's header is explicit that the reset was **deliberately kept in
code** for the candidate paths:

> *"A NEW image (generate / upload) never touches `image` — it inserts a `content_images` candidate
> and resets the card explicitly in code (generateSubSegmentImage.ts:292-296, subSegments.ts:272-274).
> The card is re-reviewed when the candidate appears, not when the reviewer approves it."*

So the behaviour is intended, not accidental. What was never revisited is **how far** it resets.

### The inconsistency this exposes

Migration 093 (Mark's decision, 2026-09-21) settled the neighbouring case — an **approved** image
*swapped* onto a `clinically_approved` card — and chose a much lighter penalty:

| event | current penalty | where |
|---|---|---|
| a **candidate** image arrives (generate / upload) | `clinically_approved` → **`draft`** (both stages lost) | code, §1 |
| an **approved** image replaces a different approved image | `clinically_approved` → **`editorial_reviewed`** (clinical only) | `sub_segments_image_swap_review` trigger, 093 |

The merely-*proposed* picture costs more review than the one that actually goes live. 093's own
reasoning — *"the text needs no re-edit, the new picture needs a clinician's eye"* — applies at least
as strongly to a candidate, which changes nothing a parent can see.

### `auto_approve` is the third path and already skips the reset

`generate_sub_segment_image { auto_approve: true }` supersedes the old approved row, approves the new
one and writes the pointer ([generateSubSegmentImage.ts:271-288](../src/jobs/handlers/generateSubSegmentImage.ts:271)),
taking the `if` branch and never calling `resetCardsToDraft`. The code comment says it *"correctly
skips the invalidation"*. It does still trip 093's trigger on the pointer write, so such a card ends
`editorial_reviewed` — again, lighter than the candidate path.

---

## 2. What it costs live (Moosii, 2026-11-24)

Cards by review state, cross-tabulated against the images they own:

| `review_state` | cards | candidate, no approved | candidate **and** approved | approved only | no images |
|---|---|---|---|---|---|
| `draft` | 507 | **244** | **7** | 38 | 0 |
| `editorial_reviewed` | 14 | 6 | 0 | 1 | 0 |
| `clinically_approved` | 63 | **0** | **0** | 30 | 1 |

* **7 cards** are `draft` while holding *both* an approved image and a newer candidate — i.e. they
  had a finished, approved picture, a regenerate dropped a candidate beside it, and the card lost its
  whole review. That is the walk-through symptom, 7 live instances.
* **244 more** are `draft` with a candidate and no approved image — the same mechanism, on cards that
  had not been approved yet (so nothing was lost, but they are indistinguishable in the queue).
* **No `clinically_approved` card anywhere holds a candidate** — necessarily, because a candidate
  resets it. That is the tell.
* **23 of the 50 pending segments** have the property that *every* draft card in them holds a
  candidate image, so image generation is a plausible sole cause of the segment being pending.
* 251 cards hold a candidate created after their last approval ("unadjudicated"); candidates pile up
  rather than being cleaned (249 cards with 1, 4 with 2, 4 with 3; only **1** `rejected` row exists
  on the whole project against 269 candidates).
* `content_images` carries **no trigger** on either project — so a rule placed there would be
  additive.

---

## 3. Proposal

Two changes. Together they give exactly what was asked: the text approval survives a regenerate, and
the lesson cannot read complete until the picture has been dealt with.

### Change 1 — a new candidate touches no review state at all

**Delete the reset from both call sites** (§1). A candidate is an *option*; nothing a parent can see
has changed, so no approval should be spent. The card keeps `clinically_approved`.

This is a smaller change than demoting to `editorial_reviewed`, and better, for three reasons:

* Demoting still spends the clinical sign-off on a picture that may be rejected thirty seconds later.
  Under "no state change", **rejecting an unwanted generated image costs nothing** — the segment
  simply returns to complete. Today it costs a full editorial + clinical re-review of that card.
* It leaves `auto_approve` coherent: that path already skips the reset, so all three image paths end
  up with one rule ("arriving candidates never move review state").
* It keeps 093 untouched, so the clinical decision of 2026-09-21 stands exactly as made.

### Change 2 — the gate, not the card, holds the lesson back

Extend `recompute_seg_status` (056) so a segment is `complete` only when

> ≥ 1 card **and** every card `clinically_approved` **and** no card holds an **unadjudicated
> candidate**,

where *unadjudicated candidate* = a `content_images` row with `status='candidate'` for that card,
created after that card's current approved image was approved (any candidate, if the card has no
approved image). `rejected` and `superseded` rows never count, so **`POST /content-images/:id/reject`
([images.ts:80](../src/routes/images.ts:80)) is the escape hatch** and already exists.

Plus one new trigger on `content_images` — `AFTER INSERT OR DELETE OR UPDATE OF status` — whose
*only* job is `PERFORM recompute_seg_status(<the owning segment>)`. It never writes card state. That
is what makes the gate close the instant a candidate lands and re-open the instant it is approved or
rejected, whoever did it (job, route, or CMS-direct).

### The resulting flow — regenerating the picture on a fully approved card

| step | card state | segment | what the editor sees |
|---|---|---|---|
| 0. approved lesson | `clinically_approved` | `complete` | published_reviewed |
| 1. generate a new image | **unchanged** | **`pending`** | published_unreviewed — "image awaiting review" |
| 2a. **reject** the candidate | unchanged | **`complete`** | back to reviewed, **zero re-review** |
| 2b. **approve** the candidate | 093 demotes → `editorial_reviewed` | `pending` | needs a clinical sign-off on the new picture |
| 3. clinical-approve the card | `clinically_approved` | **`complete`** | published_reviewed |

Step 2b is 093's existing rule and the reason the flow is not shorter: an image that actually goes
live still needs a clinician's eye. Whole-lesson approval collapses 2b+3 into one click —
`approve_segment_bundle` already approves images *before* promoting cards, precisely so a card whose
new picture arrives with the sign-off ends clinically approved (093's §2).

**Decision for Mark:** if you want "image approved ⇒ complete again" with *no* clinical re-sign, that
means narrowing 093 so a swap arriving on a card that was approved **before the candidate existed**
does not demote. I do not recommend it — it would undo a clinical decision to save one click, and
`approve_segment_bundle` already collapses the two steps in the normal path.

### Blast radius, measured

* **Change 1** is backend-only, two deletions, no migration. It cannot make anything *more* approved
  than it is today — it only stops a demotion.
* **Change 2** replaces `recompute_seg_status`, which is **the single writer of `seg_status`** (the
  only function on either project whose body writes it — verified) and is invariant-critical. It must
  be md5-guarded per CLAUDE.md; the live value is
  `660ed036da2cf30d2886244d850e7dab` (`md5(replace(pg_get_functiondef(oid), chr(13), ''))`,
  **identical on both projects**), and EXECUTE must be re-granted per 094 after the replace.
* Effect on today's data: **7** currently-`complete` segments hold an unadjudicated candidate and
  would go `pending`. All 7 also have unapproved cards — no `clinically_approved` card anywhere holds
  a candidate — so all 7 are already inside the 25 stale-complete segments that
  `docs/FINDINGS-complete-with-draft-cards.md` recommends re-deriving anyway. **Effect on correctly-
  complete segments: 0.** And **0** segments would move the other way (pending → complete): the rule
  only tightens.
* On **financial**: 0 segments affected either way (it has no stale-complete rows and no
  unadjudicated candidates on complete segments).
* ⚠ It tightens an **app-facing** gate. 056 promised *"seg_status keeps its EXACT shape/meaning"*;
  this adds a third input to that meaning. The app and the RLS reader policies both key on
  `seg_status='complete'` (`segments_select_admin_or_visible`,
  `sub_segments_select_admin_or_visible`), so a segment going `pending` makes the lesson
  un-openable — which is the intended effect for an unreviewed picture, but it is a **publish-state
  change in effect** and belongs in the same review as the repair.

### Sequencing

Change 1 can ship on its own, immediately, and is a strict improvement: cards stop losing their text
approval to a picture. Change 2 is the half that enforces "needs the image approved", and it should
land **with or after** the stale-complete repair — otherwise the 7 overlapping segments get
re-derived twice for two different reasons and the verification numbers stop being separable.

---

## 4. Decisions for Mark

| # | Decision | Recommendation |
|---|---|---|
| **I1** | Change 1 alone, or Changes 1 + 2? | **Both.** Change 1 removes the harm; Change 2 is the "needs the image approved" requirement. |
| **I2** | Change 1: no state change at all, or demote `clinically_approved` → `editorial_reviewed` (093's penalty)? | **No state change.** Demoting still spends the clinical sign-off on a picture that may be rejected, and makes rejecting a bad generation cost a re-review. |
| **I3** | Does "unadjudicated candidate" block a segment forever if nobody adjudicates? | Yes, by design — reject is the escape hatch and already exists. But note only **1** `rejected` row exists against 269 candidates, so the CMS needs a visible reject action before Change 2 ships, or editors will be stuck. **CMS-seat follow-up.** |
| **I4** | Narrow 093 so an approved swap on a card approved *before* the candidate existed does not demote (making "image approved ⇒ complete")? | **No** — it reverses a clinical decision (2026-09-21) to save a click that `approve_segment_bundle` already saves. |
| **I5** | Ship Change 2 before, with, or after the stale-complete repair? | **With or after.** 7 segments overlap; keeping them separate keeps the verification honest. |

**Nothing was written, applied or committed.** Related: `docs/FINDINGS-complete-with-draft-cards.md`
(the stale `complete` rows) and `docs/FINDINGS-reset-audit.md` (none of these resets leaves an audit
row today).
