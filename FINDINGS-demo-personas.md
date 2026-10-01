# FINDINGS — demo sign-in, Priya, outcome history (financial)

2026-09-28 · Investigate-first · nothing applied. Financial read in read-only / rolled-back transactions
(one simulation as Sam with `SET ROLE authenticated` + his JWT claims). `claude/demo-script-financial.md`
isn't in any repo this seat can read (it's a claude.ai project doc), so this works from the brief's
summary of it.

## TL;DR

1. **Sign-in:** a financial-only `POST /demo/session { persona }`. The persona flag lives in **auth
   `app_metadata`** (`demo_persona`), which only the service role can set. The backend mints the session
   with **`auth.admin.generateLink({type:'magiclink'})` → `verifyOtp({token_hash})`** (both in the
   installed supabase-js 2.106.2) on a **throwaway client**: no passwords held anywhere, no email sent. The reader calls `supabase.auth.setSession()`.
2. **⚠ Blocker before this endpoint goes public:** any session it hands out is `authenticated`, and on
   financial today a signed-in user **can read and UPDATE `prompt_blocks`, DELETE from
   `content_approvals`** (the RLS-off P1; 099 only removed anon), and reads all 11 lessons, 10 of them
   unpublished, plus every card. Demo sign-in turns "anyone with the reader URL" into "authenticated".
   **The RLS P1 pass must land first** (or the endpoint stays behind a presenter-only access code).
3. **Priya:** Mark creates the auth user (the triggers from 087 create her `user` row). Seeding `seed` facts
   needs **migration 104** (source += `seed`; renumbered from 102 on 2026-09-28). Seed through a small `seed_facts` job that reuses
   `recordFacts` server-side, so the rebuild runs in the financial process. Expected tracks: **Getting
   Oriented + Building a Buffer**. But "Building a Buffer first" does **not** happen today: Getting
   Oriented has the higher weight (100 vs 90) and Building a Buffer has **0 published lessons**.
4. **Outcomes:** **don't** future-date `user_facts` rows. `user_facts_latest` is latest-wins with no
   `≤ now()` filter, so a future "after" row would become Priya's *current* fact immediately and remove
   Building a Buffer from her plan. Fixing that means touching 071, which feeds MLP selection
   (invariant 8). Instead keep the story in a **labeled `demo_outcome_series` table** (financial only),
   and have the outcomes view union real history (`user_facts`) with it, badging every seeded point.
   Aggregate: real data is 1 user and 0 movements, so the demo figure must come from the labeled seed table.
5. **Reader access (question 4):** Sam can read his own plan, facts and active tracks. Gaps: the **fact
   vocabulary is unreadable** by signed-in users (`fact_keys` / `fact_values` RLS on, no policy → 0 rows),
   so the outcomes view can't show labels. Signed-in users also see unpublished lessons and cards.

## Status — 2026-09-28 build (Sarah replaces Priya)

- **Persona flags set** (financial, SQL as postgres on `auth.users`, guarded to exactly one row each):
  `raw_app_meta_data || '{"demo_persona":"sam"}'` on `19587e0a-…` (Sam) and `… '{"demo_persona":"sarah"}'`
  on `ad6910ab-854b-480b-8fbb-df78ac9147d3` (Sarah). No other user carries `demo_persona`.
- **104** (`seed` source) applied financial + Moosii.
- **Track weight (financial data, not a migration):** `tracks.weight` for Getting Oriented **100 → 50**
  (guarded update: exactly one row at 100). Why this works: `user_active_tracks_for_user` returns tracks
  `ORDER BY weight DESC`, `generateFullMLP` sorts by `priority` (all 100 on financial) with a stable sort, so
  tied tracks keep weight order and fact tracks (90) lead each round. No algorithm change (invariant 1).
  Verified with the pure `generateFullMLP` on live track/lesson data: once fact-track lessons are published,
  Sam's path starts `[Credit Health] When a Card Is Nearly Maxed Out`, Sarah's `[Building a Buffer] Why One
  Month Comes First`. Today both paths are the one published Getting Oriented lesson.
- **Track priority (financial data, 2026-09-28):** Getting Oriented `priority` **100 → 200** (guarded, one row).
  `generateFullMLP.ts:231` sorts ascending, so 200 sorts after every fact track (100): the order is now
  EXPLICIT, not a side effect of the view's `ORDER BY weight` + stable sort. Proven with the pure function on
  live data and the input order reversed: same plans. ⚠ `renumber_track_priority_order()` (the CMS
  priorities page) rewrites `tracks.priority`, so a track reorder in the CMS overwrites this.
- **Built:** `seed_facts` job (§8e) and `POST /demo/session` (§9).
- **Seeded completion — Sam finished orientation (financial, 2026-09-30).** `completed_items` has no
  seed/source column, so it is recorded HERE. Sam (`19587e0a-…`, `demo_persona = sam`) gets the same two
  writes moosii-rn `useCompleteLesson` makes for "What the App Can See Now" (`06eef3f3-c2ab-43e9-ba58-8dc52a742232`):
  `user_lesson_progress (user_id, lesson_id, is_completed=true)` (upsert) and one `completed_items` row
  (`item_type 'lesson'`, `item_id = lesson_id =` that lesson, `item_name`/`item_description`/`with_quiz` from the
  lesson, `score 0`). The AFTER INSERT trigger `trigger_add_moosies()` added his `moosi_to_add`: `user.moosies` 0 → 10,
  as a real completion would. Guarded: financial only, target must carry `demo_persona = 'sam'`, insert skipped if
  the row exists. Sarah untouched. After a rebuild his live path is Credit Health only:
  1 When a Card Is Nearly Maxed Out → 2 Paying Before the Statement Date → 3 Why Your Credit Balance-to-Limit Ratio Matters.
  **Backdated 2026-10-01:** both rows' `created_at` set to `2026-09-10 14:00+00` (three weeks back) so Sam reads as having
  done orientation weeks ago; guarded as above, exactly 1 + 1 rows. `updated_at` shows the edit time — the BEFORE UPDATE
  trigger `set_updated_at` overwrites it. No new rows, so no second moosies award (still 10). Rebuilt (job
  `39393480-…`); `user_mlp_not_completed` unchanged: the three Credit Health lessons above. "Set a Statement-Date
  Reminder" (activity) joins between 2 and 3 once it is published — it is still unpublished.
  **To redo** (e.g. after a data reset) run, as postgres on financial, in one transaction:
  ```sql
  INSERT INTO user_lesson_progress (user_id, lesson_id, is_completed)
    VALUES ('19587e0a-bfe0-48e2-94a1-055a5bbc9584', '06eef3f3-c2ab-43e9-ba58-8dc52a742232', true)
    ON CONFLICT (user_id, lesson_id) DO UPDATE SET is_completed = true;
  INSERT INTO completed_items (user_id, item_id, item_type, lesson_id, questionnaire_id, item_name, item_description, with_quiz, score)
  SELECT '19587e0a-bfe0-48e2-94a1-055a5bbc9584', l.id, 'lesson', l.id, NULL, l.lesson_name, coalesce(l.description, ''), l.with_quiz, 0
    FROM lessons l WHERE l.id = '06eef3f3-c2ab-43e9-ba58-8dc52a742232'
     AND NOT EXISTS (SELECT 1 FROM completed_items c WHERE c.user_id = '19587e0a-bfe0-48e2-94a1-055a5bbc9584'
                       AND c.item_id = l.id AND c.item_type = 'lesson');
  UPDATE completed_items SET created_at = '2026-09-10 14:00+00'
   WHERE user_id = '19587e0a-bfe0-48e2-94a1-055a5bbc9584' AND item_id = '06eef3f3-c2ab-43e9-ba58-8dc52a742232';
  UPDATE user_lesson_progress SET created_at = '2026-09-10 14:00+00'
   WHERE user_id = '19587e0a-bfe0-48e2-94a1-055a5bbc9584' AND lesson_id = '06eef3f3-c2ab-43e9-ba58-8dc52a742232';
  ```
  then `POST /jobs {type: "rebuild_mlp", input: {user_id: "19587e0a-…"}}` on the financial service. To undo:
  delete those two rows (and subtract 10 from `user.moosies` if it matters).

## 1. Demo sign-in

**Where the flag lives: auth `app_metadata`** (recommended) vs a table.
- `raw_app_meta_data` is settable only with the service role (users can't edit it; `user_metadata`
  they *can*). It rides in the JWT (`app_metadata.demo_persona`), so the reader can show "Demo: Sam"
  without another query. No migration.
- A `demo_users` table would need its own RLS, a migration and a join; nothing is gained at two personas.
- Set it (proposed, **not applied**; financial only):
  ```sql
  UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || '{"demo_persona":"sam"}'::jsonb
   WHERE id = '19587e0a-bfe0-48e2-94a1-055a5bbc9584' AND email = 'markmun99+sam@gmail.com';
  -- after Mark creates Priya:
  UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || '{"demo_persona":"priya"}'::jsonb
   WHERE email = 'markmun99+priya@gmail.com';
  ```

**How the session is minted: `generateLink` + `verifyOtp`** (recommended) vs `signInWithPassword`.
| | generateLink (magiclink) → verifyOtp(token_hash) | signInWithPassword with a server-held password |
|---|---|---|
| Secrets | none new; uses the service role the backend already has | a password per persona in Render env; rotation = manual |
| Email | none sent (`generateLink` only returns the link and token) | none |
| Works if the password changes / SSO later | yes | no |
| Trap | `verifyOtp` sets the session **on the client that calls it**. The backend's `supabase` is one shared service-role client for every route, so use a **per-request throwaway client** (`createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })`) | same trap |

Flow: `POST /demo/session { persona: "sam" | "priya", code }` →
1. financial only (404 elsewhere, checked before anything else, like `POST /facts`);
2. `DEMO_ACCESS_CODE` env: constant-time compare against `code`; unset → the route is disabled (503);
3. resolve persona → user: `auth.admin.listUsers()` (two demo users; fine) filtered on
   `app_metadata.demo_persona === persona`; **refuse anyone else**; exactly one match, else 404;
4. `admin.generateLink({ type: "magiclink", email })` → `properties.hashed_token` →
   throwaway client `.verifyOtp({ type: "magiclink", token_hash })` → `{ access_token, refresh_token, expires_at }`;
5. respond `200 { persona, user_id, access_token, refresh_token, expires_at }`; log persona +
   fingerprint, never tokens.

**CORS:** the reader's origin must be in the financial service's `ALLOWED_ORIGINS` (Render env;
`src/middleware/cors.ts` reads it). CORS isn't access control: any script can call the route, so the
access code is the gate.
**Rate limit:** no limiter exists in the repo today. An in-memory fixed window per IP (e.g. 10/min) and
a global cap (e.g. 60/hour) is enough on one Render instance. No new dependency needed.
**Reader side (moosii-reader seat):** `supabase.auth.setSession({ access_token, refresh_token })` on
its anon-key client; supabase-js persists it in localStorage and refreshes it. The persona switcher =
`signOut()` then a new `POST /demo/session`. Access tokens live 1 h and refresh automatically.

## 2. Priya

1. **Mark (dashboard, financial project):** Authentication → Add user → `markmun99+priya@gmail.com`,
   auto-confirm, any password (never used, since sign-in is §1). 087's `new_user_trigger` →
   `create_new_user()` inserts both her `public."user"` row **and** her `user_configurations` row (checked
   2026-09-28), which the plan view joins; `user_mlp_data` is a view and covers zero-child users (059).
   Sam has all three (mlp_limit 20).
2. **Migration 104 (both projects, schema):** `user_facts_source_valid` += `seed`; internal allow-list
   += `seed` (never accepted by `POST /facts`).
3. **Seed via a `seed_facts` job** (proposed code, next slice): admin/internal `POST /jobs {type:
   "seed_facts", input: { user_id, facts: [{key, value}] }}` → refuses unless the user's
   `app_metadata.demo_persona` is set → `recordFacts(..., { internal: true, reason: "seed_facts" })` with
   `source: "seed"`, `source_ref: "demo-seed"`, `observed_at: now`. The rebuild then runs in the
   financial process. (A local script would enqueue the rebuild in a *local* process pointed at the
   local `.env`'s `SUPABASE_URL`, the wrong project, so don't.)
   Values: `has_direct_deposit = true`, `has_emergency_buffer = false`. Nothing else: the other keys
   stay unknown (no row).
4. **Expected tracks:** rules (084) → `has_emergency_buffer=false` → Building a Buffer;
   `has_direct_deposit=true` → nothing (only `false` → Paycheck Setup); plus the default Getting Oriented.
   So **Getting Oriented + Building a Buffer**.
5. **"Building a Buffer first" won't show up yet.** All tracks have priority 100. Weights: Getting Oriented
   100, Building a Buffer 90, so Getting Oriented leads. And Building a Buffer has **no published lessons**
   (the 3 stubs + food budget are unpublished), so her plan today would be the same single Getting Oriented
   lesson Sam has. To land the beat: publish ≥ 1 Building a Buffer lesson; and either raise Building a
   Buffer's weight above Getting Oriented's (data, not the frozen algorithm, but it moves every
   financial user's order), or accept Getting Oriented first. Mark decides.

## 3. Outcome history (Beat 6, "demo clock")

**Why not future-dated rows in `user_facts`:** `user_facts_latest` (071) picks the latest `observed_at`
with **no `≤ now()` filter**, and it feeds `user_fact_track_ids` → track resolution → the MLP (074,
invariant 8). A seed row dated +30 days saying `has_emergency_buffer=true` is Priya's current value
**today**. Building a Buffer drops out of her plan and Beat 3 breaks. Filtering future rows out of 071
would be a change to MLP selection for every user: not proposed.

**Why not a shifted "demo now":** it would need the same filter, plus a clock parameter threaded
through the views the reader reads. Same problem, more machinery.

**Recommended: a labeled series table, kept out of the fact log.**
```sql
-- migration 106 (FINANCIAL ONLY) — proposed, not applied
CREATE TABLE public.demo_outcome_series (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fact_key    text NOT NULL,
  value       text NOT NULL,
  at          timestamptz NOT NULL,           -- may be in the future: this table drives nothing
  label       text NOT NULL DEFAULT 'seeded',
  FOREIGN KEY (fact_key, value) REFERENCES public.fact_values (fact_key, value) ON DELETE RESTRICT
);
ALTER TABLE public.demo_outcome_series ENABLE ROW LEVEL SECURITY;
CREATE POLICY demo_outcome_series_own ON public.demo_outcome_series FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT is_admin()));
REVOKE ALL ON public.demo_outcome_series FROM anon;
```
Values stay vocabulary tokens (same FK as `user_facts`, so still no amounts; invariant 12).

**The outcomes view (reader) unions both and labels every point:**
```sql
SELECT fact_key, value, observed_at AS at,
       CASE WHEN source = 'seed' THEN 'seeded' ELSE 'real' END AS provenance
  FROM user_facts WHERE user_id = auth.uid()
UNION ALL
SELECT fact_key, value, at, 'seeded' FROM demo_outcome_series WHERE user_id = auth.uid()
ORDER BY fact_key, at;
```
Priya's story: `has_emergency_buffer` false (real `seed` row, now) → true (series, +45 days, "seeded").
Her plan stays on Building a Buffer because `user_facts` is untouched.

**Aggregate figure.** Definitions (propose):
- *started a plan* = has ≥ 1 `completed_items` row for a lesson on a **fact-granted** track;
- *moved a fact the right way* = the earliest and latest observation of a key differ in the improving
  direction:
```sql
WITH dir(fact_key, from_v, to_v) AS (VALUES
  ('has_direct_deposit','false','true'), ('has_emergency_buffer','false','true'),
  ('new_subscription_recent','true','false'),
  ('credit_utilization_band','high','moderate'), ('credit_utilization_band','high','low'),
  ('credit_utilization_band','moderate','low')),
ends AS (
  SELECT DISTINCT user_id, fact_key,
         first_value(value) OVER w AS first_v, last_value(value) OVER w AS last_v
    FROM user_facts
  WINDOW w AS (PARTITION BY user_id, fact_key ORDER BY observed_at
               ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING))
SELECT count(DISTINCT e.user_id) AS moved_right_way
  FROM ends e JOIN dir d ON d.fact_key = e.fact_key AND d.from_v = e.first_v AND d.to_v = e.last_v;
```
On real financial data today that's 0 (one user, one observation per key). For the demo, run the same
query over `user_facts UNION demo_outcome_series` and show the result as **"seeded example"**, never
as a real figure. It must run server-side (service role; an admin/demo route), because a signed-in
user can only see their own rows.

## 4. Reader access as a signed-in financial user

Simulated as Sam (`SET ROLE authenticated`, `request.jwt.claims.sub` = Sam), rolled back:

| Read | Result | Note |
|---|---|---|
| `user_mlp_not_completed` own | 1 row (and only his: "all visible" = 1) | 098 invoker + own-row RLS work |
| `user_facts` own | 4 (all visible = 4, his own) | policy `user_facts_select_own_or_admin` |
| `user_facts_latest` own | 4 | invoker view over the above |
| `user_active_tracks` / `user_active_tracks_for_user(uid)` | Getting Oriented, Credit Health | |
| `completed_items` own | 0 | readable |
| **`fact_keys` / `fact_values`** | **0 / 0** | **gap:** RLS on, no SELECT policy; outcomes view can't label facts |
| `lessons` | 11 visible, **10 unpublished** | policies `USING (true)` / `auth.uid() IS NOT NULL` |
| `sub_segments` | 36 (every card) | same |
| `user_configurations` | 2 (all users') | gap noted before (backlog) |
| **`prompt_blocks`** | readable, **UPDATE = true** | RLS off (P1) |
| **`content_approvals`** | readable, **DELETE = true** | RLS off (P1) |

Gaps to close for the plan and outcomes views:
- ✅ **Done in 102** (both projects): `fact_keys` / `fact_values` signed-in read.
- ✅ **Done in 102**: the RLS P1 (15 tables: RLS on + policies), the prerequisite for public demo sign-in.
- ✅ **Done in 103** (both projects, not financial-only as first proposed): signed-in non-admins read
  published, unarchived content only; admins unchanged; the RN app's reads are all inside the rule
  (FINDINGS-rls-pass.md).

## 5. Slice order and migrations

| # | What | Project | Blocks |
|---|---|---|---|
| 0 | ✅ RLS P1 — **102** (applied both, 2026-09-28) | both | public demo sign-in |
| 1 | **Migration 104** `user_facts.source += seed` + internal allow-list | both | Priya seed |
| 2 | ✅ fact vocabulary signed-in read — folded into **102** | both | outcomes labels |
| 3 | Mark: create Priya; set `app_metadata.demo_persona` for Sam and Priya (the SQL in §1) | financial | 4, 5 |
| 4 | `seed_facts` job (demo users only, `source='seed'`, reuses `recordFacts`) → seed Priya; publish ≥ 1 Building a Buffer lesson; weight decision | financial | Beat 3 |
| 5 | `POST /demo/session` (+ `DEMO_ACCESS_CODE`, rate limit, `ALLOWED_ORIGINS` += reader) | financial | reader switcher |
| 6 | ✅ **Migration 106** `demo_outcome_series` + `demo_outcome_aggregate`, seeded for Sam + Sarah (applied 2026-10-01); `GET /demo/outcomes` (api-contract §9b). As built: series table service-role only (no own-row policy) | financial | Beat 6 |
| 7 | ✅ published-only reads for signed-in non-admins — **103** (both projects) | both | — |
| — | Reader: persona switcher, `setSession`, plan + outcomes views | moosii-reader seat | |

Migration numbers: 102/103 went to the RLS pass (applied 2026-09-28); this plan now uses **104** (`seed`, applied) and **106** (`demo_outcome_series`; 105 went to the completion-policy fix). Nothing here touches `generateFullMLP` /
`computeUserMlp`, 071 or 074.
