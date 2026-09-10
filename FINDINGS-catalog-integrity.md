# FINDINGS — catalog integrity: duplicate lessons + `with_quiz` drift

Investigation only. No code changed, no SQL run, nothing applied. All live figures come from
read-only PostgREST queries against the production Supabase project on 2026-09-10, at commit
`8e04b95`.

**Note on `card_positions`.** The brief asks whether these lessons are referenced by
`card_positions` rows. There is no `card_positions` table. `card_positions` is a
`prompt_blocks` block type (the role-by-position rule, CLAUDE.md invariant 2), not a
per-lesson reference. The per-lesson card rows are `sub_segments`, so that is what section A
counts.

**Two findings that de-risk everything below.**

- **All three tracks involved are ARCHIVED**, so all seven lessons are already
  effective-archived and invisible to parents (invariant 6). None is published.
- **Zero user-facing references exist** for any of the seven: no `user_mlp`, no
  `completed_items`, no `starred_items`, no `user_lesson_progress`, no `lesson_tags`.
  Deleting any of them cannot affect a user's plan or history.

---

## A. The three duplicate sets

Per row: track, references, segment count and completeness, approved quiz count, created_at.
Card counts are `sub_segments`. "Card imgs" is `content_images` rows owned by those cards.
Every row below has `is_published = false`, `archived_at = null`, and `with_quiz = true`.

### Set 1 — "Safe Sleep Setup for Newborns" (3 rows, all in **New Parents** `[ARCHIVED]`)

| id | created_at | created_by | segs / status | cards | card imgs | quiz Q | approved Q | priority | age |
|---|---|---|---|---|---|---|---|---|---|
| `68a7b180` | 2025-05-11 | *(null)* | 1 / `complete` ⚠stale | **0** | 0 | 3 | **3** | 550 | 0–2 |
| `b6e7628b` | 2026-04-23 | mark@moosiiapp.com | 1 / `complete` ⚠stale | **9** (all draft) | **4** | 1 | 1 | 350 | 0–999 |
| `2421cb61` | 2026-05-09 | mark@moosiiapp.com | 1 / `pending` | 9 (all draft) | 0 | 2 | 0 | 200 | 0–999 |

**Keep `b6e7628b`.** It is the only row with both a full card set and images. `68a7b180` is
the BuildShip-era row (null `created_by`, 2025) and has **no cards at all**; `2421cb61` has
cards but no images and no approved quiz.

> ⚠ **Decision before deleting `68a7b180`.** It holds the only substantial quiz in this set:
> three approved questions, against one on the row we keep. Deleting it destroys that quiz
> text. If it is worth keeping, re-point those `quiz_questions` at `b6e7628b`'s segment
> first, then delete. Otherwise accept the loss knowingly.

### Set 2 — "Adapting Routines for a Mobile Baby" (2 rows, **different tracks**, both `[ARCHIVED]`)

| id | created_at | created_by | track | segs / status | cards | quiz Q | priority | age |
|---|---|---|---|---|---|---|---|---|
| `9ee5ffa0` | 2026-07-03 | mark@moosiiapp.com | Baby Is Crawling `[ARCH]` | 1 / `pending` | 0 | 0 | 305 | 6–12 |
| `bded750f` | 2026-07-23 | markmun99@gmail.com | First Steps and Walking `[ARCH]` | 1 / `pending` | 0 | 0 | 300 | 3–9 |

**This set is not a duplicate in the constraint sense** — the rows live in different tracks,
so no `(track_id, lesson_name)` rule would ever have blocked them. Both are **completely
empty stubs**: no cards, no quiz, no images, nothing referencing them.

**Recommendation: a content call, not a cleanup.** Deleting either costs nothing. If one
should survive, `9ee5ffa0` fits better on the facts: 6–12 months matches "a mobile baby",
where the other row's 3–9 months reaches down into pre-crawling. Both tracks are archived, so
this can also just be left alone.

### Set 3 — "Newborn Bathing Basics" (2 rows, both in **New Parents** `[ARCHIVED]`)

| id | created_at | created_by | segs / status | cards | card imgs | quiz Q | approved Q | findings | priority |
|---|---|---|---|---|---|---|---|---|---|
| `4d7af074` | 2026-04-23 | mark@moosiiapp.com | 1 / `pending` | 7 (all draft) | 0 | 2 | 2 | 5 | 600 |
| `7dae9e3e` | 2026-04-24 | mark@moosiiapp.com | 1 / `pending` | **8** (all draft) | **8** | 1 | 1 | 6 | 412 |

**Keep `7dae9e3e`.** Eight cards, every one carrying an image, against seven cards with none.
The one thing lost is a second approved quiz question on `4d7af074`.

### How to delete — use the endpoint, not SQL

`DELETE /lessons/:id` already exists and is the correct path
([src/routes/lessons.ts:303](src/routes/lessons.ts:303), api-contract §2e-del). It purges
images **before** the row delete, because a raw SQL delete does not fire the storage triggers
and would silently orphan storage files and `image_assets` rows. Run each with
`?dry_run=true` first to see the counts.

```bash
# dry run, then real, per id
curl -X DELETE "$API/lessons/68a7b180-201c-40b7-9007-7f4d8be2ef04?dry_run=true" -H "Authorization: Bearer $JWT"
```

**In this specific case raw SQL is also safe**, because every row recommended for deletion has
**zero** `content_images` — so there is nothing to orphan. The content tree is `ON DELETE
CASCADE` all the way down (segments, sub_segments, quiz_*, findings, progress), so one
statement per lesson is sufficient; no manual FK ordering is required.

```sql
-- PRE-CHECK — expect 0 rows. If any row returns, use DELETE /lessons/:id instead.
SELECT ci.id, ci.lesson_id, ci.segment_id, ci.sub_segment_id
FROM content_images ci
LEFT JOIN segments s ON s.id = ci.segment_id
LEFT JOIN sub_segments ss ON ss.id = ci.sub_segment_id
LEFT JOIN segments s2 ON s2.id = ss.seg_id
WHERE ci.lesson_id IN ('68a7b180-201c-40b7-9007-7f4d8be2ef04',
                       '2421cb61-e3a5-4b91-8fd6-698bf53b57f7',
                       '4d7af074-a78e-4981-9061-c9bb04babce4')
   OR s.lesson_id  IN ('68a7b180-201c-40b7-9007-7f4d8be2ef04',
                       '2421cb61-e3a5-4b91-8fd6-698bf53b57f7',
                       '4d7af074-a78e-4981-9061-c9bb04babce4')
   OR s2.lesson_id IN ('68a7b180-201c-40b7-9007-7f4d8be2ef04',
                       '2421cb61-e3a5-4b91-8fd6-698bf53b57f7',
                       '4d7af074-a78e-4981-9061-c9bb04babce4');

-- If (and only if) the pre-check returns nothing, and after deciding the quiz question
-- above. CASCADE handles the whole subtree.
BEGIN;
DELETE FROM lessons WHERE id = '68a7b180-201c-40b7-9007-7f4d8be2ef04';  -- Safe Sleep, 0 cards, 3 approved Q (SEE WARNING)
DELETE FROM lessons WHERE id = '2421cb61-e3a5-4b91-8fd6-698bf53b57f7';  -- Safe Sleep, 9 cards, no images, 0 approved Q
DELETE FROM lessons WHERE id = '4d7af074-a78e-4981-9061-c9bb04babce4';  -- Bathing, 7 cards, no images
-- Set 2 is a content decision, not cleanup. If you want one gone, uncomment ONE:
-- DELETE FROM lessons WHERE id = 'bded750f-e2b8-4479-acf7-1117bef8ad64';
COMMIT;
```

If any statement raises `23503` or `23001`, a FK is `RESTRICT` rather than `CASCADE`; the
error names the table. Clear that child first rather than widening the delete.

**Softer alternative, fully reversible:** instead of deleting, set `archived_at = now()` on
the losing rows. That hides them from every user path (invariant 6) and, with the partial
index proposed in section C, frees the name immediately. Deleting can then happen whenever.

### Aside — two segments carry a stale `complete` status

`147ed2ac` (on `68a7b180`) is `seg_status = 'complete'` with **zero** cards, and `88513ed5`
(on `b6e7628b`) is `complete` with nine cards all in `draft`. Migration 056 made `seg_status`
derived: complete requires at least one card **and** every card `clinically_approved`. Both
rows contradict that, so they predate the derivation and no recompute has run on them since.
This matters for section D, which keys off "the first complete segment". Worth running
`recompute_seg_status()` across the catalog before trusting that column anywhere.

---

## B. Root cause — why a second row appears instead of an update

**There are exactly two paths that create lessons, and both are unconditional INSERTs.**

1. `generate_lessons` — [src/jobs/handlers/generateLessons.ts:252](src/jobs/handlers/generateLessons.ts:252)
2. `POST /lessons/coverage-accept` — [src/routes/lessons.ts:290](src/routes/lessons.ts:290)

Both call the same RPC, `create_lessons_with_segments`
([migrations/010_create_lessons_with_segments_fn.sql:36-46](migrations/010_create_lessons_with_segments_fn.sql:36)),
whose body is a bare `insert into lessons ... select ... from jsonb_populate_recordset`.
There is no `ON CONFLICT`, no existence check, no update branch. It cannot do anything but
add rows.

**The only duplicate protection in the entire path is a sentence in a prompt.** Both handlers
load the track's existing lessons
([generateLessons.ts:133-136](src/jobs/handlers/generateLessons.ts:133),
[coverageAudit.ts:132-135](src/jobs/handlers/coverageAudit.ts:132)) and paste them into the
model's input with the instruction *"do not duplicate or closely overlap these"*
([coverageAudit.ts:101](src/jobs/handlers/coverageAudit.ts:101)). That is LLM judgment, not a
check. When a later run re-proposes a title the model considers new phrasing, nothing between
the model and the table disagrees.

**The evidence matches exactly.** `b6e7628b` (Safe Sleep) and `4d7af074` (Bathing) share a
`created_at` to the microsecond, `2026-04-23T12:56:30.080236Z` — one batch. `7dae9e3e` lands
the next day and `2421cb61` a fortnight later, each a separate run re-proposing a title the
catalog already held.

**`generate_track_content` is not the culprit despite the name.** Its `fill_missing` mode
only *selects* lesson ids ([generateTrackContent.ts:59](src/jobs/handlers/generateTrackContent.ts:59))
and then works on segments. It never inserts a lesson.

### Proposed fix

**There is no lesson UPDATE path in this backend at all.** The `/lessons` routes are generate,
approve, editorial-approve, unapprove, publish, unpublish, coverage-accept and delete. No
`PATCH`. So "update in place, keyed by id" is not a change to an existing path; the path has
to exist first.

The smallest correct fix puts the decision **inside the RPC**, so it is atomic with the
insert and both callers get it for free:

```sql
-- Sketch, NOT drafted as a migration — needs the section C index to exist first.
insert into lessons (lesson_name, description, min_child_age, max_child_age,
                     priority, track_id, topic_id, created_by, ...)
select ... from jsonb_populate_recordset(null::lessons, p_lessons) as l
on conflict (track_id, lesson_name) where archived_at is null
do nothing
returning lessons.id, lessons.lesson_name, ... , true as created;
```

**Recommend `DO NOTHING`, not `DO UPDATE`, for v1.** An update would silently overwrite
curator edits, priority tuning and `curator_note` with fresh model output, and the accept
flow is exactly where a human has just made choices. A skipped stub is a mild annoyance; a
silently rewritten hand-edited lesson is not recoverable. Return a per-proposal outcome
(`created` / `skipped_existing`) so the CMS can say "4 created, 2 already existed" instead of
reporting six creations.

If genuine update-in-place is wanted later, it should be an explicit `PATCH /lessons/:id`
keyed by id, invoked deliberately, not a side effect of accepting a proposal.

Note the RPC already anticipated the shape of this problem: its own comment explains that
segments are paired by identity rather than by name because a name match "mis-pairs when two
lessons in a batch share a name". The within-batch case was handled; the against-the-catalog
case was not.

---

## C. Structural prevention — the uniqueness constraint

**Live shape of the catalog:**

| measure | count |
|---|---|
| lessons total | 153 |
| published | 11 |
| duplicate `lesson_name` groups | 3 |
| of those, same-track | 2 |
| of those, cross-track | 1 |
| `(track_id, lesson_name)` collisions | 2 (5 rows) |

**The same title does legitimately exist in two tracks today** — "Adapting Routines for a
Mobile Baby" in *Baby Is Crawling* and *First Steps and Walking*. That is the only such case
in 153 lessons, and both rows are empty stubs in archived tracks, so it is thin evidence. But
it is the only evidence there is, and it points the same way common sense does: a track is a
curricular context, and "Bedtime Routine" is a reasonable title in both a Sleep track and a
Newborn track.

**So: scope the constraint to the track. A global unique on `lesson_name` would be wrong** —
it forbids a real authoring pattern permanently in order to catch two rows that a narrower
rule already catches.

```sql
-- NOT APPLIED. Add only AFTER the section A duplicates are resolved (deleted or archived),
-- or it will fail with "could not create unique index".
CREATE UNIQUE INDEX CONCURRENTLY lessons_track_name_active_uq
  ON public.lessons (track_id, lesson_name)
  WHERE archived_at IS NULL;
```

**Why partial on `archived_at IS NULL`.** Archival is the shelve-without-deleting mechanism
(invariant 6). A shelved lesson should not hold its title hostage — the whole point of
archiving a weak lesson is to write a better one. The partial index also gives the softer
cleanup route in section A: archive the losers and the index becomes addable immediately,
with deletion deferred indefinitely.

**Two caveats.**

- `lessons.lesson_name` is **nullable**. A unique index treats NULLs as distinct, so any
  number of unnamed lessons remain legal. If that is unwanted, `ALTER COLUMN lesson_name SET
  NOT NULL` is a separate decision; nothing in the current data blocks it, but I have not
  verified every row is non-null.
- The current duplicates are all in **archived tracks**, but the lessons themselves have
  `archived_at IS NULL`. Track archival does not stamp lessons (invariant 6, derived not
  stamped), so the partial index **does not** exempt them. They must be resolved first either
  way.

---

## D. `with_quiz` drift

### What is actually true right now

**All 153 lessons have `with_quiz = true`. Not one has `false`.**

**No code in `src/` ever writes `lessons.with_quiz`.** The single `with_quiz` write anywhere
in the backend is [generateQuestionnaire.ts:297](src/jobs/handlers/generateQuestionnaire.ts:297),
which sets `false` on a **questionnaire** row, a different table. Every other occurrence is a
read on the MLP path.

**Nothing sets it at generation either.** `create_lessons_with_segments` inserts eight columns
and its comment says the rest "keeps its DB default … (abbreviated_title, `with_quiz`,
quiz_onboarding_*)"
([010:33-35](migrations/010_create_lessons_with_segments_fn.sql:33)). So the value is the
column DEFAULT, evidently `true`, and no path has ever set it otherwise. Confirm with:

```sql
SELECT column_name, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'lessons' AND column_name = 'with_quiz';
```

**So it is not really drift — it is a constant that the app trusts as a signal.** Nothing can
ever make it false, and there is no `PATCH /lessons` route through which a human could.

### Why that matters

`with_quiz` rides the whole MLP path into the app: `mlp_item_pool` →
[rebuildMlp.ts:520](src/jobs/handlers/rebuildMlp.ts:520) → `generateFullMLP` →
`user_mlp.with_quiz`. The app uses it to decide whether to offer a quiz. A lesson advertising
a quiz it does not have produces exactly the "app showed no questions" failure already on
record in api-contract §1f.

The duplicates make it concrete: `9ee5ffa0` and `bded750f` have **zero** quiz questions and
both claim `with_quiz = true`; `2421cb61` has two questions, neither approved, and also claims
`true`.

### Proposed publish-time check

A `CHECK` constraint cannot express this — it spans `lessons`, `segments` and `quiz_questions`.
A **trigger can**, and it is the only structural option:

```sql
-- NOT APPLIED. Refuses to publish a lesson that advertises a quiz it does not have.
CREATE OR REPLACE FUNCTION lessons_with_quiz_publish_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_seg_id uuid;
  v_approved int;
BEGIN
  IF NEW.is_published IS DISTINCT FROM true OR NEW.with_quiz IS DISTINCT FROM true THEN
    RETURN NEW;                       -- only guards the publish-a-quiz-lesson case
  END IF;
  IF OLD.is_published IS true THEN
    RETURN NEW;                       -- already published; this is some other update
  END IF;

  -- "First complete segment" — 1:1 lesson:segment today, so this is just "the segment".
  SELECT s.id INTO v_seg_id
  FROM segments s
  WHERE s.lesson_id = NEW.id AND s.seg_status = 'complete'
  ORDER BY s.created_at
  LIMIT 1;

  IF v_seg_id IS NULL THEN
    RAISE EXCEPTION 'cannot publish % with with_quiz=true: no complete segment', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO v_approved
  FROM quiz_questions q
  WHERE q.answer_status = 'approved'
    AND (q.segment_id = v_seg_id OR q.lesson_id = NEW.id);

  IF v_approved < 1 THEN
    RAISE EXCEPTION 'cannot publish % with with_quiz=true: 0 approved questions on segment %',
      NEW.id, v_seg_id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER lessons_with_quiz_publish_guard_trg
  BEFORE UPDATE ON public.lessons
  FOR EACH ROW EXECUTE FUNCTION lessons_with_quiz_publish_guard();
```

**Why a trigger and not just a route guard.** `POST /lessons/:id/publish` is the intended
path, and a 409 there gives a far better message. But a trigger cannot be bypassed by a
Supabase-direct write, and the CMS does write some tables directly. Both is right: the route
returns `409 quiz_missing` naming the lesson, the trigger is the wall behind it. (Migration
057 preferred a privilege REVOKE over a trigger for `seg_status`, but that only works when the
rule is "nobody writes this column"; here the rule is cross-table and conditional, so a
trigger is the only structural form available.)

**Three things to settle before applying it.**

- **It keys off `seg_status`, which is stale on at least two segments** (see the section A
  aside). Run `recompute_seg_status()` across the catalog first, or the guard will refuse a
  publishable lesson and permit an unpublishable one.
- **It will block re-publishing the 11 currently published lessons** if any of them lacks an
  approved question, since the guard fires on the false→true transition. Check first:
  ```sql
  SELECT l.id, l.lesson_name,
         (SELECT count(*) FROM quiz_questions q
           JOIN segments s ON s.id = q.segment_id
          WHERE s.lesson_id = l.id AND q.answer_status = 'approved') AS approved_q
  FROM lessons l WHERE l.is_published = true AND l.with_quiz = true;
  ```
- **The real fix may be to make `with_quiz` mean something.** Since nothing ever sets it
  false, an alternative worth considering is to stop treating it as an authored flag and
  derive it — `with_quiz` becomes "has at least one approved question", computed in
  `mlp_item_pool` the way archival and the age gate already are. That removes the drift class
  entirely instead of guarding one transition. It is a bigger change and touches the pool view
  that every user's plan flows through (invariant 10), so it is a proposal, not a
  recommendation, until you say so.

---

## Summary of what needs a decision

1. **Set 1:** keep `b6e7628b`; decide whether to rescue the three approved quiz questions from
   `68a7b180` before deleting it.
2. **Set 2:** empty stubs in two archived tracks and not a constraint violation. Delete one,
   both, or neither.
3. **Set 3:** keep `7dae9e3e`, delete `4d7af074`.
4. **Cleanup route:** delete, or archive the losers instead (reversible, and enough to unblock
   the index).
5. **Constraint:** confirm `(track_id, lesson_name) WHERE archived_at IS NULL`, and whether
   `lesson_name` should become `NOT NULL`.
6. **RPC:** confirm `ON CONFLICT DO NOTHING` over `DO UPDATE`.
7. **`with_quiz`:** guard the publish transition, or derive the column outright.
