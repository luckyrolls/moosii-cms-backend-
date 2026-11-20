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
