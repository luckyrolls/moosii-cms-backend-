# FINDINGS — the 85 view columns that became never-null in `database.types.ts`

**Question (Mark, 2026-11-19):** commit `8712b7d` regenerated `src/types/database.types.ts` with a
newer Supabase CLI, and 85 view columns across 28 views **lost their `| null`**. For each: could
the view actually produce NULL, and how many NULLs exist on each project?

**Answer: no, none of the 85 can produce NULL, and none does.** Read-only on both projects,
2026-11-20. Every one of the 85 resolves to a **NOT NULL base-table column on the preserved side
of every join in its view**, and a direct count found **0 NULLs in all 85 columns on both
projects**. The narrowing in `8712b7d` was a genuine precision gain, not a regression — the types
are now right where they were previously pessimistic. **Nothing to fix.**

Method: parse the generated file for view columns typed without `| null` (85 across 28 views);
`pg_get_viewdef` for all 35 views to establish each column's base column and the join shape;
`information_schema.columns` for the base columns' `is_nullable`; then one single-scan count per
view (`count(*)` vs `count(col)`) on each project. All inside
`BEGIN TRANSACTION READ ONLY; … ROLLBACK;`.

## Two traps this audit hit, worth not repeating

1. **`groups` is a VIEW, not a table.** Looking its columns up in `information_schema.columns`
   returned the view's, and **a view's columns are always reported `is_nullable = YES`** — which
   made `groups.id` and `groups.created_at` look nullable and produced 6 false positives. The real
   base is `groups_data`, where both are NOT NULL. `user_groups` is a view over the `groups` view
   over `groups_data`; both are `security_invoker`, so the base-table policies still bind
   (CLAUDE.md's nested-view trap).
2. **An empty view proves nothing.** Six of the 28 are empty on *both* projects, so for their 14
   columns the count is not evidence and only the structural argument carries:
   `completed_items_streak`, `friends_with_user_ids`, `lesson_questions`,
   `starred_items_with_details`, `user_track_details`, `v_lesson_tag_details`.

## Is the generator trustworthy about this?

The relevant question is whether it ignores outer joins — the classic way to type a column non-null
that a LEFT JOIN can null out. **It does not.** Spot-checked four views that expose NOT NULL base
columns through the *nullable* side of a LEFT JOIN, and in every case the generated type still
carries `| null`: `completed_items_with_tags.lesson_name` (`lessons.lesson_name` NOT NULL, LEFT
JOINed), `starred_items_with_details.lesson_name` / `.tag_name`, `questionnaire_with_track_name.
track_name`, and the `user_segement_track` columns in `user_segment_progress`. No view in the
schema uses a FULL JOIN, which is the other shape that would break the inference.

So the 85 are non-null because of what those views expose, and the generator reasoned about it
correctly — not by luck.

## Residual risk (not a defect today)

Nullability here is a property of the **current** schema. `ALTER TABLE … DROP NOT NULL` on one of
the base columns below, or a view edit that moves one of these to the nullable side of a join, makes
the committed type silently wrong until someone runs `npm run gen:types`. That is the existing
convention's job (regenerate after any schema migration, CLAUDE.md), and this audit is the
baseline it is measured against.

## The join shape per view

| view | never-null cols | preserved relation | join shape |
|---|---:|---|---|
| `completed_items_streak` | 1 | `completed_items` | inner only (subquery + GROUP BY) |
| `completed_items_with_tags` | 3 | `completed_items ci` | ci preserved; LEFT JOIN lessons, questionnaire |
| `friends_with_user_ids` | 2 | `friends` | no join |
| `groups` | 2 | `groups_data g` | g preserved; LEFT JOIN group_member |
| `lesson_questions` | 4 | `lessons / segments / questions_legacy` | inner joins only |
| `lesson_segment_counts_with_track` | 4 | `lessons` | lessons preserved; LEFT JOIN segments, INNER tracks |
| `lessons_review_status` | 2 | `lessons l` | no join (correlated EXISTS only) |
| `lessons_with_track_name` | 3 | `lessons` | INNER JOIN tracks |
| `questionnaire_response_with_track_tag` | 3 | `questionnaire_response qr` | qr preserved; LEFT JOIN tracks, tags |
| `questionnaire_user_score` | 2 | `questionnaire_user_answers qua` | no join + GROUP BY |
| `questionnaire_with_track_name` | 4 | `questionnaire q` | q preserved; LEFT JOIN tracks |
| `starred_items_with_details` | 2 | `starred_items si` | si preserved; 4 LEFT JOINs |
| `sub_segment_image_fallback` | 2 | `sub_segments ss / lessons l` | inner joins only |
| `sub_segments_image_fallback` | 2 | `sub_segments ss / lessons l` | inner joins only |
| `suggested_groups` | 3 | `groups_data g / "user" u` | CROSS JOIN (inner); LEFT JOIN group_member |
| `user_active_tracks` | 1 | `tracks t` | final INNER JOIN tracks, after the UNION/EXCEPT set algebra |
| `user_active_tracks_with_reason` | 1 | `tracks t (via user_active_tracks)` | uat preserved; LEFT JOINs for the reason |
| `user_activity_followups_due` | 7 | `user_activity_followups f / lessons l` | inner joins + CROSS JOIN a set-returning function |
| `user_facts_latest` | 6 | `user_facts uf` | no join (DISTINCT ON) |
| `user_groups` | 4 | `groups_data (via the groups view) / group_member gm` | INNER JOIN; nested view, both security_invoker |
| `user_mlp_data` | 1 | `"user" u` | u preserved; LEFT JOIN child_info |
| `user_mlp_not_completed` | 7 | `user_mlp u` | u preserved; 3 LEFT JOINs, then INNER user_configurations |
| `user_mlp_not_completed_limited` | 7 | `user_mlp u` | u preserved; LEFT JOIN completed_items + CROSS JOIN consts |
| `user_segment_progress` | 1 | `segments s` | s preserved; LEFT JOIN user_segement_track |
| `user_track_details` | 4 | `user_tracks ut / tracks t` | INNER JOIN tracks |
| `v_lesson_details` | 3 | `lessons l / tracks t` | INNER tracks; LEFT JOIN lesson_tags + GROUP BY |
| `v_lesson_tag_details` | 1 | `tags t` | INNER JOIN tags |
| `v_segment_details` | 3 | `segments s / lessons l` | INNER JOIN lessons |

## The counts — 85 columns, 0 NULLs, both projects

| view | column | Moosii rows | Moosii NULLs | financial rows | financial NULLs |
|---|---|---:|---:|---:|---:|
| `completed_items_streak` | `user_id` | 0 | **0** | 0 | **0** |
| `completed_items_with_tags` | `completed_item_id` | 14 | **0** | 1 | **0** |
| `completed_items_with_tags` | `user_id` | 14 | **0** | 1 | **0** |
| `completed_items_with_tags` | `with_quiz` | 14 | **0** | 1 | **0** |
| `friends_with_user_ids` | `created_at` | 0 | **0** | 0 | **0** |
| `friends_with_user_ids` | `id` | 0 | **0** | 0 | **0** |
| `groups` | `created_at` | 132 | **0** | 0 | **0** |
| `groups` | `id` | 132 | **0** | 0 | **0** |
| `lesson_questions` | `created_at` | 0 | **0** | 0 | **0** |
| `lesson_questions` | `id` | 0 | **0** | 0 | **0** |
| `lesson_questions` | `parent_lesson_id` | 0 | **0** | 0 | **0** |
| `lesson_questions` | `parent_segment_id` | 0 | **0** | 0 | **0** |
| `lesson_segment_counts_with_track` | `created_at` | 155 | **0** | 13 | **0** |
| `lesson_segment_counts_with_track` | `id` | 155 | **0** | 13 | **0** |
| `lesson_segment_counts_with_track` | `lesson_name` | 155 | **0** | 13 | **0** |
| `lesson_segment_counts_with_track` | `with_quiz` | 155 | **0** | 13 | **0** |
| `lessons_review_status` | `lesson_id` | 155 | **0** | 13 | **0** |
| `lessons_review_status` | `lesson_name` | 155 | **0** | 13 | **0** |
| `lessons_with_track_name` | `created_at` | 155 | **0** | 13 | **0** |
| `lessons_with_track_name` | `id` | 155 | **0** | 13 | **0** |
| `lessons_with_track_name` | `lesson_name` | 155 | **0** | 13 | **0** |
| `questionnaire_response_with_track_tag` | `add` | 2 | **0** | 0 | **0** |
| `questionnaire_response_with_track_tag` | `created_at` | 2 | **0** | 0 | **0** |
| `questionnaire_response_with_track_tag` | `id` | 2 | **0** | 0 | **0** |
| `questionnaire_user_score` | `questionnaire_id` | 3 | **0** | 0 | **0** |
| `questionnaire_user_score` | `user_id` | 3 | **0** | 0 | **0** |
| `questionnaire_with_track_name` | `created_at` | 3 | **0** | 0 | **0** |
| `questionnaire_with_track_name` | `id` | 3 | **0** | 0 | **0** |
| `questionnaire_with_track_name` | `kind` | 3 | **0** | 0 | **0** |
| `questionnaire_with_track_name` | `track_id` | 3 | **0** | 0 | **0** |
| `starred_items_with_details` | `item_id` | 0 | **0** | 0 | **0** |
| `starred_items_with_details` | `starred_item_id` | 0 | **0** | 0 | **0** |
| `sub_segment_image_fallback` | `lesson_name` | 505 | **0** | 80 | **0** |
| `sub_segment_image_fallback` | `sub_segment_id` | 505 | **0** | 80 | **0** |
| `sub_segments_image_fallback` | `lesson_name` | 505 | **0** | 80 | **0** |
| `sub_segments_image_fallback` | `sub_segment_id` | 505 | **0** | 80 | **0** |
| `suggested_groups` | `created_at` | 35 | **0** | 0 | **0** |
| `suggested_groups` | `id` | 35 | **0** | 0 | **0** |
| `suggested_groups` | `user_id` | 35 | **0** | 0 | **0** |
| `user_active_tracks` | `weight` | 13 | **0** | 18 | **0** |
| `user_active_tracks_with_reason` | `weight` | 13 | **0** | 18 | **0** |
| `user_activity_followups_due` | `asks` | 2 | **0** | 0 | **0** |
| `user_activity_followups_due` | `created_at` | 2 | **0** | 0 | **0** |
| `user_activity_followups_due` | `id` | 2 | **0** | 0 | **0** |
| `user_activity_followups_due` | `lesson_id` | 2 | **0** | 0 | **0** |
| `user_activity_followups_due` | `lesson_name` | 2 | **0** | 0 | **0** |
| `user_activity_followups_due` | `user_id` | 2 | **0** | 0 | **0** |
| `user_activity_followups_due` | `verify_mode` | 2 | **0** | 0 | **0** |
| `user_facts_latest` | `fact_key` | 0 | **0** | 7 | **0** |
| `user_facts_latest` | `observation_id` | 0 | **0** | 7 | **0** |
| `user_facts_latest` | `observed_at` | 0 | **0** | 7 | **0** |
| `user_facts_latest` | `source` | 0 | **0** | 7 | **0** |
| `user_facts_latest` | `user_id` | 0 | **0** | 7 | **0** |
| `user_facts_latest` | `value` | 0 | **0** | 7 | **0** |
| `user_groups` | `created_at` | 1 | **0** | 0 | **0** |
| `user_groups` | `id` | 1 | **0** | 0 | **0** |
| `user_groups` | `member_role` | 1 | **0** | 0 | **0** |
| `user_groups` | `member_user_id` | 1 | **0** | 0 | **0** |
| `user_mlp_data` | `user_id` | 11 | **0** | 3 | **0** |
| `user_mlp_not_completed` | `created_at` | 60 | **0** | 29 | **0** |
| `user_mlp_not_completed` | `item_id` | 60 | **0** | 29 | **0** |
| `user_mlp_not_completed` | `item_name` | 60 | **0** | 29 | **0** |
| `user_mlp_not_completed` | `item_type` | 60 | **0** | 29 | **0** |
| `user_mlp_not_completed` | `track_id` | 60 | **0** | 29 | **0** |
| `user_mlp_not_completed` | `user_id` | 60 | **0** | 29 | **0** |
| `user_mlp_not_completed` | `with_quiz` | 60 | **0** | 29 | **0** |
| `user_mlp_not_completed_limited` | `created_at` | 101 | **0** | 29 | **0** |
| `user_mlp_not_completed_limited` | `item_id` | 101 | **0** | 29 | **0** |
| `user_mlp_not_completed_limited` | `item_name` | 101 | **0** | 29 | **0** |
| `user_mlp_not_completed_limited` | `item_type` | 101 | **0** | 29 | **0** |
| `user_mlp_not_completed_limited` | `track_id` | 101 | **0** | 29 | **0** |
| `user_mlp_not_completed_limited` | `user_id` | 101 | **0** | 29 | **0** |
| `user_mlp_not_completed_limited` | `with_quiz` | 101 | **0** | 29 | **0** |
| `user_segment_progress` | `segment_id` | 169 | **0** | 13 | **0** |
| `user_track_details` | `track_id` | 0 | **0** | 0 | **0** |
| `user_track_details` | `user_id` | 0 | **0** | 0 | **0** |
| `user_track_details` | `user_track_id` | 0 | **0** | 0 | **0** |
| `user_track_details` | `weight` | 0 | **0** | 0 | **0** |
| `v_lesson_details` | `lesson_id` | 155 | **0** | 13 | **0** |
| `v_lesson_details` | `lesson_name` | 155 | **0** | 13 | **0** |
| `v_lesson_details` | `track_id` | 155 | **0** | 13 | **0** |
| `v_lesson_tag_details` | `tag_id` | 0 | **0** | 0 | **0** |
| `v_segment_details` | `created_at` | 155 | **0** | 13 | **0** |
| `v_segment_details` | `id` | 155 | **0** | 13 | **0** |
| `v_segment_details` | `lesson_name` | 155 | **0** | 13 | **0** |

---

# Follow-up: the three columns moosii-rn uses without a null guard

**Added 2026-11-24** on a second INVESTIGATE-ONLY brief. Read-only on both projects; the server's
`CURRENT_DATE` reads **2026-11-25** (UTC), which matters for §F.3. Identity confirmed first.

## F.1 Two of the three named columns are **not** among the 85

| column | regenerated type | in the 85? |
|---|---|---|
| `completed_items_streak.streak_dates` | `string[] \| null` | **no** |
| `completed_items_streak.max_unique_weekday_streak` | `number \| null` | **no** |
| `completed_items_streak.weekday_names` | `string[] \| null` | no |
| `completed_items_streak.user_id` | `string` | yes — the view's only never-null column |
| `user_mlp_not_completed.item_id` | `string` | **yes** |

For two of the three the premise does not hold: the CLI typed them **nullable**, correctly — it
cannot reason about aggregates, and it did not try. **moosii-rn is calling `.map()` on a value its
own generated types already declare nullable** (`useStreak.ts:39-40`). That is a type-safety gap in
that repo, not a regression from `8712b7d`. Flagged for the moosii-rn seat; not editable here.

## F.2 `user_mlp_not_completed.item_id` — non-null by construction, safe as a React key

`pg_get_viewdef`, abbreviated:

```sql
WITH ranked AS (
  SELECT u.user_id, u.item_id, …, row_number() OVER (…) AS rn
    FROM user_mlp u
    LEFT JOIN completed_items ci ON u.user_id=ci.user_id AND u.item_id=ci.item_id AND u.item_type=ci.item_type
    LEFT JOIN lessons l       ON u.item_type='lesson'        AND u.item_id=l.id
    LEFT JOIN questionnaire q ON u.item_type='questionnaire' AND u.item_id=q.id
   WHERE ci.id IS NULL)
SELECT r.user_id, r.item_id, …, t.label AS topic_label, t.color AS topic_color, r.rn
  FROM ranked r
  JOIN user_configurations uc ON r.user_id = uc.user_id
  LEFT JOIN topics t ON r.topic_id = t.id
 WHERE r.rn <= uc.mlp_limit ORDER BY r."position";
```

* `user_mlp` is a **TABLE** (`relkind = 'r'`, checked on both projects — not the `groups` trap from
  the original audit), and `item_id` is **NOT NULL** on both, as are `user_id`, `item_type`,
  `track_id`, `item_name`, `with_quiz` and `created_at` — exactly this view's seven never-null
  columns.
* `u` is the **preserved** side of all three LEFT JOINs, so none can null it out.
* The final `JOIN user_configurations` is an **inner** join: it can only **drop** rows, never null
  the preserved side's columns. Same for `WHERE r.rn <= uc.mlp_limit`.

Live NULL counts, all seven columns: **0 of 64 rows (Moosii), 0 of 29 (financial)**; and 0 of 105 /
29 rows in the `user_mlp` base table. **`item_id` cannot be NULL. `useUpcomingMlp.ts:77-78` is
safe.**

## F.3 Can a user with zero completions get a row with NULL `streak_dates`?

**No — they get no row at all.** And the real hazard is worse than a NULL would have been.

```sql
-- the view's final SELECT
SELECT l.user_id,
       count(*)                                             AS max_unique_weekday_streak,
       array_agg(l.completion_day  ORDER BY l.created_at)    AS weekday_names,
       array_agg(l.completed_date ORDER BY l.completed_date) AS streak_dates
  FROM latest_streak_days l
 GROUP BY l.user_id;
```

1. **Zero completions → no row.** The CTE chain begins `FROM completed_items` and every step is an
   inner join or a `GROUP BY` over it. `GROUP BY l.user_id` emits one row per user *present in*
   `latest_streak_days`; a user with no completions appears nowhere. There is no `"user"` table in
   the view at all, so no outer join could manufacture a NULL row.
2. **When a row does exist, none of these columns can be NULL.**
   * `max_unique_weekday_streak` is `count(*)`, which under `GROUP BY` is >= 1 and never NULL.
   * `weekday_names` / `streak_dates` are `array_agg` with **no `FILTER` clause**, so the group is
     never empty and the array is never NULL. (A `FILTER` matching nothing *would* return NULL —
     the classic trap — and there isn't one.)
   * Their **elements** cannot be NULL either: `completed_items.created_at` and `.user_id` are
     **NOT NULL** on both projects, so `date(created_at)` and `TRIM(to_char(created_at,'Day'))` are
     always defined.
3. **⚠ The actual failure mode is the recency filter, and it is firing on 100% of users today.**
   `latest_streak_days` keeps only streaks whose `max_date` is `CURRENT_DATE` or
   `CURRENT_DATE - 1 day`. A user who completed something last week gets **no row**:

   | | users with completions | users with a streak row | completions but **no row** | newest completion | server `CURRENT_DATE` |
   |---|---:|---:|---:|---|---|
   | Moosii | 4 | **0** | **4** | 2026-11-10 | 2026-11-25 |
   | financial | 1 | **0** | **1** | 2026-09-10 | 2026-11-25 |

   The view is **empty on both projects** — which the original audit noted as "an empty view proves
   nothing" for its counts. The *reason* it is empty is the finding: not missing data, a 15-day-old
   streak.

   So `useStreak.ts` reads a view that returns **no row** for every user it will ever ask about
   unless they completed something today or yesterday. `.single()` turns that into an error,
   `.maybeSingle()` into `null`, and then `row.streak_dates.map()` at `useStreak.ts:40` throws.
   **A `COALESCE` in the view cannot fix this — there is no row to coalesce.**

## F.4 Proposed fix

**Recommended: fix the caller, not the view — no migration.** Treat "no row" as the zero state:
`maybeSingle()`, then `streak_dates ?? []` and `max_unique_weekday_streak ?? 0`. "No current streak"
is a normal state for a lapsed user, not an error, and the view already models it correctly by
omitting the row. **moosii-rn seat**; nothing to change in this repo.

**Alternative, if the app would rather always receive a row — REVIEW REQUIRED.** Rebuild
`completed_items_streak` to start from the user set and LEFT JOIN the streak, with
`COALESCE(count(l.*), 0)` and `COALESCE(array_agg(…), '{}')`. Weigh first:

* It changes the view's **row-count semantics** — every user gains a row — so anything treating
  presence-of-row as "has an active streak" silently changes meaning. That includes the current RN
  hook, so this option does **not** remove the need to touch moosii-rn; it only changes what to
  write there.
* The three columns then become **genuinely** never-null, so `npm run gen:types` would move them
  into the 85 and the commit must carry the regenerated types (CLAUDE.md).
* A replacement guards on the exact live definition. `CREATE OR REPLACE VIEW` **cannot change a
  column list or order** (42P16 — the trap migration 055 hit with `lessons_with_track_name`), so any
  column-set change is **DROP + CREATE in one transaction**, with `security_invoker` and every grant
  the DROP discards re-applied in the same migration.
* It needs the same treatment on both projects (the view exists on both, identically).

**My recommendation stands at the caller fix.** The view is not wrong; the caller assumes a row.

## F.5 Two side findings on the same two views — not nullability, but consequential

**⚠ F.5a — `user_mlp_not_completed` silently drops whole users.** Its final
`JOIN user_configurations uc` is an **inner** join, so a user with no `user_configurations` row
contributes nothing:

| | users in `user_mlp` | users in `user_configurations` | **mlp users with no config** | view rows / base rows |
|---|---:|---:|---:|---|
| Moosii | 18 | 11 | **7** | 64 / 105 |
| financial | 3 | 3 | 0 | 29 / 29 |

**7 of 18 users on Moosii would see an entirely empty upcoming list** — the same class of bug as
F.3 (a missing row, not a NULL), on the other view the brief named. No real parents exist yet
(invariant 3), so nobody has hit it. Its own decision: either `LEFT JOIN user_configurations` with a
default limit, or guarantee a `user_configurations` row per user at signup. Out of scope here.

**⚠ F.5b — `completed_items.item_id` and `.item_type` are NULLABLE on both projects** (every other
column checked on that table is NOT NULL). The suppression in `user_mlp_not_completed` is an
anti-join on `u.item_id = ci.item_id AND u.item_type = ci.item_type … WHERE ci.id IS NULL`, and a
completion row with a NULL `item_id` matches nothing — so it would **fail to suppress the completed
item**, and the parent would be shown something they had already finished. **0 such rows today**
(8 completions on Moosii, 1 on financial, 0 NULLs in either column), so it is latent. Adjacent to
the open backlog item requiring `lesson_id` on `item_type='lesson'` rows (111 / F29) — the same
missing-NOT-NULL shape, one table over.

## F.6 Answering the brief head-on for all 85

Re-extracted the never-null set from the current `src/types/database.types.ts`: **28 views, 85
columns** — the same set the original audit above examined. Classification:

**All 85 are plain base-table columns on the preserved side of every join. None is an aggregate, a
derived expression, or exposed through the nullable side of an outer join.** Checked precisely the
views where an aggregate could have slipped in; in each, the aggregate kept its `| null` while only
the structural columns lost it:

| view | never-null columns | the aggregate / expression columns |
|---|---|---|
| `questionnaire_user_score` | `questionnaire_id`, `user_id` — the two `GROUP BY` keys | the score kept `\| null` |
| `completed_items_streak` | `user_id` — the `GROUP BY` key | `count(*)` and both `array_agg`s kept `\| null` |
| `v_lesson_details` | `lesson_id`, `lesson_name`, `track_id` | the aggregated tag columns kept `\| null` |
| `user_activity_followups_due` | `asks`, `created_at`, `id`, `lesson_id`, `lesson_name`, `user_id`, `verify_mode` — all base columns, inner joins + a CROSS JOIN | — |
| `user_active_tracks` / `…_with_reason` | `weight` — `tracks.weight`, **NOT NULL since migration 058's `NULL → 1` backfill** | — |
| `user_mlp_not_completed` | the seven `user_mlp` columns (F.2) | `rn` (`row_number()`) kept `\| null` |

So the generator was **pessimistic exactly where it should be** (aggregates, outer joins) and
**precise exactly where it could be** (NOT NULL columns on the preserved side). With the original
audit's direct count — **0 NULLs in all 85 columns on both projects** — the conclusion is unchanged
and now holds per-column rather than in aggregate:

> **No column among the 85 can yield NULL. Nothing to fix in the types.** The two real defects this
> follow-up found are **absent rows**, in moosii-rn's two callers (F.3, F.5a) — which no change to
> nullability would ever have surfaced.

**Nothing was written, applied or committed in this follow-up.** Read-only throughout, both
projects. Follow-ups belong to the **moosii-rn seat** (F.3, F.5a) and the backlog (F.5b).
