# FINDINGS — "unarchiving a fully-approved lesson cleared its approvals" (2026-09-15)

Investigation only; nothing changed. Moosii was read with psql (read-only); moosii-cms was read,
not edited.

## Answer

**Neither.** The 066 reset trigger cannot fire on `archived_at`. The CMS unarchive path writes
only `archived_at`. No trigger on `lessons` touches review state. Unarchiving cannot clear an
approval.

## Evidence

### 1. The 066 triggers are not on `lessons`, and are column-scoped
`migrations/066_content_edit_review_reset.sql`:
- `:111-114` — `sub_segments_reset_review_trg AFTER INSERT OR DELETE OR UPDATE OF title, content, image, sequence ON sub_segments`
- `:152-155` — `quiz_questions_reset_review_trg AFTER UPDATE OF question_text, question_explanation, image_url, type ON quiz_questions`
- `:159-162` — `quiz_answers_reset_review_trg AFTER INSERT OR DELETE OR UPDATE OF answer_text, is_correct, response, score ON quiz_answers`

Live on Moosii (`pg_trigger`, 2026-09-15), the only triggers on `lessons` are:
| Trigger | Fires on | Effect |
|---|---|---|
| `content_edit_policy_guard_trg` (064) | AFTER UPDATE OF `description, safety_sensitive` | guard only; not `archived_at` |
| `lessons_force_derived_with_quiz_trg` (063) | BEFORE INSERT OR UPDATE | overwrites `NEW.with_quiz` only (063 `:179-191`); writes nothing else |
| `set_updated_at_trigger` | BEFORE UPDATE | stamps `updated_at` |

None writes `sub_segments.review_state`, `segments.seg_status` or `quiz_questions.answer_status`.

### 2. The CMS unarchive path touches no content column
- `moosii-cms/src/data/lessons.ts:364-376` — `useSetLessonArchived` does
  `.from('lessons').update({ archived_at: archived ? … : null }).eq('id', id)`, then only
  cache invalidation (`invalidateLessonEverywhere`, `:332-337`, which is React Query keys, no writes).
- `moosii-cms/src/pages/LessonDetail.tsx:357` — the Unarchive button calls exactly that mutation.
  It is the only lesson unarchive path in the CMS (`LessonsList.tsx` only displays the badge).
- The backend has no archive route. `archived_at` appears in `src/` only as a read filter
  (`src/lib/classifyCatalog.ts:39`).

### 3. The approvals were already gone before today
The recently published lesson matching the report is **"Getting enough sleep"** (`da772f32…`).
It is the only lesson with that name, and Mark did not name the lesson, so this match is an
inference.
- **`migrations/065_lessons_review_status_view.sql:138-143`** — the read-only live probe on
  **2026-09-11** recorded this lesson as `published_unreviewed` with **9 cards awaiting editorial**,
  i.e. every card already `draft` four days before the unarchive.
- `content_approvals` for its segment `0c676835…` (the log starts 2026-07-25) has no approval
  before today, and no `unapprove` row at all:
  `editorial_approve 13:56:54 · clinical_approve 13:56:58 · editorial_approve 13:58:32 · clinical_approve 13:58:37 · lesson publish 14:00:06`.
- Live now: all 9 cards `clinically_approved`, `seg_status='complete'`, quiz question `approved`, published.

So what Mark saw after unarchiving was the lesson's existing state (all cards back in draft since
at least 09-11), shown once it reappeared in the live list. The badge reads
`segments.seg_status` (`moosii-cms/src/pages/LessonDetail.tsx:216`) plus card review state (`:220`).

## Not provable from the data

- **What reset the cards before 09-11.** Candidates are a CMS-direct card edit or reorder, or a
  backend card write. A 066 reset leaves no audit row. `sub_segments` has no `updated_at` stamp
  trigger (all 9 cards have `updated_at` NULL and `updated_by` NULL). The backend reset path
  (`src/lib/cardReview.ts:54-61`) does not log to `content_approvals` either. The 09-11 state
  would predate 066 (applied 09-11), so it was more likely a backend reset
  (`src/routes/subSegments.ts:120,274`) or a regen.
- **Why approval ran twice (13:56 and 13:58).** It could be a second reset in between or just a
  repeat click. The editorial route logs even when it moves zero cards
  (`src/routes/lessons.ts:164-165`, `fromState='draft'`), so the log cannot tell the two apart.

## Follow-ups (not done)

Items 1 and 2 are backlogged as P3 in `docs/backlog.md` (2026-09-15).

1. A card or quiz reset leaves no trace of when or why. A `content_approvals` row (action
   `review_reset`, actor null or from the JWT) written from `sub_segments_reset_review` /
   `quiz_reset_review`, and from `resetCardsAndReport`, would have answered this in one query.
2. Approve routes log a row even when nothing moved. Logging only when `cards_updated > 0`
   would make the log trustworthy for questions like this one.
3. For moosii-cms (flag only): an Unarchive confirmation that shows the lesson's current review
   state would stop a pre-existing reset looking like an effect of the unarchive.
