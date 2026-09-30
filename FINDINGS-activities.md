# FINDINGS — "activity" items in the plan (both domains)

2026-09-30 · Investigate-first · no DDL, no code. Both projects read in read-only transactions; moosii-cms,
moosii-rn and moosii-reader read-only.

**The idea (Mark):** the plan recommends things to *do*, not only lessons to read, e.g. "Set a reminder 3 days
before your statement date" (financial), "5 minutes of tummy time after the next nap" (Moosii). **Preferred
shape:** an activity *is* a lesson with a kind flag, so the MLP, pool, approvals and publishing don't change.

## TL;DR

- **Yes, it works as a lesson flag without touching the MLP.** `lessons.kind text NOT NULL DEFAULT 'lesson'
  CHECK (kind IN ('lesson','activity'))`, on both projects. `generateFullMLP` / `computeUserMlp` never look
  at lesson columns beyond the pool's fixed list. `mlp_item_pool` selects explicit columns (checked: no `*`),
  so it's unchanged and an activity rides the pool as `item_type='lesson'`. **Nothing to flag on invariants
  1 and 8** as long as `kind` stays *out* of the pool, `user_mlp` and the algorithm. Clients read `kind` from
  `lessons` by `item_id`, which the RN app already does for descriptions.
- **Precedent:** `questionnaire.kind` (`diagnostic | checkin`, `CHECK`, default `diagnostic`) is the same
  pattern, already delivered. The mixing pattern is also precedent: questionnaires sit in the same path via
  `item_type`.
- **Content:** why + 2–4 steps + one "do it now" fits the existing role-by-position `card_positions` block
  (first = why, body = steps, takeaway = the action). **No activity variant of the shared block is needed**
  (invariant 2 untouched). The difference goes in a separate STRUCTURE block and a smaller SIZE profile,
  both per-run overridable already.
- **Completion ("Done"):** the RN app already writes `completed_items` + `user_lesson_progress` directly,
  and an activity completes the same way. The reader writes nothing today; a "Done" button there would
  make the same two writes with the demo user's session. ⚠ **But those two tables have a write gap**
  (below) that should close first.
- **⚠ Security gap found (both projects):** `completed_items` and `user_lesson_progress` each have an
  extra permissive policy `"Enable insert for authenticated users only" … WITH CHECK (true)`, and
  `user_lesson_progress` also has `"Enable read access for all users" … USING (true)` for authenticated.
  Permissive policies OR together, so **any signed-in user can insert a completion or progress row for
  ANY user, and read everyone's lesson progress.** With public demo sign-in live, that's reachable from
  the reader. A one-migration fix (drop the two `CHECK true` / `USING true` policies; the own-row policies
  already cover the app). Recommended before any "Done" button ships.
- **"Verified by data" (later):** an activity can declare the fact transition that proves it (e.g.
  `has_direct_deposit false→true`). A check after each `derive_facts` run auto-completes it. It works for
  3 of the 4 derived facts, and only for **derived** facts, never seeded ones.
- **Moosii:** same flag, same clinical approval and `safety_sensitive`. Completion is confirmed by a
  **check-in** answer, via a new `questionnaire_answer_actions.action_type = 'complete_activity'`
  alongside the existing `record_milestone`.
- **Demo slice:** one hand-authored activity in Credit Health after "Paying Before the Statement Date".
  Migration (kind + an anon column grant) → author in the CMS → reader shows a "Do" badge. Smallest version:
  no "Done" button, no verification.

## 1. Can a kind flag avoid the MLP? How questionnaires already mix in

**Path of an item into the plan** (unchanged by this proposal):
- `mlp_item_pool` (view) = `lessons` (published or not, `archived_at IS NULL`) **UNION ALL** `questionnaire`,
  with an explicit column list: `item_id, item_type ('lesson' | 'questionnaire'), track_id, priority,
  item_name, item_description, min_child_age, max_child_age, is_published, with_quiz`. Checked: no `*`,
  so a new `lessons` column doesn't appear in it.
- `rebuildMlp.ts:506` reads that list; `generateFullMLP` (`src/mlp/generateFullMLP.ts`) orders by track
  priority / weight / item priority only; `user_mlp` stores `item_id, item_type, …` (no lesson-specific
  columns beyond name, description, `with_quiz`).
- `user_mlp_not_completed` anti-joins `completed_items` on `(user_id, item_id, item_type)`.

**So:** an activity is a lesson row with `kind='activity'`. It enters the pool as `item_type='lesson'`,
gets ordered like any lesson, and leaves the plan when a `completed_items` row exists. **No change to
`generateFullMLP` / `computeUserMlp`, `mlp_item_pool`, `user_mlp`, `user_active_tracks_for_user`**
(invariants 1, 8).

**Don't** add `kind` to the pool or `user_mlp` "for convenience". That touches every user's plan
(invariant 8), needs `rebuildMlp` + type changes, and buys nothing: every client that renders a plan item
already has its `item_id` and can read `lessons.kind` (RN: `useUpcomingMlp.ts:49` already fetches
`lessons (id, description)` by id; add `kind` to that select).

**Why not a third `item_type` ('activity')?** It would need its own pool arm, its own completion semantics
and a change to the anti-join, touching invariant 8 for no gain. The flag keeps activities *lessons* for
approval, publishing, archival, images and review.

**Precedent for the flag itself:** `questionnaire.kind text DEFAULT 'diagnostic' CHECK (kind IN
('diagnostic','checkin'))`, delivered, with the CMS listing each kind separately (`moosii-cms` routes
`/questionnaires` vs `/checkins`).

## 2. Schema, display, completion

**Migration (both projects, schema only), proposed:**
```sql
ALTER TABLE public.lessons ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'lesson';
ALTER TABLE public.lessons ADD CONSTRAINT lessons_kind_valid CHECK (kind IN ('lesson', 'activity'));
-- financial only: the anon reader reads lessons through column grants (096/097)
DO $$ BEGIN
  IF (SELECT value FROM app_settings WHERE key = 'domain') = 'financial' THEN
    GRANT SELECT (kind) ON public.lessons TO anon;
  END IF;
END $$;
```
- Every existing row becomes `'lesson'`; no backfill.
- `authenticated` has table-level SELECT, so signed-in reads get `kind` automatically. 103's policies are
  unaffected.
- Moosii's anon column grants are a broad legacy set; leave them, since the reader isn't on Moosii.
- `create_lessons_with_segments` inserts an explicit column list, so generated stubs stay `'lesson'`. That's
  right for the generator. Making activities through the generator later means adding `kind` to that list
  (DROP-free `CREATE OR REPLACE`; same return type).
- Regenerate `database.types.ts` after the Moosii apply.

**Who reads `kind`:**
- **Reader (financial):** `src/data/useLesson.ts:88` reads `lessons`. Add `kind` → show a "Do" badge and
  "Done" wording. The plan view (when built) reads `user_mlp_not_completed` + `lessons.kind` by id.
- **RN:** `useUpcomingMlp.ts:49` / `useLesson.ts:24`. Add `kind` to the select; badge in the plan list and
  the lesson screen.
- **CMS:** `src/data/lessons.ts:47` `LESSON_COLUMNS`. Add `kind`; a kind selector on create/edit and a
  filter in the list (the `/questionnaires` vs `/checkins` split is the model).

**Completion ("Done"):**
- **RN (both domains), today, for lessons:** `useCompleteLesson.ts` → upsert `user_lesson_progress`, insert
  `completed_items (item_type 'lesson', item_id = lesson_id, …)`. The `trigger_add_moosies` trigger awards
  `moosi_to_add`. An activity's "Done" is **the same call**, and the plan anti-join drops it.
- **Reader (financial):** writes nothing today. A "Done" button would make the same two writes with the
  demo user's session (own-row policies allow it). Alternatively a tiny backend route; either works. Direct
  writes mirror the app and need no new endpoint.
- ⚠ **Close the gap first** (one migration, both projects):
  ```sql
  DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.completed_items;      -- CHECK (true)
  DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.user_lesson_progress; -- CHECK (true)
  DROP POLICY IF EXISTS "Enable read access for all users"          ON public.user_lesson_progress; -- USING (true)
  ```
  The remaining `completed_items_ins` / `ulp_ins` (own row, super_admin, service) and `ulp_sel` / `completed_items_sel`
  keep the app working. That needs a rolled-back persona simulation like 102/103 before applying.

## 3. Content shape for an activity

**Shape:** 3–5 cards: (1) **why** it matters for this reader; (2–4) **steps**, 2–4 of them, one per card
or grouped; (last) **do it now**: the single concrete action, phrased as something to do today.
No quiz (`with_quiz` is derived and stays false unless a question is approved; invariant 10).

**`card_positions` (shared block; invariant 2):** it's role-by-position (first / body / takeaway from
`sequence`), shared by every segment-generation prompt and the reviewer. Activities map onto it directly:
first = why, body = steps, takeaway = the action. **No activity variant is needed, and none should be
made:** a second card-positions block would split generation from review. ⚠ Any wording change to the
shared block affects every lesson and the reviewer on both projects; not proposed.

**Where the difference goes:** the STRUCTURE layer (`prompt_blocks` `block_type='structure'`, reusable
library) and the SIZE layer (`content_size_profiles`). Add an `activity_steps` structure block ("one card of
why, then 2–4 numbered, concrete steps, ending in a do-it-today card") and a small size profile (3–5 cards).
`regen_segment_content` already supports per-run overrides of structure and size, so an activity can be
generated with the existing tone plus these two overrides. No new prompt row, no code. For the demo slice
it's hand-authored anyway. Tone rules still apply (financial: no amounts).

## 4. "Verified by data" (later, not now)

Link an activity to the fact transition that proves it was done, and auto-complete it when a new
**derived** observation shows that transition.

```sql
-- proposed, not now
CREATE TABLE public.activity_fact_goals (
  lesson_id uuid PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,   -- kind must be 'activity'
  fact_key text NOT NULL, from_value text NOT NULL, to_value text NOT NULL,
  FOREIGN KEY (fact_key, from_value) REFERENCES fact_values (fact_key, value),
  FOREIGN KEY (fact_key, to_value)   REFERENCES fact_values (fact_key, value)
);  -- RLS on, admin write, signed-in read
```
**Mechanism:** after `derive_facts` writes, for each activity in the user's plan with a goal: if the
latest **derived/estimated** value equals `to_value` and an earlier observation had `from_value`, insert
the `completed_items` row (service role) and let the rebuild drop it. **Seeded rows never verify
anything.** `completed_items` has no source column, so a verified completion should be distinguishable;
that would need a small `completed_items.source` addition, or a separate `activity_verifications` log.

**Which current facts can support it:**

| Fact | Transition | Activity it could verify | Verdict |
|---|---|---|---|
| `has_direct_deposit` | false → true | "Set up direct deposit into your checking account" | **good**: a clear, bank-visible event |
| `has_emergency_buffer` | false → true | "Schedule an automatic transfer on payday" (the buffer eventually crosses a month) | **good but slow**: weeks later, many causes |
| `credit_utilization_band` | high → moderate / low | "Pay the card down before the statement date" | **good**: next statement shows it |
| `new_subscription_recent` | true → false | "Cancel a subscription you don't use" | **weak**: `false` means "no *new* subscription in 30 days", not "cancelled"; it flips on its own after 30 days. Needs a better fact first |

"Set a reminder 3 days before your statement date" has **no bank-visible signal**. It completes by the
user's "Done" only.

## 5. Slice plan: the smallest demo version

Goal: Sam's plan shows an activity right after "Paying Before the Statement Date", with a "Do" badge.

| # | What | Who | Notes |
|---|---|---|---|
| 1 | Migration: `lessons.kind` + CHECK, both projects; `GRANT SELECT (kind)` to anon on financial | backend | financial first; `database.types.ts` regen |
| 2 | Author **"Set a Statement-Date Reminder"** (`kind='activity'`, Credit Health, priority 250, so it sorts after "Paying Before the Statement Date" (200) and before the ratio lesson (300); topic `credit`). 3–4 cards: why / set it / what to do when it fires. Publish. | Mark (CMS) | until the CMS has a kind field: create normally, then set `kind` via a guarded one-row update (backend) |
| 3 | Rebuild Sam; check the live path | backend | expected: Maxed Out → Paying Before → **Set a Statement-Date Reminder** → Ratio |
| 4 | Reader: read `kind`, show "Do" badge + "Done"-style wording | moosii-reader seat | no completion write yet |
| later | "Done" button (after the policy-gap fix); CMS kind selector; activity structure block + size profile; verification (§4) | | |

Note the round-robin: with Getting Oriented already completed, Sam's plan is Credit Health only, so the
activity lands exactly where its priority puts it.

## 6. Both domains

The schema is shared (invariant 4), so the flag is designed for Moosii too.

| | Financial | Moosii (parenting) |
|---|---|---|
| Example | "Set a reminder 3 days before your statement date" | "5 minutes of tummy time after the next nap" |
| Flag, pool, MLP | same: `lessons.kind`, `item_type='lesson'`, no algorithm change | same |
| Approval | editorial → clinical as today (card `review_state`, `seg_status`, publish) | **same two-stage approval, clinical sign-off required** (it's instructions to act on a baby) |
| `safety_sensitive` | per the financial rule (advice-like, product categories) | **must be honored**: an activity is *more* likely to be safety-relevant (sleep, feeding, handling); default the flag on for activities until reviewed |
| Age gating | n/a (financial users are zero-child) | `min_child_age` / `max_child_age` apply exactly as for lessons; tummy time must never reach the wrong age |
| Completion | "Done" (user), later **verified by derived facts** (§4) | "Done" (user), later **confirmed by a check-in** |
| Verification mechanism | `activity_fact_goals` + `derive_facts` | extend `questionnaire_answer_actions.action_type` (CHECK today: `add_track | add_tag | record_milestone`) with **`complete_activity`** + a `lesson_id` column (the CHECK pattern already requires exactly one target per type). A check-in answer "Yes, we did tummy time" then writes the `completed_items` row, the same way `record_milestone` writes milestones (`src/mlp/recordCheckinMilestones.ts`) |
| Distress / classify (invariant 11) | n/a | unchanged; an activity never replaces a distress response |
| Anon reader grant | `GRANT SELECT (kind)` to anon | none needed |

Nothing else differs. The migration is the same file on both projects, apart from the financial-only grant.

## Not done / flagged
- The `completed_items` / `user_lesson_progress` open policies (§2): recommend fixing before any "Done"
  button, and soon regardless, since demo sign-in is public.
- The CMS kind selector and list filter are moosii-cms seat work; the reader badge is moosii-reader seat work.
