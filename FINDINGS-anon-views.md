# FINDINGS — anon-readable plain views (both projects)

2026-09-26 · Investigate-first · **no DDL applied.** All reads were read-only transactions. The
`security_invoker` effect was measured by `ALTER VIEW … SET (security_invoker = true)` inside a
transaction that was ROLLED BACK (lock_timeout 3s), on each project. Row counts only; no content,
ids or emails recorded.

## TL;DR

- All eight views are owned by `postgres` (BYPASSRLS), have no `security_invoker`, and grant SELECT to
  anon and authenticated. **As anon they return every row, on both projects** — the same count the
  owner sees. The policies and column grants of 096/097 do not apply through them.
- **Worst one: `user_mlp_not_completed`.** It is per-user data (user_id + each user's next lessons). On
  Moosii, anon reads **all 26 rows across every user**, and any signed-in app user can read everyone's
  (`.eq('user_id', …)` is a client-side filter, not a guard).
- **`security_invoker = true` is safe for every real caller except one:** a *plain* admin (not
  super_admin) in the CMS classify console would see 0 rows for another user instead of 6, because
  `user_mlp`'s SELECT policy allows own or **super_admin** only. Fix in the same migration: widen
  `user_mlp_sel` to `is_admin()` — the posture 078 gave every other per-user table.
- **Recommendation for all eight: `security_invoker = true` + REVOKE SELECT FROM anon.** Nothing is
  dropped now. Six have no callers anywhere; dropping them is a later cleanup (backlog), not part of the fix.
- ⚠ **Bigger and out of scope — found on the way (§6):** 15 `public` tables have **RLS disabled** on both
  projects, and anon holds SELECT/INSERT/UPDATE/DELETE/TRUNCATE on all of them — including
  `content_approvals` (the publish audit, invariant 7), `prompt_blocks` (the voice blocks every content
  job composes from), `ai_generation_log`, `source_documents`, `image_assets` and `topics`. Anyone with the
  anon key can rewrite or delete them through PostgREST. Added to `docs/backlog.md` as P1; needs its own brief.

## 1. Callers (grep of moosii-cms-backend, moosii-cms, moosii-rn, and moosii-reader)

Generated `database.types.ts` files and docs are excluded. No database function or view depends on any
of the eight views (`pg_depend` and `prosrc` both checked, both projects).

| View | Caller (path:line) | Runs as |
|---|---|---|
| `mlp_item_pool` | backend `src/jobs/handlers/rebuildMlp.ts:506` (`.eq('is_published', true).in('track_id', …)`) | **service_role** (BYPASSRLS) |
| `user_mlp_not_completed` | moosii-rn `src/hooks/useUpcomingMlp.ts:32` (`.eq('user_id', userId)`, only when signed in) | **authenticated**, own user |
| `user_mlp_not_completed` | moosii-cms `src/data/classify.ts:75` (`readMlp`, used by `ClassifyConsole.tsx:734,742`, route `/classify`, not super_admin-gated) | **authenticated admin**, reading ANOTHER user |
| `v_lesson_details` | — none — | — |
| `v_segment_details` | — none — | — |
| `lessons_with_track_name` | — none — | — |
| `lesson_segment_counts_with_track` | — none — | — |
| `sub_segment_image_fallback` | — none — | — |
| `sub_segments_image_fallback` | — none — | — |

moosii-reader: its design docs mention `user_mlp_not_completed`, `v_lesson_details`,
`lessons_with_track_name` and `v_segment_details` (`DESIGN-web-reader.md:101,154`), but its code calls
none of them. It reads the base tables through the 096/097 anon policies.

**No callers at all:** `v_lesson_details`, `v_segment_details`, `lessons_with_track_name`,
`lesson_segment_counts_with_track`, `sub_segment_image_fallback`, `sub_segments_image_fallback`.

## 2. Views: owner, base tables, today's anon rows

Owner `postgres` for all eight on both projects; `reloptions` empty (not invoker); anon SELECT t,
authenticated SELECT t. `postgres` and `service_role` have BYPASSRLS; `anon` and `authenticated` do not.

| View | Base tables (RLS) | anon rows today — financial | anon rows today — Moosii |
|---|---|---|---|
| `v_lesson_details` | lessons, tracks, lesson_tags, tags (all on) | 4 (= all) | 154 (= all) |
| `v_segment_details` | lessons, segments (on) | 4 | 154 |
| `lessons_with_track_name` | lessons, tracks (on) | 4 | 154 |
| `lesson_segment_counts_with_track` | lessons, segments, tracks (on) | 4 | 154 |
| `sub_segment_image_fallback` | lessons, segments, sub_segments (on) | 30 | 481 |
| `sub_segments_image_fallback` | lessons, segments, sub_segments (on) | 30 | 481 |
| `mlp_item_pool` | lessons, questionnaire (on) | 4 | 154 |
| `user_mlp_not_completed` | user_mlp, completed_items, user_configurations, lessons, questionnaire (on); **topics (RLS OFF)** | 1 | **26 (every user's)** |

Financial has 4 lessons now; on 2026-09-26 at 096 time `v_lesson_details` showed 3. Only 1 of the 4 is
published and visible to the reader — anon sees all 4 through these views.

## 3. Base-table SELECT policies for `authenticated` (identical on both projects)

| Table | Policy → who can read |
|---|---|
| lessons, questionnaire, tracks, tags, lesson_tags, sub_segments | `TO authenticated USING (true)` and/or `auth.uid() IS NOT NULL` → every signed-in user, all rows |
| segments | `auth.uid() IS NOT NULL OR service_role` → every signed-in user |
| user_configurations | `auth.uid() IS NOT NULL` → every signed-in user, **all users' rows** (per-user table; gap, see §6) |
| completed_items | own, or `is_admin()`, or service_role |
| **user_mlp** | own, or **`is_super_admin()`**, or service_role — **a plain admin sees only their own** |
| topics | RLS off → everyone (including anon) |

`is_admin()` = role IN ('admin','super_admin'); `is_super_admin()` = role = 'super_admin'. Moosii has 2
`admin` and 2 `super_admin` users; financial has 1 `super_admin` and no plain admin.

## 4. What `security_invoker = true` changes — measured (rolled back)

Each persona ran `count(*)` on each view before and after the ALTER, in one transaction, then ROLLBACK.
"target" = the non-admin user with the most rows in `user_mlp_not_completed` (Moosii: role `user`, 6
rows; financial: the only user with rows is the super_admin, 1 row).

**The six content views and `mlp_item_pool`:** unchanged for every authenticated persona (target, plain
admin, super_admin) and for service_role on both projects: 154/154/154/154/481/481/154 on Moosii,
4/4/4/4/30/30/4 on financial. Published slice of the pool: 12 (Moosii) and 1 (financial), before and after
— **the backend's rebuild input is identical** (service_role bypasses RLS; invariant 8 unaffected). As anon
after the change: Moosii → 0 rows each; financial → `permission denied for table lessons/segments` (the
096 column grants now bind).

**`user_mlp_not_completed`** (Moosii; financial in brackets):

| Persona | Query | Before (today) | After invoker |
|---|---|---|---|
| anon | all rows | **26** [1] | 0 [permission denied] |
| target user (RN app) | `where user_id = own` — what the app runs | 6 [1] | **6** [1] — unchanged |
| target user | all rows (the leak) | **26** [1] | 6 [1] — own only |
| plain admin (CMS classify) | `where user_id = target` | 6 | **0 — REGRESSION** |
| super_admin (CMS classify) | `where user_id = target` | 6 [1] | 6 [1] — unchanged |
| service_role | all rows | 26 [1] | 26 [1] |

Why plain admin drops to 0: `user_mlp_sel` allows super_admin, not admin. Once `user_mlp_sel` uses
`is_admin()`, the admin read matches today. `completed_items_sel` already allows `is_admin()`, and that
matters: if an invoker couldn't see `completed_items`, the anti-join would silently show completed items
as not completed — wrong rows, not missing rows.

## 5. Recommendation and proposed migration (098, BOTH PROJECTS — DRAFT, not written as a file)

| View | Action | Why |
|---|---|---|
| `user_mlp_not_completed` | `security_invoker` + REVOKE anon + widen `user_mlp_sel` to `is_admin()` | closes anon and cross-user leaks; RN and super_admin unchanged; plain admin restored |
| `mlp_item_pool` | `security_invoker` + REVOKE anon | backend (service_role) unchanged, proven |
| six no-caller views | `security_invoker` + REVOKE anon | no caller breaks; drop later (backlog P3) after confirming nothing outside the three repos uses them (Supabase dashboard, ad-hoc SQL) |

Why not drop the six now: dropping is irreversible in effect (recreating needs the old DDL), and
REVOKE+invoker already removes all exposure. Why keep authenticated SELECT: every base table already lets
signed-in users read the same rows, so revoking it would buy nothing today.

```sql
-- 098: anon-readable plain views → security_invoker, anon revoked — BOTH PROJECTS (financial first)
-- PRE-CHECK: the 8 views have empty reloptions and anon SELECT t; user_mlp_sel qual matches the one below.
BEGIN;

ALTER VIEW public.v_lesson_details                 SET (security_invoker = true);
ALTER VIEW public.v_segment_details                SET (security_invoker = true);
ALTER VIEW public.lessons_with_track_name          SET (security_invoker = true);
ALTER VIEW public.lesson_segment_counts_with_track SET (security_invoker = true);
ALTER VIEW public.sub_segment_image_fallback       SET (security_invoker = true);
ALTER VIEW public.sub_segments_image_fallback      SET (security_invoker = true);
ALTER VIEW public.mlp_item_pool                    SET (security_invoker = true);
ALTER VIEW public.user_mlp_not_completed           SET (security_invoker = true);

REVOKE SELECT ON public.v_lesson_details, public.v_segment_details, public.lessons_with_track_name,
  public.lesson_segment_counts_with_track, public.sub_segment_image_fallback,
  public.sub_segments_image_fallback, public.mlp_item_pool, public.user_mlp_not_completed
  FROM anon;

-- user_mlp: plain admins read like every other per-user table (078 posture); was super_admin only.
-- Today: ((user_id = auth.uid()) OR is_super_admin() OR (auth.role() = 'service_role'::text))
DROP POLICY IF EXISTS user_mlp_sel ON public.user_mlp;
CREATE POLICY user_mlp_sel ON public.user_mlp FOR SELECT
  USING ((user_id = (SELECT auth.uid())) OR (SELECT is_admin()) OR ((SELECT auth.role()) = 'service_role'));

COMMIT;
```

(`user_or_super_admin_access`, the FOR ALL policy on `user_mlp`, is left alone; it still governs writes.
Policies OR together, so reads widen and writes do not.)

**Two more views of the same class, outside the brief's eight** (found by listing every anon-readable,
non-invoker view): `questionnaire_user_score` (per-user; anon reads 1 row on Moosii) and
`questionnaire_with_track_name` (3 on Moosii). No code callers in any of the three repos. Recommend
adding both to 098 after running the same rolled-back simulation on them. (`lesson_questions` is
invoker — not in this class, confirmed under 097.)

## 6. Out of scope — flagged, not investigated further

1. **RLS disabled + anon full CRUD on 15 tables (both projects) — P1.** `_segment_dedupe_backup`,
   `ai_generation_log`, `content_approvals`, `content_edits`, `image_assets`, `lesson_source_documents`,
   `notification_log`, `prompt_block_versions`, `prompt_blocks`, `screen_help`, `source_documents`,
   `subscription_plans`, `topics`, `user_tag_actions_MM_unused`, `user_track_actions_MM_unsed`. For each,
   anon has S/I/U/D/T = t (checked via `has_table_privilege`; nothing was written). `docs/rls-sweep.md`
   lists several of them as "should be RLS-enabled", but that pass never happened. Backend-only tables can
   take RLS-on with no policy. CMS-direct ones (`screen_help`, anything else the CMS writes directly —
   see rls-sweep's sanctioned list) need an admin policy first. `topics` is read by the app and CMS, so it
   needs a signed-in read policy. Needs a caller sweep like §1 before any DDL.
2. **`user_configurations` is readable by every signed-in user** (`auth.uid() IS NOT NULL`): it's a
   per-user table that 078 did not narrow. `user_mlp_not_completed` needs the caller's own row (and an
   admin's view of others), so own-or-admin would keep that working.

## 7. Verification after 098 (per surface)

**Database, each project** (financial first; rolled-back transactions; same script as §4):
- The 8 views: `reloptions` = `{security_invoker=true}`; `has_table_privilege('anon', v, 'SELECT')` = f.
- As anon, `select count(*)` from each view → `permission denied for view …` (42501).
- Rerun §4's personas: every "after" count equals the §4 table, except that plain admin
  `where user_id = target` now returns 6 (= before).

**RN app (Moosii):** sign in as a normal user → Home / upcoming MLP shows the same items in the same
order as before. SQL equivalent: as `authenticated` with that user's claims,
`count(*) from user_mlp_not_completed where user_id = auth.uid()` = before; without the filter = the same
number (no other users' rows).

**CMS:** Classify console (`/classify`) → pick a user with MLP rows → the "before" snapshot MLP list is
identical, both as a **plain admin** and as a **super_admin** account. No other CMS page reads these views.

**Backend:** `mlp_item_pool` as service_role — published count unchanged (Moosii 12, financial 1). Then
one `rebuild_mlp` for a single user on **financial** (no real users there); diff `user_mlp` before and after
— identical. Don't run a rebuild on Moosii to test this.

**Reader (financial):** re-run the 096 and 097 anon verifies verbatim — unchanged (1 lesson, 1 complete
segment, domain row, 1 approved question, 4 answers, both "permission denied" checks). The reader calls no
view, so nothing else to check.

**Over HTTP (optional, both projects):** `GET /rest/v1/user_mlp_not_completed?select=user_id` with only
the anon key → 401/42501, where today it returns rows.
