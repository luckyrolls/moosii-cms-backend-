# FINDINGS — lessons marked `complete` with all-draft cards

**Brief:** INVESTIGATE ONLY (Mark, 2026-11-24, from moosii-cms `TODO.md`). *"At least 5 lessons in
Mark-group tracks have `seg_status = 'complete'` while every card is still draft — 3 of them are
published."* No code, no migrations, no commits; read-only DB access on both projects. Fixing the
image-generation reset is out of scope (`docs/FINDINGS-image-candidate-reset.md`).

All readings: `BEGIN TRANSACTION READ ONLY; … ROLLBACK;` 2026-11-24, identity confirmed first —
Moosii `postgres.szhihepbqzbbmxybluql` / sysid `7481590244898220655` / PG 15.8 / `domain=moosii`;
financial `postgres.gwxeaygksankbncptlle` / sysid `7678069749886157684` / PG 17.6 /
`domain=financial`.

---

## Summary

It is worse than reported in count and better in cause.

* **Moosii: 25 `complete` segments are stale, not 5.** 13 of them hang off a lesson (7 published);
  **12 are orphans with `lesson_id IS NULL`**, carrying 67 cards.
* **financial: 0.** Completely clean — no stale rows, no unapproved quiz question on a complete
  segment.
* **The cause is a single, identifiable one: migration 056 never re-derived the segments it
  invalidated.** It added `sub_segments.review_state` with `DEFAULT 'draft'` and ran **no recompute
  loop**, so every segment that was already `complete` stayed `complete` with all-draft cards. 056's
  own header predicted the consequence and nothing performed it. The split is exact: every stale
  segment was last touched **on or before 2026-08-09**; every correctly-complete segment on or after
  **2026-09-11**. No overlap.
* **No live write path produces this.** `recompute_seg_status` is the only function on either project
  whose body writes `seg_status`, and it derives correctly.
* **Parent exposure is real, not hypothetical.** The RLS reader policies and the app both gate on
  `seg_status='complete'` alone and never look at `review_state`. **4** of the 7 published stale
  lessons are in unarchived `mem` tracks — i.e. inside Moosii's currently active catalog after 128 —
  and **46 of 105 `user_mlp` rows across 16 users** point at stale lessons, including the
  negative-control lesson with the planted error.
* **126 does not prevent a recurrence.** `lesson_publish_blocker` reads `seg_status`, never card
  state. **5** of the 13 stale lessons return `NULL` from it right now — i.e. they are publishable
  today with every card in draft.
* **`lessons_review_status` (065) reports all 7 published stale lessons as `published_reviewed`.**
  The view is confidently wrong, because 065 declined to add a constraint on the explicit grounds
  that the bad combination *"cannot be represented"*.

---

## 1. Measured — the stale rows

### 1.1 Moosii: the 13 lesson-attached stale segments

Every one has **all** cards `draft` — `editorial_reviewed` = 0 and `clinically_approved` = 0 in all
13. That uniformity is itself evidence (§2): a partial reset would leave a mixture.

| lesson | track | group | pub | seg_id | cards | draft | seg last updated |
|---|---|---|---|---|---|---|---|
| Babyproofing Your Home for a Crawler | Baby Is Crawling | `mem` | **yes** | `ae1f4356` | 10 | 10 | 2026-07-04 |
| Bringing your baby home from the hospital | New Parents | `mem` | **yes** | `6519c3e7` | 8 | 8 | 2026-03-22 |
| Handling Your Newborn Safely | New Parents | `mem` | **yes** | `0dd404f3` | 8 | 8 | 2026-07-07 |
| Newborn Feeding Basics | New Parents | `mem` | **yes** | `f4f15be5` | 8 | 8 | 2026-03-16 |
| Balancing Work and Family Time | Balancing Work and Family | `legacy` | **yes** | `d7c3514a` | 9 | 9 | 2026-03-12 |
| Managing Stress and Finding Support as a Single Mom | Single Parenting 101 | `legacy` | **yes** | `176ca1b1` | 7 | 7 | 2026-06-15 |
| Understanding Your Premature Baby's Cues | Premies | `legacy` | **yes** | `d570e8c7` | 8 | 8 | 2026-03-17 |
| Parents First Date Night | New Parents | `mem` | no | `d13a78ca` | 8 | 8 | 2026-08-09 |
| Safe Sleep Setup for Newborns | New Parents | `mem` | no | `88513ed5` | 9 | 9 | 2026-08-01 |
| Understanding SIDS and Safe Sleep Practices | New Parents | `mem` | no | `844f2a80` | 6 | 6 | 2026-03-16 |
| Choosing the Right Formula for Your Baby | Feeding: Bottle Feeding | `live` | no | `e3bc07bf` | 8 | 8 | 2026-07-02 |
| Understanding RSV and Respiratory Health in Preemies | Premies | `legacy` | no | `e759f9be` | 9 | 9 | 2025-11-07 |
| Safe Sleep Setup for Newborns *(lesson archived — 060's duplicate loser `68a7b180`)* | New Parents | `mem` | no | `147ed2ac` | **0** | 0 | 2025-11-07 |

Note the last row: **a cardless segment marked `complete`.** 056 introduced the "≥ 1 card" rule as a
*new* guard and never applied it retroactively either.

`approved_by` is set on 9 of the 13 and NULL on 4 — and where it is set it is unreliable by design
(043's legacy note: pre-043 the CMS sent an email into a uuid column).

### 1.2 Moosii: 12 orphan stale segments

| `lesson_id IS NULL` | lesson row missing | `seg_status` | segments |
|---|---|---|---|
| no | no | `complete` | 19 (13 stale + 6 sound) |
| no | no | `pending` | 137 |
| **yes** | **yes** | `complete` | **12** (all stale, 67 cards) |
| **yes** | **yes** | `pending` | 2 |

14 segments have no lesson at all. They are invisible to every reader (all the policies and the app
join through `lesson_id`), so they are a hygiene problem, not an exposure one — but they are 12 of the
25 stale rows and the repair must decide what to do with them.

### 1.3 Quiz — an independent break

| `seg_status` | approved questions | unapproved questions |
|---|---|---|
| `complete` | 24 | **9** |
| `pending` | 13 | 35 |

Nine unapproved questions sit on seven `complete` segments, five of them published. `with_quiz` is
`false` on six of those seven (correct — invariant 10 derives it from an *approved* question), so the
app will not show a quiz; the one exception is "Understanding RSV…", which has `with_quiz = true` and
2 unapproved questions, and is unpublished.

### 1.4 Images on the stale cards

Of the 165 cards in the lesson-attached stale segments (all `draft`): 36 have a live
`sub_segments.image` pointer, 35 have an approved `content_images` row, 56 have a candidate. So the
majority of these "complete" lessons do not even have approved pictures.

### 1.5 `lessons_review_status` (065) output — the view is wrong

| project | `draft` | `published_reviewed` | `published_unreviewed` |
|---|---|---|---|
| Moosii | 142 | **11** | **0** |
| financial | 3 | 10 | 0 |

All **7** published stale lessons are reported `published_reviewed`, with
`cards_awaiting_editorial` equal to their entire card count (10, 8, 8, 8, 9, 7, 8). The view prints
the contradiction in adjacent columns — "reviewed", and every card awaiting editorial — because its
`content_state` reads `seg_status` while its counters read `review_state`.

### 1.6 financial: clean

0 stale segments, 0 unapproved quiz questions on complete segments, 0 orphan segments in the stale
set. Its oldest `content_approvals` row is 2026-09-25 — after 056 — so all of its content went
through the card ladder from the start. **This is the control that confirms the diagnosis.**

---

## 2. How they got there

### 2.1 The cause: migration 056 invalidated every card and re-derived nothing

[`migrations/056_card_review_state.sql:38-40`](../migrations/056_card_review_state.sql:38):

```sql
ALTER TABLE sub_segments ADD COLUMN IF NOT EXISTS review_state text NOT NULL DEFAULT 'draft'
  CHECK (review_state IN ('draft','editorial_reviewed','clinically_approved'));
```

and its header, [056:24-26](../migrations/056_card_review_state.sql:24):

> *"BACKFILL: EVERY existing card → 'draft'. … **Consequence: every currently-'complete' segment
> recomputes to 'pending' until re-reviewed.**"*

That recompute never happened. Grepping 056 for `recompute_seg_status` finds only its **definition**
and its call *inside* `set_card_review_state` — there is no loop over `segments`, and
`migrations/README.md:101-108` confirms the scope ("backfill all → draft"). `recompute_seg_status`
only ever runs on a card transition or an explicit `POST /segments/:id/recompute-status`, so a
segment nobody has touched since 2026-08-11 still carries its pre-056 verdict.

**The timestamp split is exact** — 31 complete segments on Moosii:

| stale? | segments | earliest `segments.updated_at` | latest |
|---|---|---|---|
| yes | 25 | 2025-11-07 | **2026-08-09** |
| no | 6 | **2026-09-11** | 2026-11-14 |

056/057 were applied in the 008..056 batch, with 057 verified live 2026-08-11
(`migrations/README.md:109-115`). Not one stale segment has been written since; not one sound one was
written before. There is no third population.

### 2.2 Ruled out, with evidence

* **A write path that sets `seg_status` directly.** `recompute_seg_status` is the **only** function
  on either project whose body writes `segments SET … seg_status` (§3). On Moosii 057 makes a direct
  write impossible for every role (`has_column_privilege(…, 'seg_status','UPDATE')` is false for
  `anon`, `authenticated` **and** `service_role`; 22 of 23 columns granted). ⚠ On **financial** that
  guard is missing — see §6.3 — but financial has no stale rows, so it is a latent risk, not the
  cause.
* **Cards reset *after* completion without `seg_status` following** (the image job, a CMS-direct
  edit). Structurally impossible on the paths that exist: `set_card_review_state` recomputes before
  returning (056), the 066 triggers `PERFORM recompute_seg_status`, and 093's demotion does too.
  Empirically impossible here as well: such a reset would leave a *mixture* of card states and a
  **post-056** `segments.updated_at`. All 13 lesson-attached stale segments have **100 % draft** cards
  and a **pre-056** timestamp.
* **A later backfill or migration.** No migration after 056 writes `review_state` or `seg_status` in
  bulk; the stale set's timestamps predate all of them.
* **Generated by this backend.** `ai_generation_log` for these lessons and their cards holds only
  `content_review_*` rows (10 + 7 + 1) — review passes, no `segment_content_generate`. The content
  predates this backend's generation path, i.e. it is BuildShip-era.

### 2.3 Per-lesson cause

**All 13: pre-ladder legacy (056).** `content_approvals` holds rows for only two of them, and both
are pre-056 and consistent:

| lesson | audit rows | reading |
|---|---|---|
| Parents First Date Night | `unapprove`, then `approve` ×4 (admin), 2026-08-09 19:53 → 20:12 | last approved **2 days before** 056; `segments.updated_at` matches the final `approve` to the second |
| Safe Sleep Setup for Newborns (`88513ed5`) | `approve` (super_admin) 2026-08-01 18:29 | same; `updated_at` matches |

The other 11 have **no** `content_approvals` rows at all — they were approved before 043 existed
(043's first row on Moosii is 2026-07-25, and the `approve`/`image` actions stop on 2026-08-09, which
is when 056's ladder replaced them).

---

## 3. Is `seg_status` still derived-on-write everywhere?

**Yes — every writer derives it.** Live function-body scan for `segments SET … seg_status`, both
projects, returns exactly one row:

| writer | derives from card states? | notes |
|---|---|---|
| `recompute_seg_status(uuid)` (056) | **yes** | `complete` iff `EXISTS(≥1 card)` AND `NOT EXISTS(card WHERE review_state IS DISTINCT FROM 'clinically_approved')`; locks the segment `FOR UPDATE`; NULLs `approved_by` when the result is `pending`. SECURITY DEFINER, EXECUTE `service_role` only (094/095) |

Everything else reaches it: `set_card_review_state` calls it ([056:103](../migrations/056_card_review_state.sql:103)); `approve_segment_bundle` / `unapprove_segment_bundle` go through `set_card_review_state` (056 §6, 093 §2); the 066 triggers and 093's demotion `PERFORM` it; Node never writes the column ([cardReview.ts:8-12](../src/lib/cardReview.ts:8)), and `POST /segments/:id/recompute-status` ([segments.ts:247](../src/routes/segments.ts:247)) is the CMS's sanctioned entry point.

**Nothing to flag in code.** The two things to flag are both *outside* the write paths: the stale rows
themselves (§1), and the missing column guard on financial (§6.3).

---

## 4. Parent exposure — the gap is real

**The reader gates on `seg_status` and never on `review_state`.** Live SELECT policies on Moosii:

| table | policy | qual |
|---|---|---|
| `lessons` | `lessons_select_admin_or_visible` | `is_admin() OR reader_lesson_visible(id)` |
| `segments` | `segments_select_admin_or_visible` | `is_admin() OR (seg_status = 'complete' AND reader_lesson_visible(lesson_id))` |
| `sub_segments` | `sub_segments_select_admin_or_visible` | `is_admin() OR EXISTS (… s.seg_status = 'complete' AND reader_lesson_visible(s.lesson_id))` |

`reader_lesson_visible(uuid)` exists on **both** projects and means published + lesson and track
unarchived. Nothing in that chain consults a card's `review_state`. So **a signed-in non-admin can
read every draft card of a stale published lesson today.**

How far it reaches:

| lesson | group | track visible | **parent-reachable** |
|---|---|---|---|
| Babyproofing Your Home for a Crawler | `mem` | yes | **yes** |
| Bringing your baby home from the hospital | `mem` | yes | **yes** |
| Handling Your Newborn Safely | `mem` | yes | **yes** |
| Newborn Feeding Basics | `mem` | yes | **yes** |
| Balancing Work and Family Time | `legacy` | **no** (track archived) | no |
| Managing Stress and Finding Support as a Single Mom | `legacy` | **no** | no |
| Understanding Your Premature Baby's Cues | `legacy` | **no** | no |

**4 reachable** — and all 4 are in `mem`, which after migration 128 **is** Moosii's active catalog
(`app_settings`/`catalog_mode_switches` seeded `mem`). The 3 unreachable ones are saved only by
invariant 6: 128 archived their tracks as `legacy`.

**Selection surface.** All 7 published stale lessons appear in `mlp_item_pool` (1 row each) — the pool
filters on `is_published`, not on review state (invariant 8). And live `user_mlp`:

| | rows | users |
|---|---|---|
| `user_mlp` total | 105 | 18 |
| **rows pointing at a stale lesson** | **46** | 16 |

Breakdown: Bringing your baby home from the hospital 16, Handling Your Newborn Safely 10,
**Understanding SIDS and Safe Sleep Practices 7**, Newborn Feeding Basics 6, "Parents Date Night" 6,
Babyproofing 1. Two of those (SIDS, Parents Date Night) are **unpublished**, so those rows are stale
plans that predate the unpublish — a separate staleness, worth noting.

⚠ The SIDS one is the **negative-control lesson** (`b31254cd`) with a deliberately planted error. It
is unpublished, so RLS blocks the content — but it sits in 7 test users' plans.

**Second surface: moosii-rn.** Named in CLAUDE.md invariant 10 and in 065's header — `useLesson.ts`
selects segments with `.eq('seg_status','complete')`, and `useQuiz.ts` reads `quiz_questions` by
`segment_id`. 065's header is explicit: *"the app selects segments with
`.eq('seg_status','complete')` and THROWS when none matches … so a published lesson with any draft
card errors when a parent opens it."* The inverse is what bites here: because these lessons **are**
`complete`, the app opens them happily and renders the unreviewed cards. Not read in this
investigation (seat separation) — flagged for the moosii-rn seat.

**Verdict:** no real parents exist yet (invariant 3, no clinical sign-off), so nobody has seen this.
But the gap is structural and currently open on 4 lessons in the active catalog. Nothing in the read
path would stop it the day a parent signs in.

---

## 5. Does publish check card states? Can it happen again?

**No, and yes.**

Live scan:

| function | calls `lesson_publish_blocker` | mentions `review_state` |
|---|---|---|
| `lesson_publish_blocker` | — | **no** |
| `set_lesson_published` (068) | **yes** | no |
| `lessons_publish_guard` (126) | **yes** | no |

126 closed the *bypass* (an admin can no longer flip `is_published` Supabase-direct) but kept reading
the **derived** gate — [126:200-208](../migrations/126_publish_gating_and_archive_audit.sql:200):
*"fully approved = at least one segment, and every segment 'complete'. `seg_status` is DERIVED by
`recompute_seg_status` (056) and means '≥1 card and every card clinically_approved'."* That comment
is the assumption; these 25 rows are its counterexample.

**What `lesson_publish_blocker` returns for the 13 stale lessons today:**

| blocker | lessons |
|---|---|
| `(NULL — publishable)` | **5**: Bringing your baby home from the hospital *(published)*, Handling Your Newborn Safely *(published)*, Parents First Date Night, Safe Sleep Setup for Newborns `b6e7628b`, Understanding SIDS and Safe Sleep Practices |
| `publish_quiz_pending` | 2: Babyproofing Your Home for a Crawler, Newborn Feeding Basics (both published) |
| `publish_archived` | 6 |

So **5 lessons whose every card is draft are publishable right now**, and two more are stopped only
by the *quiz* gate, not by the cards. A `publish` on any of them would succeed, write its audit row
and enqueue a rebuild — all correctly, by the rules as written.

**Can it recur from scratch?** Not from the existing write paths — a *newly* created segment can only
become `complete` through `recompute_seg_status`. The recurrence risk is narrower and real:

1. any future migration that bulk-changes `review_state` (or adds a stage) and forgets to re-derive —
   exactly 056's mistake, and the review ladder is not finished (roles slice 3 adds questionnaire
   review);
2. on **financial**, a direct `seg_status` write, which the missing 057 guard permits (§6.3);
3. a lesson/track **unarchive**, which restores visibility without touching review state
   (`FINDINGS-unarchive-approvals.md`; invariant 6 — "archive/unarchive touches no review state").

---

## 6. Proposal

### 6.1 (a) A structural guard — `seg_status` cannot be `complete` with unapproved cards

**Recommended: a trigger, not a CHECK constraint.** A `CHECK` cannot do it — the condition spans
`segments` and `sub_segments`, so it would need a subquery, which Postgres forbids in a table
constraint. A row-level trigger on `segments` is the only enforcement point, and it must be paired
with one on `sub_segments`, because the invariant can be broken from either side (promote the
segment, or demote a card).

Shape:

* `segments_status_derived_guard()` — `BEFORE INSERT OR UPDATE OF seg_status ON segments`,
  `SECURITY DEFINER`. If `NEW.seg_status = 'complete'` and the derived truth disagrees (`0 cards`, or
  any card not `clinically_approved`), **RAISE** with
  `ERRCODE = 'check_violation'`, `HINT = 'seg_status_not_derived'`.
  *Trap:* `recompute_seg_status` sets `complete` in the same statement in which the final card
  transition has already committed inside its own transaction, so the guard sees the true card states
  and passes. It must be verified on exactly that path, not only on a hand-written UPDATE.
* `sub_segments_demote_guard()` — or, better, no second trigger: the 066/093 triggers and
  `set_card_review_state` all already recompute, so the only way to demote a card without recomputing
  is a raw `UPDATE sub_segments SET review_state`, which §6.4 of
  `docs/FINDINGS-reset-audit.md` shows is possible today. **Recommend closing that with a column
  REVOKE (the 057 treatment) rather than a second trigger** — nothing needs the privilege, since
  `set_card_review_state` is SECURITY DEFINER.
* Trigger naming matters: AFTER/BEFORE triggers fire in **name order** and `segments` already carries
  `set_updated_at_trigger`, `content_edit_policy_guard_trg` and `segments_sync_with_quiz_trg` (128's
  header warns that renaming reorders them).

**Not recommended: making the view or the blocker read card states instead.** That treats the symptom
in two places and leaves `seg_status` free to lie to everything else — the app and three RLS
policies read the column directly.

**Also fix the reader, independently (D4 below):** even with the guard, `lesson_publish_blocker` and
the three SELECT policies would be more honest keyed on card state. Flagged, not recommended for this
migration — it is an app-facing semantic change and deserves its own slice.

### 6.2 (b) The repair — **REVIEW REQUIRED**

Re-derive, do not unpublish. `recompute_seg_status(seg_id)` is the sanctioned, single writer; calling
it on each stale segment produces `pending` and NULLs the unreliable `approved_by`, which is the
truth. Unpublishing is a second, separate decision (D2) — and note that re-deriving alone **already
removes the parent exposure**, because every reader gates on `seg_status='complete'`.

**Exact rows, Moosii (financial: 0 rows, nothing to repair):**

| set | segments | effect |
|---|---|---|
| lesson-attached stale | **13** | `complete` → `pending` (the table in §1.1 lists every `seg_id`) |
| orphan (`lesson_id IS NULL`) stale | **12** | `complete` → `pending` |
| **total re-derived** | **25** | |
| segments moving the other way (`pending` → `complete`) | **0** | verified: 0 segments are `pending` with all cards `clinically_approved` |

Of the 25, **7** also hold an unadjudicated candidate image and would additionally be caught by
Change 2 in `docs/FINDINGS-image-candidate-reset.md` — sequence the two so the numbers stay
separable.

**Knock-on effects to state in the migration header:**

* **7 published lessons flip to `published_unreviewed`** in `lessons_review_status`, and all 7 become
  **un-openable in the app** (065 §B.4 — `useLesson.ts` throws when no `complete` segment matches).
  That is the point: they are unreviewed. But it is a visible change to a published catalog, which is
  why this is REVIEW REQUIRED, not hygiene.
* **4 of those are in the active `mem` catalog**, so Mark's own test walk-through will start erroring
  on them. The 3 `legacy` ones are already invisible.
* **`lessons.with_quiz`** is derived from the *first `seg_status='complete'` segment* (invariant 10,
  063). Re-deriving flips those segments to `pending`, so `with_quiz` re-derives too — the 063
  triggers fire on `segments`, so it happens automatically and must be **verified**, not assumed.
  Expect `with_quiz` to go false where it was true on a repaired lesson ("Understanding RSV…" is the
  one candidate, and it is unpublished).
* **MLP:** `mlp_item_pool` filters on `is_published`, not `seg_status`, so the pool does **not**
  change and no rebuild is strictly required. The 46 stale `user_mlp` rows stay as they are. Decide
  explicitly (D3) whether to enqueue one `scope:all` rebuild anyway for tidiness.
* **`content_approvals`:** a re-derive writes **no** audit row — resets are unaudited today
  (`docs/FINDINGS-reset-audit.md`). The repair migration should record the 25 ids in its own header
  and reconciliation entry so the change is traceable at all.

**How to undo it.** Record the exact pre-state in the migration file — the 25 `seg_id`s, each with
its prior `seg_status` ('complete' for all 25) and prior `approved_by` — and have the undo re-apply
them with a direct UPDATE. Two caveats: on Moosii 057 revokes `seg_status` from every role, so the
undo must run as the table owner (an apply via psql as `postgres`, which is how this repo applies
migrations); and the guard from §6.1, once installed, would **refuse** the undo — so the undo must
drop the guard first and re-create it last, in the same transaction, exactly as
`docs/drafts/128-catalog-modes/undo.sql` does. Install the guard in a **separate, later** migration
from the repair, so each has a clean undo.

**Test first** on the throwaway local PG 17 cluster per `docs/drafts/128-catalog-modes/` (and
`PGCLIENTENCODING=UTF8`): a stale complete segment re-derives to pending; a cardless complete segment
re-derives to pending; a genuinely complete segment is **unchanged**; the guard refuses a hand-written
`UPDATE segments SET seg_status='complete'`; the guard **permits** `recompute_seg_status` on a fully
approved segment; `with_quiz` re-derives; and the undo restores all 25 byte-for-byte.

### 6.3 Incidental — financial has no 057 column guard

`segments` on financial grants table-wide UPDATE to `anon`, `authenticated` **and** `service_role`
(23 of 23 columns; `has_column_privilege('authenticated','public.segments','seg_status','UPDATE')` =
**true** for all three). On Moosii it is 22 of 23, `service_role` only, `seg_status` absent. 057
predates the per-project high-water split and the schema dump that built financial restored
Supabase's default grants over it. financial has no stale rows today, but it is the one project where
a direct `seg_status` write — the cause §2.2 rules out for Moosii — is actually possible. Also
reported in `docs/FINDINGS-reset-audit.md` §6.1; one FINANCIAL-ONLY migration re-running 057's
revoke/grant, with the column list re-read live first.

---

## 7. Decisions for Mark

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Repair by **re-deriving** `seg_status` (→ 25 segments pending), or by **unpublishing** the 7, or both? | **Re-derive only.** It is the truth, it uses the single sanctioned writer, and it removes the parent exposure by itself (every reader gates on `complete`). Unpublishing is a separate editorial call. |
| **D2** | The 4 reachable `mem` lessons become un-openable in the app the moment the repair lands — accept, or unpublish them first so they vanish cleanly instead of erroring? | **Unpublish those 4 in the same migration.** An erroring lesson in your own test catalog is worse than an absent one, and 126's blocker will refuse to re-publish them until they are reviewed. The 3 `legacy` ones need nothing (tracks archived). |
| **D3** | Enqueue a `scope:all` MLP rebuild after the repair? | **Not required** — the pool keys on `is_published`, so re-deriving changes nothing there. **Required if D2 is yes** (an unpublish changes the pool); the publish/unpublish path enqueues it already. |
| **D4** | The 12 orphan stale segments (`lesson_id IS NULL`, 67 cards): re-derive them, or delete them? | **Re-derive in this migration** (cheap, consistent, keeps the migration one idea). Deleting orphan content is its own decision — and `purgeImagesForSubSegments` ordering applies (invariant 5). Backlog it. |
| **D5** | Guard shape: `BEFORE UPDATE OF seg_status` trigger on `segments` only, or also close the raw-`review_state`-write path with a column REVOKE? | **Both, but the REVOKE belongs with §6.2 of `FINDINGS-reset-audit.md`** (it is the same hole, and the capability bypass there is the bigger half). Ship the `segments` guard here. |
| **D6** | Guard and repair in one migration, or two? | **Two.** Each needs its own clean undo, and the guard would refuse the repair's undo. Repair first, guard second. |
| **D7** | Should `lesson_publish_blocker` and the three RLS SELECT policies read **card state** rather than `seg_status`? | **Its own slice, not now.** It is an app-facing semantic change touching the reader for both projects. With the guard installed, `seg_status` becomes trustworthy again, which is enough. |
| **D8** | The 9 unapproved quiz questions on 7 complete segments (§1.3) — in scope? | **Yes, flag only.** They are not fixed by re-deriving cards. 126's blocker already catches them on a re-publish (`publish_quiz_pending`), and `with_quiz` keeps the app from showing them. No repair needed; one line in the reconciliation entry. |
| **D9** | Fix the `lessons_review_status` view so it cannot report `published_reviewed` with cards awaiting review? | **Unnecessary once the guard lands** — the view's tautology becomes true again, which is 065's own design. Note it in 065's header rather than changing the view. |

---

## 8. Doc corrections this slice will owe

* **`migrations/065_lessons_review_status_view.sql:10-16`** asserts the forbidden combination
  *"cannot be represented, so there is nothing to enforce."* That was wrong for 25 pre-056 rows and
  is the reason no constraint exists. The header needs the counterexample and a pointer to the guard.
* **`migrations/056_card_review_state.sql:24-26`** predicted *"every currently-'complete' segment
  recomputes to 'pending'"*. It did not, because 056 ran no re-derive. Worth an "as-applied"
  correction note, since this is the root cause.
* **`migrations/126…:200-208`** states `seg_status` *means* "≥1 card and every card
  clinically_approved". True by derivation, false as a stored fact until the guard exists.
* **CLAUDE.md** Data model (*"Review state is DERIVED upward … → `segments.seg_status` via
  `recompute_seg_status` only (056)"*) is accurate about the write paths and silent about the
  pre-056 rows that never went through them. If the guard ships, that becomes a structural
  invariant and may deserve a line — Mark's call, per the doc-maintenance rule.

**Nothing in this investigation was written, applied or committed.** Live access was read-only
throughout, on both projects, with identity confirmed first. Related:
`docs/FINDINGS-image-candidate-reset.md` (the image reset, 7 overlapping segments),
`docs/FINDINGS-reset-audit.md` (resets leave no audit row).
