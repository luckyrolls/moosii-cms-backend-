# FINDINGS — published-content edit policy

Design only. Nothing built, no SQL applied. Read against `docs/api-contract.md`, the backend
routes and RPCs, and the CMS repo's data layer (`moosii-cms/src/data/*`) on 2026-09-10 at
commit `355f8a4`. Draft migrations accompany this as `064` and `065`, both DRAFT.

> **The brief's premise is half wrong, and the half that's wrong changes the design.**
> "A content edit to a published lesson goes live immediately and only resets the review
> state" is true for quiz edits, card reordering and metadata. It is **false for card text
> edits and added cards** — those do not go live, they take the lesson **off the air**. The
> app filters segments by `seg_status='complete'` and **throws** when none matches, so
> resetting a card to `draft` makes a published lesson un-openable. Detail in §A.3.
> Consequence: **option B ("keep live") cannot be delivered by this backend alone** — it
> needs a change in `moosii-rn`. See §B.4.

---

## A. Write paths

### A.1 Content vs metadata — confirmed against the schema

**Content** (changes what a parent reads):

| table | how it is written |
|---|---|
| `sub_segments` (`title`, `content`, `sequence`, `image`) | backend `PATCH /sub-segments/:id`; **CMS-direct** for reorder + add |
| `segments` (`title`, `content`, `takeaway`, `anchor_text`) | generation handlers only |
| `quiz_questions` (`question_text`, `question_explanation`) | **CMS-direct** |
| `quiz_answers` (`answer_text`, `is_correct`, `response`) | **CMS-direct** |
| `content_images` / the approved image behind `sub_segments.image` | backend routes + jobs |

**Metadata** (does not change the read experience): `priority`, `track_id`, `topic_id`,
`lesson_name`, `internal_name`, `description`, `min_child_age`, `max_child_age`,
`curator_note`, `band_rationale`, `archived_at`, `is_published`.

**Ambiguous — flagged as asked:**

- **`sub_segments.tone_id`** — metadata *about* content. Changing it alone changes nothing a
  parent sees; it records the voice a card was last written in. **Treat as metadata.** But
  note it is only ever written *alongside* a regeneration, which is content, so in practice
  it never moves on its own.
- **`lessons.safety_sensitive` and `band_rationale`** — the safety band. Not parent-facing,
  so metadatas by the letter of the rule. **But `safety_sensitive` is a review-routing
  input** (it flags content needing the higher clinical bar). Flipping it to `true` on a
  published lesson arguably *should* force re-review even though no text changed.
  **Decision for Mark.** My recommendation: treat it as metadata for the edit policy, and
  handle it separately as a "raise the bar" action, because conflating the two makes the
  content trigger fire on a flag that changes no content.
- **`lessons.description`** — listed as metadata above, but the app *does* surface it
  (`user_mlp.item_description` flows from it). It is parent-visible. **I have classified it
  as metadata** on the grounds that it is a catalog blurb, not lesson content, and it is
  edited from the lesson form rather than the card editor. **Flagging it because that is a
  judgement, not a fact.**
- **`with_quiz`** — no longer editable at all as of migration 063 (derived, invariant 12).
  Out of scope by construction.

### A.2 Every write path, and whether it resets review state

| # | path | tables | resets review? |
|---|---|---|---|
| 1 | `PATCH /sub-segments/:id` (`src/routes/subSegments.ts:102-123`) | `sub_segments` text | **YES** — `resetCardsAndReport` sends that card to `draft` |
| 2 | `POST /sub-segments/:id/upload-image` (`:274`) | `sub_segments.image` | **YES** — same helper |
| 3 | `DELETE /sub-segments/:id` (`:135`) | `sub_segments` | recomputes `seg_status`; no per-card reset (the row is gone) |
| 4 | `generate_segment_content` / `regen_segment_content` jobs | `sub_segments` | **YES, by construction** — rows are delete+reinserted at the `draft` default |
| 5 | `generate_track_content` job | `sub_segments` | **YES**, same |
| 6 | `generate_quiz` job (`generateQuiz.ts:276`) | `quiz_questions` | **YES** — inserts at `answer_status='pending'`, and always REPLACES |
| 7 | `POST /quiz/:segment_id/approve\|unapprove` (`src/routes/quiz.ts:19`) | `quiz_questions.answer_status` | n/a — it *is* the review act |
| 8 | `POST /content-images/:id/approve\|reject` | `content_images`, `sub_segments.image` | **NO** — and that is correct: approving is a review act, not an edit |
| 9 | `approve_segment_bundle` / `unapprove_segment_bundle` (056) | `sub_segments.review_state`, quiz | n/a — the review act itself |
| 10 | **CMS-direct: card reorder** (`moosii-cms/src/data/cards.ts:212-231`) | `sub_segments.sequence` | **NO** |
| 11 | **CMS-direct: add card** (`cards.ts:303`) | `sub_segments` INSERT | **NO** explicit reset (the new row defaults to `draft`, which drags `seg_status` down — see §A.3) |
| 12 | **CMS-direct: quiz edit** (`cards.ts:337-350`) | `quiz_questions`, `quiz_answers` | **NO** — `answer_status` stays `approved` |
| 13 | **CMS-direct: lesson metadata** (`data/lessons.ts:249`, `priorities.ts:60`) | `lessons` | n/a — metadata |
| 14 | **CMS-direct: publish toggle** (`cards.ts:426`) | `lessons.is_published` | n/a — see §A.4 |

**The three holes are rows 10, 11 and 12** — all CMS-direct, none mediated by the backend,
none resetting review state. Row 12 is the sharpest: editing the text of an **approved** quiz
question leaves `answer_status='approved'`, so the change reaches parents immediately with no
review and no audit row.

### A.3 The thing that breaks the premise

The app's read path (`moosii-rn/src/hooks/useLesson.ts`) is:

```
segments .eq('lesson_id', id) .eq('seg_status','complete') .order('segment_order') → [0]
if (!segData) throw new Error(`No complete segment found for lesson ${lessonId}`)
```

`seg_status` is derived (056): `complete` iff the segment has ≥1 card and **every** card is
`clinically_approved`. So the moment path 1, 2, 4, 5 or 11 sends any card to `draft`, the
segment goes `pending` and **the app throws when a parent opens that lesson**. It still
appears in their plan (`user_mlp` is unaffected), so the failure is "tap the lesson, get an
error", not "the lesson quietly vanishes".

So the current behaviour splits three ways, and only the middle one matches the brief:

| edit | what actually happens today |
|---|---|
| card text, card image, added card, any regeneration | lesson becomes **un-openable** until re-approved |
| quiz text, card reorder | **goes live immediately**, unreviewed, silently |
| metadata | goes live immediately (intended) |

### A.4 Contract drift found on the way — lesson publish is not going through the backend

`docs/api-contract.md` §3 states that lesson publish/unpublish "now go through backend routes
`POST /lessons/:id/publish|unpublish` (migration 043) … the CMS repointed its toggle here".
**The CMS has not repointed.** `moosii-cms/src/data/cards.ts:419-430` flips
`lessons.is_published` Supabase-direct, and there is no `publishLesson` anywhere in the CMS
(`src/lib/api.ts` exports `publishQuestionnaire`/`unpublishQuestionnaire` only — questionnaires
*did* repoint, and their data layer even carries the comment "never flip is_published"
directly).

Three consequences, all live today and all relevant to this design:

1. Lesson publish/unpublish writes **no `content_approvals` row** — the attribution audit
   (migration 043) is silently bypassed for the single most consequential action in the CMS.
2. It does **not** enqueue the coalesced MLP rebuild, so a newly published lesson does not
   reach anyone until some unrelated rebuild runs.
3. **This design cannot assume the backend sees a publish.** Any policy keyed on
   "is it published?" has to live in the database, not in a route.

**Recommendation: fix this first, separately.** It is a small CMS change (call the existing
backend route) and it makes the audit and rebuild correct again. It is also a precondition
for option A being auditable — see §C.4.

---

## B. State model

### B.1 `published_unreviewed` should NOT be a new column

It is already fully determined by state that exists:

```
published_unreviewed(lesson) ≡ lessons.is_published = true
                             ∧ the lesson has a segment whose seg_status <> 'complete'
```

`seg_status` is itself derived from `sub_segments.review_state` (056). So "published" and
"has unreviewed content changes" are already two existing facts, and the state the brief wants
to name is their conjunction. Adding a column would introduce a second source of truth for
something already computable, which is exactly what invariants 6 and 12 exist to prevent.

### B.2 The requested constraint is a tautology under this model

The brief asks that a lesson cannot be *published* **and** *clinically approved* **and** *have
unreviewed content changes* simultaneously. Under B.1, "clinically approved" and "has
unreviewed changes" are **the same column read two ways** — `seg_status='complete'` means every
card is `clinically_approved`, and anything else means at least one is not. They are mutually
exclusive by construction. **No CHECK or trigger is needed to enforce it; it cannot be
represented.** That is the strongest form of the structural preference the brief asks for.

Migration 065 therefore adds **no constraint** — it adds a *view* that names the state so the
CMS and the reviewer queue can read it (§D, §E).

### B.3 Naming the three states

Derived per lesson, in `lessons_review_status` (migration 065):

| `content_state` | meaning |
|---|---|
| `draft` | not published; ordinary pre-publication work |
| `published_reviewed` | published, every card clinically approved |
| `published_unreviewed` | **published, with at least one card not clinically approved** |

`published_unreviewed` clears **automatically** on re-approval, because re-approving the cards
makes `seg_status` `complete` again. No clearing step to write, and no way to forget it.

### B.4 ⚠ But option B does not work today, and this backend cannot make it work

Option B is "keep live, entering a visible `published_unreviewed` state". Under A.3, entering
that state is *precisely* what takes the lesson off the air: `seg_status` goes `pending`, and
the app throws. So today `published_unreviewed` is not "live but flagged", it is "broken and
flagged".

Making option B mean what it says requires the **app** to keep rendering a published lesson
whose segment is `pending`. That is a change in `moosii-rn`'s `useLesson.ts`, e.g. select the
first segment by `segment_order` and use `seg_status` only to decide whether to show a
"being updated" affordance. **That is out of this repo and out of this slice.**

Until that lands, the honest options are:

- **B-now:** option B shows the lesson as `published_unreviewed` in the CMS **and warns that
  parents currently get an error until re-approval.** Truthful, but a poor offer.
- **A-only-for-now:** offer only option A (unpublish and re-review) in Moosii, and light up
  option B when the app change ships. **This is my recommendation** — it is the only choice
  that never breaks a parent's session.

**Decision for Mark**, and it gates whether the CMS dialog ships with one button or two.

---

## C. Enforcement

### C.1 Where the domain lives for the database to read

A one-row settings table (migration 064):

```sql
app_settings (key text primary key, value text not null)   -- seeded with ('domain', …)
```

**Keeping it in step with the backend's `DOMAIN` env** is the real question, since a mismatch
would mean the DB enforces one domain's policy while the service believes it is the other.
Assert it at boot, in the same place the env is already validated (`src/lib/domain.ts`):

- On startup, `SELECT value FROM app_settings WHERE key='domain'`.
- If the row is missing → log loudly and continue (a fresh project has not been seeded).
- If it is present and **differs** from `process.env.DOMAIN` → `console.error` + `process.exit(1)`,
  exactly like an invalid `DOMAIN`. A mislabelled deployment must fail to boot, not run.

This is a small addition to slice 1's boot check, not a new mechanism, and it makes the DB row
the thing that cannot silently drift.

### C.2 The warn-domain trigger is a no-op — do not build it

The brief specifies: warn-domain → the trigger sets `published_unreviewed`. Under §B.1 there is
**nothing to set** — the state is derived and already correct the instant the card's
`review_state` changes. Writing a trigger to stamp it would create the duplicate source of
truth §B.1 avoids. **Moosii needs no trigger at all.**

### C.3 The block-domain trigger is the only one that has to exist

For `financial`, a content write to a published lesson must fail. That genuinely needs a
trigger, because §A.4 establishes the backend cannot be trusted to be in the loop.

Migration 064 adds `content_edit_policy_guard()` on `sub_segments`, `quiz_questions`,
`quiz_answers` and `segments`: resolve the owning lesson, and if
`domain='financial' AND lessons.is_published` → `RAISE EXCEPTION` with a stable `ERRCODE` the
CMS can key on. Under any other domain it returns immediately, so Moosii pays only a lookup.

### C.4 Option A is a CMS sequence, and it has an audit gap

Option A is "the CMS unpublishes first, then edits", so the trigger sees an unpublished lesson
and permits the write. That works — but per §A.4 the CMS unpublishes by writing `is_published`
directly, so **the unpublish is not audited and does not trigger a rebuild**. Fixing §A.4 is
what makes option A a first-class, attributable action rather than a silent flag flip.

---

## D. Contract

Full diff in the draft. In summary, the CMS needs three things:

1. **A well-known error, not a pre-save check endpoint.** A pre-save check is a race — the
   lesson can be published between the check and the save. The trigger's exception is the
   authority. Surface it as `409 { error: { code: "published_content_locked", … } }` from any
   backend route that touches content, and let the CMS dialog key off that code. For
   CMS-direct writes the PostgREST error carries the same `SQLSTATE`, so one handler covers
   both. **A pre-save check may still be added for UX** (to warn *before* the editor types),
   but it must be advisory and must never be the thing that enforces.
2. **The state in list payloads** — `content_state` from the §B.3 view, so lists can filter
   and badge. The CMS reads lessons Supabase-direct, so this ships as a view it can select
   from rather than a route change.
3. **Re-approval clears it** with no new endpoint: `POST /lessons/:id/approve` already moves
   every card to `clinically_approved`, which recomputes `seg_status` to `complete`, which
   makes the derived state `published_reviewed`. Nothing to add.

---

## E. Reviewer queue

`published_unreviewed` items are **the highest-priority queue in the system** — they are the
only review state a parent is currently exposed to (or, per §B.4, currently erroring on).

They surface through the same view: `lessons_review_status` gives `content_state` plus
`cards_awaiting_editorial` and `cards_awaiting_clinical`, so one query drives both stages:

- **Stage 1 (editorial)** — `content_state='published_unreviewed' AND cards_awaiting_editorial > 0`.
- **Stage 2 (clinical)** — `content_state='published_unreviewed' AND cards_awaiting_editorial = 0
  AND cards_awaiting_clinical > 0`, which is the same gate `POST /lessons/:id/approve` already
  enforces (it 409s when cards still await editorial).

Sort published-unreviewed above unpublished drafts in both queues. No new tables, no new
routes — the existing capability gating (056) already decides who may act at each stage.

---

## Decisions — RESOLVED 2026-09-10

All five are settled; the build slice implements them. Recorded here so the reasoning above
is read in light of the outcome, not re-litigated.

1. **Option A only.** Option B is not offered. It is not deliverable while the app requires
   `seg_status='complete'` (§B.4).
2. **Lesson publish routes through the backend.** The routes already exist and already audit
   and rebuild; the CMS must stop writing `is_published` directly (§A.4, contract 9g).
3. **`safety_sensitive` is content.** Guarded on `lessons` by migration 064.
4. **`description` is content** — the rule was "iff the app renders it", and it does:
   `moosii-rn` `useLesson.ts:71` returns it, and the plan list renders it via
   `user_mlp.item_description`. Guarded on `lessons` by migration 064.
5. **The three CMS-direct paths get approval-reset triggers** — migration 066.

### Original framing (kept for the reasoning)

1. **§B.4 — one button or two?** Option B is not honestly deliverable until `moosii-rn` stops
   requiring `seg_status='complete'`. Ship A-only now, or ship B with a warning that parents
   get an error until re-approval?
2. **§A.4 — fix the lesson publish path first?** It is a small CMS change and it restores the
   approval audit and the publish-triggered rebuild. Recommend yes, before this slice is built.
3. **§A.1 — is `safety_sensitive` content or metadata?** Recommend metadata, handled as a
   separate "raise the bar" action.
4. **§A.1 — is `lessons.description` metadata?** It is parent-visible via `user_mlp`. I
   classified it as metadata; say if that is wrong.
5. **Do the CMS-direct holes (§A.2 rows 10-12) get closed by routing them through the backend,
   or left direct and governed only by the trigger?** The trigger covers the block domain
   either way, but only a backend route can reset review state and write an audit row.
