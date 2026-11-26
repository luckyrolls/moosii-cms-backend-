# FINDINGS — auditing approval resets

**Brief:** INVESTIGATE ONLY (Mark, 2026-11-23). Backlog item "Audit card and quiz review resets"
(`docs/backlog.md:85-94`; CLAUDE.md Data model: *"Resets are NOT audited today (backlog P3)"*).
No code, no migrations, nothing applied. Every live reading below came from
`BEGIN TRANSACTION READ ONLY; … ROLLBACK;` on both projects, 2026-11-23:
financial `postgres.gwxeaygksankbncptlle` / sysid `7678069749886157684` / PG 17.6 / `domain=financial`,
Moosii `postgres.szhihepbqzbbmxybluql` / sysid `7481590244898220655` / PG 15.8 / `domain=moosii`.

**The gap in one sentence.** `content_approvals` records every GRANT of an approval and every
publish and archival (275 rows across the two projects), and records **nothing** when an approval is
taken away by an edit — so "who or what cleared these 73 clinically-approved cards, and when" is not
answerable from the data.

**Headline recommendation.** Audit the **state column**, not the thirteen edit paths: two new
`AFTER UPDATE OF <state> OR DELETE` triggers, on `sub_segments.review_state` and
`quiz_questions.answer_status`, writing one `content_approvals` row per entity that actually lost
ground. That is Phase 1 and it replaces no existing object. A second, md5-guarded migration (Phase 2)
then teaches the four existing reset functions to publish *why*, and threads the human actor through
the one RPC that already has a parameter for it. The decisions Mark must make are in §8.

---

## 1. Every path that resets an approval today

The brief said "the 12 triggers". The live count on the review-bearing tables is **23 triggers per
project, identical on both** — but only **four** of them reset review state, and a fifth
(`content_edit_policy_guard_trg`, migration 064) refuses an edit rather than resetting it:

| trigger | table | fires on | effect |
|---|---|---|---|
| `sub_segments_reset_review_trg` | `sub_segments` | AFTER INSERT, DELETE, UPDATE OF `title, content, sequence` | the edited card → `draft`; INSERT/DELETE/reorder → the WHOLE segment → `draft` |
| `sub_segments_image_swap_review_trg` | `sub_segments` | AFTER UPDATE OF `image`, WHEN image changed AND old state `clinically_approved` | that card `clinically_approved` → `editorial_reviewed` |
| `quiz_questions_reset_review_trg` | `quiz_questions` | AFTER UPDATE OF `question_text, question_explanation, image_url, type` | that question → `pending` |
| `quiz_answers_reset_review_trg` | `quiz_answers` | AFTER INSERT, DELETE, UPDATE OF `answer_text, is_correct, response, score` | the parent question → `pending` |

Defined in `migrations/066_content_edit_review_reset.sql` (cards + quiz), narrowed by
`migrations/092_card_reset_ignores_image_pointer.sql` (dropped `image` from 066's column list), and
extended by `migrations/093_image_swap_needs_clinical_review.sql` (the swap demotion).

### A. `sub_segments.review_state`

| # | Path | What loses approval | Mechanism | Is the actor knowable *there*? |
|---|---|---|---|---|
| R1 | `PATCH /sub-segments/:id` — [subSegments.ts:58](../src/routes/subSegments.ts:58) | that card → `draft` | **066 trigger** on the title/content UPDATE. The route's own `resetCardsAndReport` ([subSegments.ts:126](../src/routes/subSegments.ts:126)) then moves **0 rows** — the trigger got there first | **YES.** JWT actor, and written into the *same statement* as `updated_by` ([subSegments.ts:111](../src/routes/subSegments.ts:111)), plus a `content_edits` row ([:117](../src/routes/subSegments.ts:117)) |
| R2 | `DELETE /sub-segments/:id` — [subSegments.ts:149](../src/routes/subSegments.ts:149) | the WHOLE segment → `draft`, **twice**: once on the DELETE, again on each renumber `UPDATE OF sequence` ([:177-181](../src/routes/subSegments.ts:177)) | 066 trigger | **No.** The route reads no `req.user` at all; `auth.uid()` is NULL (service role); the deleted row's `updated_by` is the last *editor*, not the deleter |
| R3 | `POST /sub-segments/:id/upload-image` — [subSegments.ts:214](../src/routes/subSegments.ts:214) | that card → `draft` | explicit `resetCardsAndReport` ([:297](../src/routes/subSegments.ts:297)) → `set_card_review_state(p_actor = NULL)` | **In the route yes** (`req.user.id` is used for `uploaded_by`, [:287](../src/routes/subSegments.ts:287)) — but it is **not passed** to the RPC ([cardReview.ts:48](../src/lib/cardReview.ts:48) hardcodes `null`) |
| R4 | `POST /content-images/:id/approve` — [images.ts:16](../src/routes/images.ts:16) | a `clinically_approved` card → `editorial_reviewed` | **093 trigger** on `approve_content_image`'s write of `sub_segments.image` | `p_approved_by` already reaches the RPC ([images.ts:55](../src/routes/images.ts:55)); the trigger sees only `NEW.image` |
| R5 | `POST /segments/:id/reject` — [segments.ts:228](../src/routes/segments.ts:228) | clinical→editorial, or editorial→draft | `set_card_review_state` | **YES — already audited** as `reject` + `reason` ([segments.ts:239](../src/routes/segments.ts:239)) |
| R6 | `POST /lessons/:id/unapprove` — [lessons.ts:177](../src/routes/lessons.ts:177) | every card → `draft`, quiz → `pending`, approved images → `candidate`, pointers NULLed | `unapprove_segment_bundle` → `set_card_review_state(…, 'draft', NULL, NULL)` (056) | **YES — already audited** as `unapprove` ([lessons.ts:192](../src/routes/lessons.ts:192)) |
| R7 | `regen_segment_content` scope `whole_segment` — [regenSegmentContent.ts:220-242](../src/jobs/handlers/regenSegmentContent.ts:220) | **every card DELETED** and reinserted as `draft` | a DELETE: there is no state transition to observe at all | no human — but `job_id` + `correlationId` are in hand |
| R8 | `regen_segment_content` scope `single_card` — [regenSegmentContent.ts:303](../src/jobs/handlers/regenSegmentContent.ts:303) | that card → `draft` | explicit `resetCardsToDraft` | no human; job |
| R9 | `generate_segment_content` (first-time / replace) — [generateSegmentContent.ts:314-318](../src/jobs/handlers/generateSegmentContent.ts:314) | **every card DELETED** and reinserted | DELETE | no human; job |
| R10 | `generate_sub_segment_image`, non-`auto_approve` — [generateSubSegmentImage.ts:297](../src/jobs/handlers/generateSubSegmentImage.ts:297) | that card → `draft` | explicit `resetCardsToDraft` | no human; job |
| R11 | **CMS-direct card ADD / REORDER** (moosii-cms `src/data/cards.ts`, named in 066's header) | the WHOLE segment → `draft` | 066 trigger on INSERT / `UPDATE OF sequence` | **YES — `auth.uid()` is present** (an `authenticated` session) |
| R12 | **A direct `UPDATE sub_segments SET review_state = …`** from the CMS or psql | anything, in any direction | none — a raw write | `auth.uid()` for a CMS session, NULL for psql. **This is possible today — see §6.2** |
| R13 | `DELETE /lessons/:id` — [lessons.ts:384](../src/routes/lessons.ts:384) | everything under the lesson | FK cascade | in the route yes; nothing is logged |

### B. `quiz_questions.answer_status`

| # | Path | Mechanism | Actor |
|---|---|---|---|
| Q1 | CMS-direct quiz question or answer edit | 066's two quiz triggers | `auth.uid()` present |
| Q2 | `POST /quiz/:segment_id/unapprove` — [quiz.ts:47](../src/routes/quiz.ts:47) | a **direct** UPDATE ([quiz.ts:19-22](../src/routes/quiz.ts:19)), *not* via a trigger — `answer_status` is deliberately excluded from 066's column list to avoid recursion | **YES — already audited** as `unapprove` ([quiz.ts:31](../src/routes/quiz.ts:31)) |
| Q3 | `POST /lessons/:id/unapprove` | `unapprove_segment_bundle` | already audited (R6) |
| Q4 | `generate_quiz`, incl. `regen_segment_content { generate_quiz: true }` — [generateQuiz.ts:258,264](../src/jobs/handlers/generateQuiz.ts:258) | **approved questions DELETED** (answers first, then questions). The answer DELETEs fire `quiz_answers_reset_review_trg`, demoting the parent to `pending` *before* the question row disappears — so a question **with** answers leaves a transition; a question **without** answer rows is deleted with no transition at all | job |
| Q5 | `DELETE /lessons/:id`, segment delete | cascade | nothing logged |
| Q6 | direct `UPDATE quiz_questions SET answer_status` from the CMS or psql | raw write | see §6.2 |

### C. Segment and lesson level

`segments.seg_status` is DERIVED and written **only** by `recompute_seg_status` (056) — the sole
writer, by design ([cardReview.ts:8-12](../src/lib/cardReview.ts:8)). On **Moosii** that is
structural: migration 057 revoked table UPDATE and re-granted 22 of 23 columns to `service_role`
only, with `seg_status` deliberately absent (verified live: 22 granted columns, and
`has_column_privilege('authenticated', 'public.segments', 'seg_status', 'UPDATE')` = **false** for
all three roles). **On FINANCIAL it is not** — see §6.1.

So at segment and lesson level there is nothing extra to audit: a gate only moves because cards
moved, and lesson publish/unpublish and archive/unarchive are **already** atomic and audited
(`migrations/068_set_lesson_published_atomic.sql`; `archive_guard()` at
`migrations/126_publish_gating_and_archive_audit.sql:396`).

### D. Image approval (a boundary — see D4)

Not named in the brief's goal, but an approval is lost here too: `unapprove_segment_bundle` reverts
approved `content_images` → `candidate` and NULLs `sub_segments.image`/`image_path`;
`purgeImagesForSubSegments` ([src/storage/purgeImages.ts:11-20](../src/storage/purgeImages.ts:11))
DELETEs approved rows outright on a card delete, a single-card regen and a whole-segment regen. Live:
**72 approved** image rows on financial, **76** on Moosii. `content_images` carries **no** trigger on
either project.

---

## 2. Where the row should be written — triggers, and specifically on the state column

**Recommendation: triggers. And not on the edit — on the state column.**

Three reasons, in order of weight.

**(a) The routes cannot see most of the resets they cause, and already admit it.** Roles slice 2 had
to resort to snapshotting the segment before the write and diffing after, for exactly this reason —
[cardReview.ts:65-73](../src/lib/cardReview.ts:65): *"Several edit paths invalidate review in the
DATABASE, not in the route … A route that only reported its own writes would under-report."* R1 is
the sharp case: the PATCH route's own `resetCardsAndReport` call moves **0 rows**, because 066's
trigger already set the card to `draft` and the RPC's `review_state IS DISTINCT FROM` guard then
matches nothing. A route-level audit would therefore have to log *from the diff* — "something moved"
without knowing which rows — which is not an audit of entities.

**(b) One place instead of thirteen.** Node has thirteen reset paths (§1A/§1B). The database has two
state columns. Every writer of those columns passes through the trigger: the 066 and 093 triggers,
the `set_card_review_state` RPC (and therefore both approve/unapprove bundles), the CMS's direct
writes, and psql.

**(c) It is the only option that covers the CMS-direct and psql paths at all** (R11, R12, Q1, Q6) —
the same argument 066 itself made for being a trigger: *"A trigger is the right shape here precisely
BECAUSE these bypass the backend."*

### The actor, measured rather than assumed

`actor_role` already proves exactly what a trigger can and cannot attribute. Moosii's 157
archive/unarchive rows were written by 126's `archive_guard` using
`coalesce(auth.role(),'service')` + `auth.uid()`:

| `actor_role` | `actor_id` | rows | what that path was |
|---|---|---|---|
| `service_role` | **NULL** | 136 | the **backend** (service-role PostgREST): `auth.role()` = `service_role`, `auth.uid()` = NULL |
| `service` | **NULL** | 16 | **psql** — the 128 apply. `auth.role()` NULL → coalesced |
| `authenticated` | set | 5 | **CMS-direct** with a user JWT: `auth.uid()` works |

So a trigger attributes CMS-direct writes correctly and cannot attribute backend writes. Mark's own
goal already accepts that (*"NULL + actor_role for service/trigger paths"*), and 126's
`content_approvals_actor_required` CHECK already admits an actorless row for named actions.

Two cheap improvements that do better than NULL on the paths that matter most:

1. **`coalesce(auth.uid(), NEW.updated_by)` on `sub_segments`.** R1 — the main human card edit —
   writes `updated_by = actorId` in the *same UPDATE statement* as the content
   ([subSegments.ts:111](../src/routes/subSegments.ts:111)), so the trigger can read it off `NEW`
   with no new plumbing at all. R11 (CMS-direct) gets `auth.uid()`. There is no equivalent column on
   `quiz_questions`.
2. **Thread the actor into `set_card_review_state`'s existing `p_actor`.** It is already a parameter
   and is already passed on a clinical approval; every reset passes `null`
   ([cardReview.ts:48](../src/lib/cardReview.ts:48)). The function can then publish it to the audit
   trigger with `set_config('moosii.actor_id', …, true)` — see the constraint below. That covers R3,
   R5, R6, R8, R10.

**⚠ A GUC cannot be set from Node.** PostgREST runs **one transaction per HTTP request**, so a
`supabase.rpc('set_actor', …)` followed by a `.update()` is **two** transactions and the setting is
gone before the second one starts. This rules out the obvious "stamp a session actor at the top of
the request" design entirely. A transaction-local GUC only works when the SQL function that performs
the write sets it **itself** — which is why the cause (below) must come from the deciding function
and not from the route.

### The cause must come from the deciding function, not the audit trigger

An audit trigger on `review_state` sees a transition, never a reason. Only
`sub_segments_reset_review()` can tell a reorder from a text edit (`TG_OP`, and
`NEW.sequence IS DISTINCT FROM OLD.sequence`), and only `sub_segments_image_swap_review()` knows it
was an image swap. So "why" requires those functions to publish it —
`PERFORM set_config('moosii.reset_cause', 'card_reorder', true)` immediately before their UPDATE,
read by the audit trigger, defaulting to `unknown` when nothing set it (which is itself the signal
for R12/Q6, a raw write). That is **Phase 2** below, and it is the part that touches existing objects.

### Recursion and ordering (checked, must be preserved)

* The audit trigger only INSERTs into `content_approvals`, so it cannot re-fire itself.
* 066's trigger is scoped `UPDATE OF title, content, sequence` and 093's is `UPDATE OF image`.
  Neither list contains `review_state`, so the nested reset UPDATE does **not** re-enter them — the
  same no-recursion property 066's header relies on.
* AFTER triggers on one table fire in **name order** (128's header warns that renaming one reorders
  them). `sub_segments_review_audit_trg` sorts after `sub_segments_reset_review_trg` (`res` < `rev`),
  which is harmless here — the audit trigger fires on the *nested* statement either way — but the
  name should be chosen deliberately and the reason written into the header.
* On **financial** (the `block` domain, migration 064) `content_edit_policy_guard_trg` RAISES on an
  edit to a published lesson's content before any of this runs, so there is no reset and no audit
  row. Correct: nothing was lost.

---

## 3. Granularity and volume

**Recommendation: one row per entity that actually lost ground** — per card, per quiz question —
never one row per event.

* `entity_id` is the point of the table, and its index `content_approvals_entity_idx (entity_type,
  entity_id)` exists precisely to answer "full history for this entity" (043). A per-event row
  cannot answer "show me this card's history".
* "Only log when a row actually moved" (the backlog's wording) is **automatic**: a FOR EACH ROW
  trigger on a transition fires once per row that transitioned, and not at all otherwise.

### Measured volume (both projects, 2026-11-23)

| | financial | Moosii |
|---|---|---|
| segments with cards | 12 | 77 |
| cards per segment — min / median / avg / max | 5 / 7 / 6.67 / 8 | 4 / 8 / 7.52 / 10 |
| cards by state | 72 `clinically_approved`, 8 `draft` | 506 `draft`, 59 `clinically_approved`, 14 `editorial_reviewed` |
| segments holding non-draft cards | 11 | 12 |
| non-draft cards in total | 72 | 73 |
| **worst single event at per-card grain** (reorder/delete on the segment with the most non-draft cards) | **8 rows** | **8 rows** |
| quiz questions | 8 `approved`, 2 `pending` | 41 `approved`, 44 `pending` |
| segments by gate | 10 `complete`, 3 `pending` | 31 `complete`, 138 `pending` |
| `content_approvals` today | 47 | 228 |
| `content_edits` (human card edits ever) | 1 (2026-10-24) | 9, two actors, 2026-08-09 → **2026-11-23** |

So the realistic rate is tiny: Moosii has seen **9 human card edits in 3½ months**, and the worst
single event writes **8 rows**. A per-card grain costs on the order of **100–300 rows a year**
against a table that holds 228. There is no volume argument for coarsening the grain.

The one case that is not tiny: a **track build-out** (`docs/FINDINGS-track-buildout.md`). A
whole-track content regen over 10 lessons × 8 cards destroys ~80 approvals in one job, and each one
would be a row. Still trivial in absolute terms — and it is exactly the event you would most want on
the record.

### Keeping the history readable

* **Free, no column:** `now()` is the **transaction** timestamp, so every row a single statement
  writes shares `created_at` to the microsecond, and PostgREST gives one transaction per request. One
  edit's rows therefore already group exactly by `(entity_type, created_at)`. (The same property made
  128 use `seq` rather than `created_at` to order its switch log.)
* **Better, one column:** `event_id uuid`, published by the deciding function the same way as the
  cause. Its real value is not grouping but **linkage**: populate it in the job handlers with the
  `correlationId` they already generate for `ai_generation_log` (CLAUDE.md, AI generation logging),
  and "which regen destroyed these 80 approvals, with what prompt and model" becomes one join.
  Recommended — but only meaningful once Phase 2 threads it. See D5.

**No new index.** "This card's history" is served by `content_approvals_entity_idx`; "all resets this
week" is a sequential scan of a few hundred rows.

---

## 4. Does `content_approvals`' shape fit?

Live shape, identical on both projects:

```
id uuid PK · entity_type text NOT NULL · entity_id uuid NOT NULL · action text NOT NULL
actor_id uuid NULL · actor_role text NULL · created_at timestamptz NOT NULL · reason text NULL

content_approvals_action_check       action IN (approve, unapprove, publish, unpublish,
                                                editorial_approve, clinical_approve, reject,
                                                archive, unarchive)
content_approvals_entity_type_check  entity_type IN (segment, image, quiz, questionnaire,
                                                     lesson, sub_segment, track)
content_approvals_actor_required     actor_id IS NOT NULL OR action IN (archive, unarchive)
```

It **nearly** fits. Four changes, all additive, no backfill:

1. **`action`: add `review_reset`.** One value, with the level carried in data (point 4). The
   alternative — `editorial_reset` / `clinical_reset` — is rejected: the level is a property of the
   transition, not a different kind of action, and that scheme multiplies with every future review
   stage.
2. **`content_approvals_actor_required` must admit it.** Today an actorless row is legal only for
   `archive`/`unarchive`; a reset from the backend is actorless by construction (§2), so the CHECK
   becomes `action IN ('archive','unarchive','review_reset')`. This is the migration's one
   constraint-replacing edit — DROP + ADD on a 47/228-row table, instant, and it only widens.
3. **`entity_type`: add `quiz_question`.** `sub_segment` is already legal (056) and is right for a
   card. For quiz, `quiz` is already legal but by convention its `entity_id` is the **segment**
   ([quiz.ts:31](../src/routes/quiz.ts:31); `docs/api-contract.md:2396`) — 11 such rows exist on
   Moosii. A per-question reset needs the *question* id, so reusing `quiz` would silently
   re-interpret `entity_id` for a subset of existing rows. Add the value instead.
4. **Four new nullable columns:** `from_state text`, `to_state text`, `cause text`, `event_id uuid`.
   * `from_state` / `to_state` answer "what level was lost" explicitly and queryably.
   * `cause` as a **CHECK enum** — `card_edit, card_insert, card_delete, card_reorder, image_swap,
     regen, generate, unapprove, reject, lesson_delete, unknown` — so it cannot drift into free text.
     The same argument 055's header makes for `content_edits.entity_type` being a one-value CHECK
     rather than free text.
   * **`reason` is deliberately NOT reused for the cause.** It is the human reject reason
     (`docs/api-contract.md:302`), and mixing a machine enum into a free-text field makes neither
     queryable. Tempting, because `reason` is **used by 0 of all 275 rows** on either project — which
     is itself a finding (§6.4), not a licence.

**Is it REVIEW REQUIRED?** **Phase 1 is not; Phase 2 is.**

* **Phase 1** adds columns, widens three CHECKs, creates one new function and two new triggers. It
  **replaces nothing**. Blast radius: one extra INSERT on every write of those two state columns —
  i.e. on every approve as well as every reset, though only downward moves produce a row. Reversible
  by dropping the triggers.
* **Phase 2** does a `CREATE OR REPLACE` on **four** functions that sit on every content edit path:
  `sub_segments_reset_review`, `quiz_reset_review`, `sub_segments_image_swap_review` and
  `set_card_review_state`. That is squarely the 118/120 trap (CLAUDE.md Migrations: *"A migration
  that REPLACES a function body guards on an EXACT md5 of the live body, never a substring"*). Blast
  radius: every content edit path, plus CMS-direct card add/reorder and quiz edit, plus both
  approve/unapprove bundles (which call `set_card_review_state`).

**The md5 guards are already in hand, and — usefully — identical on both projects**, so one expected
value per function covers both applies (`md5(replace(pg_get_functiondef(oid), chr(13), ''))`, read
live 2026-11-23):

| function | md5 (CR-stripped), financial **and** Moosii |
|---|---|
| `sub_segments_reset_review` | `947187befcb5050a6101a4ed091d21e8` |
| `quiz_reset_review` | `46edd21044b15188ef4c31c03e89c99c` |
| `sub_segments_image_swap_review` | `6d673726c5721364f1b97a4a01eee9f8` |
| `set_card_review_state` | `4bb5e0cbab542e021c8aea22a0fe4168` |
| `recompute_seg_status` (not replaced; for reference) | `660ed036da2cf30d2886244d850e7dab` |
| `approve_segment_bundle` (not replaced) | `1243e2075d79e6be35cb6ce69e9e2955` |
| `unapprove_segment_bundle` (not replaced) | `5b50730f1667623de5b4fd4259a98302` |

All four replaced functions are already `SECURITY DEFINER` and already `service_role`-only on EXECUTE
(094/095), so the 094 grant pattern must be re-applied after each replace.

---

## 5. Live measurements

### 5.1 `content_approvals` volume by action

**financial — 47 rows**

| action | entity | n | actorless | first | last |
|---|---|---|---|---|---|
| publish | lesson | 15 | 0 | 2026-09-25 | 2026-11-14 |
| editorial_approve | segment | 13 | 0 | 2026-09-25 | 2026-11-10 |
| clinical_approve | segment | 12 | 0 | 2026-09-25 | 2026-11-10 |
| unpublish | lesson | 5 | 0 | 2026-09-28 | 2026-11-14 |
| archive | track | 1 | 0 | 2026-11-14 | 2026-11-14 |
| unarchive | track | 1 | 0 | 2026-11-14 | 2026-11-14 |

**Moosii — 228 rows**

| action | entity | n | actorless | first | last |
|---|---|---|---|---|---|
| archive | track | 86 | 83 | 2026-11-14 | 2026-11-20 |
| unarchive | track | 71 | 69 | 2026-11-14 | 2026-11-20 |
| editorial_approve | segment | 21 | 0 | 2026-08-10 | **2026-11-23** |
| clinical_approve | segment | 15 | 0 | 2026-08-10 | 2026-11-14 |
| publish | lesson | 9 | 0 | 2026-09-11 | 2026-11-14 |
| unpublish | lesson | 7 | 0 | 2026-09-11 | 2026-11-14 |
| approve | segment | 6 | 0 | 2026-08-01 | 2026-08-09 |
| approve | image | 5 | 0 | 2026-07-25 | 2026-08-01 |
| unapprove | segment | 4 | 0 | 2026-08-09 | 2026-09-28 |
| publish | questionnaire | 3 | 0 | 2026-08-01 | 2026-09-10 |
| unpublish | questionnaire | 1 | 0 | 2026-08-03 | 2026-08-03 |

**`reject`: 0 rows on either project** — that route has never been exercised live.

### 5.2 Triggers

23 non-internal triggers on `sub_segments` / `quiz_questions` / `quiz_answers` / `segments` /
`lessons` / `tracks` / `content_images`, and **the trigger name set is identical on both projects**.
Four reset review state (the table in §1); the rest are `set_updated_at`, the 064 edit-policy guards,
the 126 publish/archive guards, the 063 `with_quiz` derivation pair, and 128's three `tracks`
triggers. `content_images` carries none.

### 5.3 Everything else

Card / question / segment populations, cards-per-segment, `content_edits` history and image-status
counts are in §3's table and §1D. Column privileges and policies are in §6.1/§6.2.

---

## 6. Incidental findings (flagged, not acted on)

**6.1 ⚠ FINANCIAL has no migration-057 guard: `segments.seg_status` is directly writable there.**
Measured: `segments` relacl on financial grants table-wide UPDATE (`w`) to `anon`, `authenticated`
**and** `service_role`; all **23 of 23** columns are UPDATE-able by each, and
`has_column_privilege('authenticated','public.segments','seg_status','UPDATE')` returns **true** for
all three. On Moosii it is 22 of 23, `service_role` only, `seg_status` absent, all three roles
**false** — i.e. 057 exactly as written. 057 predates the per-project high-water split (it is on
Moosii's 008..057 reconciliation list) and the schema dump that built financial restored Supabase's
default grants over it. Consequence for this slice: **on financial a direct `seg_status` write can
fabricate or destroy a segment gate with no card transition, and therefore produce no audit row**,
whatever we build. A one-statement fix (re-run 057's revoke/grant as a FINANCIAL-ONLY migration), but
it needs its own pre-check because the column list must be re-read live.

**6.2 ⚠ `authenticated` and `anon` hold column UPDATE on `sub_segments.review_state` and
`quiz_questions.answer_status` — on BOTH projects.** RLS stops `anon` (the write policies are
`is_admin() OR auth.role() = 'service_role'`), but the admin policies carry **no** capability check,
and `is_admin()` is `role IN ('admin','super_admin')`. So **any CMS admin session can set
`review_state = 'clinically_approved'` Supabase-direct**, bypassing roles slice 2's capability gates
entirely — the same class of hole 126 closed for `is_published` with a trigger and 057 closed for
`seg_status` with a revoke. Worth stating for the audit's honesty: the proposed trigger logs
**losses**, so it would record an unauthorised *clearing* but not an unauthorised *granting*. A
complete answer is either the 057 treatment (revoke the column from all three roles — nothing needs
it, since `set_card_review_state` is SECURITY DEFINER) or a 126-style guard trigger. Separate slice.

**6.3 The PATCH route's own reset is already dead code, in effect.** `resetCardsAndReport` at
[subSegments.ts:126](../src/routes/subSegments.ts:126) moves 0 rows because 066's trigger fires
first. 066's header anticipated this (*"after this migration they reset twice, which is idempotent
and harmless … Their explicit reset can be retired later"*). It matters here because the backlog item
names `resetCardsAndReport` as a place to log from — and logging from there would log **nothing**.

**6.4 `reason` is used by 0 of 275 rows** across both projects, although `POST /segments/:id/reject`
passes it. A consequence of there being no `reject` rows at all.

**6.5 A quiz question with no `quiz_answers` rows is deleted with no transition** (Q4). The Phase-1
design covers it *only because* the trigger includes an `AFTER DELETE` arm. Dropping that arm to
simplify would reopen the hole.

---

## 7. Draft migration outline (no SQL applied; nothing committed as a migration)

### Migration A — Phase 1, additive: "every loss is on the record"

*** BOTH PROJECTS *** — schema only, no rows, idempotent.

1. **PRE-CHECK** — `app_settings.domain` is one of the two expected values; the three CHECK
   constraints match the definitions quoted in §4 verbatim (RAISE if not); `to_regprocedure` of the
   new function is NULL; the new trigger names are absent.
2. `ALTER TABLE content_approvals ADD COLUMN IF NOT EXISTS from_state text`, `to_state text`,
   `cause text`, `event_id uuid`, plus a CHECK enum on `cause`.
3. DROP + ADD `content_approvals_action_check` with `review_reset`;
   `content_approvals_entity_type_check` with `quiz_question`;
   `content_approvals_actor_required` with `review_reset` in its action list.
4. `CREATE OR REPLACE FUNCTION public.review_loss_audit() RETURNS trigger LANGUAGE plpgsql
   SECURITY DEFINER SET search_path = public, pg_temp` — one function for both tables, branching on
   `TG_TABLE_NAME` (the `archive_guard` / `content_edit_policy_guard` pattern):
   * rank the states (`draft` 0 < `editorial_reviewed` 1 < `clinically_approved` 2; quiz:
     `approved` 1, anything else 0);
   * on UPDATE return early unless the rank **fell**; on DELETE return early unless `OLD` was above
     the floor;
   * actor `coalesce(nullif(current_setting('moosii.actor_id', true),'')::uuid, auth.uid(),
     <NEW.updated_by — sub_segments only>)`; `actor_role coalesce(auth.role(),'service')`;
   * `cause coalesce(nullif(current_setting('moosii.reset_cause', true),''), 'unknown')`;
     `event_id` likewise from `moosii.event_id`;
   * INSERT one row: `entity_type` `sub_segment` | `quiz_question`, `entity_id` the row's id,
     `action 'review_reset'`, `from_state` / `to_state`.
   * SECURITY DEFINER is **required**: `content_approvals` is RLS-on with no policy (102), so an
     `authenticated` CMS session could not write it otherwise — 126's reason, verbatim.
5. `REVOKE ALL … FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE … TO service_role` (094).
6. Two triggers: `AFTER UPDATE OF review_state OR DELETE ON sub_segments FOR EACH ROW`, and
   `AFTER UPDATE OF answer_status OR DELETE ON quiz_questions FOR EACH ROW`. (A third on
   `content_images.status` if D4 says yes.)
7. **VERIFY**, in the same transaction: the four columns exist and are nullable; the three CHECKs
   contain the new values; the function exists with the expected ACL; both triggers exist with the
   expected `pg_get_triggerdef`; **and the four 066/092/093/056 function md5s are UNCHANGED** (the
   values in §4) — this migration must not have touched them.
8. **UNDO**, in the header: drop the two triggers, drop the function, drop the four columns, restore
   the three CHECKs to the definitions quoted in §4. Rows written in between are history and are
   kept — the same reasoning as 128's undo.

Local test first, on the throwaway PG 17 cluster, per the harnesses in `docs/drafts/rls-078/` and
`docs/drafts/128-catalog-modes/`: a text edit (1 row), a reorder (N rows), a card delete (N+1 rows),
an approve (**0** rows — upward), an image swap (1 row, clinical→editorial), a quiz text edit, a quiz
answer delete, a `generate_quiz`-style replace, a whole-segment regen delete, and a direct
`UPDATE … SET review_state` (1 row, `cause = 'unknown'`).

### Migration B — Phase 2, the cause and the actor (REVIEW REQUIRED)

*** BOTH PROJECTS *** — md5-guarded `CREATE OR REPLACE` of the four functions in §4's table, each
`PERFORM set_config(…, true)`-ing its cause (and `set_card_review_state` its `p_actor`) immediately
before the write it already performs; re-grant per 094; VERIFY that each new md5 differs from the old
and that a rolled-back exercise of every path produces the expected `cause`. Code in the same pass:
pass the JWT actor into `resetCardsToDraft` / `resetCardsAndReport` (one new parameter at
[cardReview.ts:47,54](../src/lib/cardReview.ts:47)) from R3/R5/R6/R8/R10, and pass `correlationId` as
the event id from the job handlers. Per CLAUDE.md, **migration first, then code** — and here the code
change must ship *with* B rather than before it, because the new parameter does not exist until B
lands.

---

## 8. Decisions for Mark

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Phase 1 only, or Phase 1 + Phase 2? | **Both, as two migrations, Phase 1 first.** Phase 1 alone closes the backlog item as written (who / what / when, cause `unknown`) and replaces nothing. Phase 2 buys the *why* and the human actor on backend paths, at the cost of replacing four functions that sit on every content edit path. |
| **D2** | One `review_reset` action value, or per-level values? | **One**, with the level in `from_state` / `to_state` (§4.1). |
| **D3** | New `entity_type 'quiz_question'`, or reuse `'quiz'` with a question id? | **Add `quiz_question`.** Reusing `quiz` re-interprets `entity_id` for the 11 existing rows that hold a segment id. |
| **D4** | Are **image** approvals in scope (`content_images` approved → candidate, and approved rows DELETEd by the purge)? 72 / 76 approved rows live. | **Yes, as a third trigger in Phase 1** — same function, same shape, and the purge is the one path that destroys an approval leaving no state behind at all. Say no and it stays a known blind spot. |
| **D5** | `event_id` column: in, or group by `created_at`? | **In.** Its value is the join to `ai_generation_log` via the handlers' existing `correlationId` — "which regen destroyed these approvals, with which prompt and model". `created_at` already groups, so it is not needed *for grouping*. |
| **D6** | Where a human action is **already** audited (`unapprove` R6/Q2/Q3, `reject` R5), accept **two** rows — the act, plus N `review_reset` rows for the consequence — or suppress the reset rows? | **Accept both.** They answer different questions, and the trigger cannot tell the difference without being told. Cost: ≤10 extra rows per unapprove. |
| **D7** | The DELETE-route actor (R2). A one-line route change — `UPDATE sub_segments SET updated_by = <actor>` before the delete, which fires no reset because `updated_by` is outside 066's column list — would attribute it. Do it, or accept NULL? | **Do it, in Phase 2.** It is the only reset path where a human acts and *nothing* records who. |
| **D8** | §6.1 (financial has no 057 guard) and §6.2 (any CMS admin can write `review_state` direct, bypassing the capability gates) — backlog entries, or slices of their own? | **§6.2 is a slice** — it is a hole in roles slice 2, not hygiene. **§6.1 is a backlog P2** FINANCIAL-ONLY migration. Neither belongs in this one. |
| **D9** | `DELETE /lessons/:id` and segment deletes (R13, Q5) destroy approvals by cascade. Audit them, or out of scope? | **Covered for free by Phase 1's `AFTER DELETE` arm** — a cascade delete fires row triggers, so each approved card and question that disappears leaves a row (actor NULL, cause `unknown` until Phase 2 names it `lesson_delete`). Nothing extra to decide unless you also want the lesson row itself logged. |

---

## 9. Doc corrections this slice will owe (not made — investigate-only)

* **`docs/backlog.md:85-94`** names `sub_segments_reset_review`, `quiz_reset_review` and
  `resetCardsAndReport` as the places to log from. Two of the three are right, the third would log
  nothing (§6.3), and the list misses `sub_segments_image_swap_review` (093), both bundles, and every
  DELETE path.
* **`docs/api-contract.md:2385-2404`** still describes `content_approvals` as four actions and five
  entity types; it is nine and seven live (056, 126). *"NOT logged: image `reject`"* remains true.
* **CLAUDE.md** Data model: *"Resets are NOT audited today (backlog P3)"* stays accurate until
  Migration A is applied.

**Nothing in this investigation was written, applied or committed.** Live access was read-only
throughout (`BEGIN TRANSACTION READ ONLY; … ROLLBACK;`), on both projects, with identity confirmed
first.
