# FINDINGS — CMS roles: what exists and how each is enforced

**Investigation, 2026-11-13. No code, schema or data was changed.**
Facts come from the code at the commits listed below and from read-only queries against both live
catalogs, each after an identity check (financial `7678069749886157684` / `domain financial`;
Moosii `7481590244898220655` / `domain moosii`). **Every database result was identical on both
projects** unless stated otherwise.

Short version: there are **two roles that matter** (`admin`, `super_admin`) and **one orthogonal
axis** (the two capability booleans). The backend treats the two roles as one; RLS does not. Nothing
constrains the `role` column, and `users_internal` is dead.

---

## 1. Where a role is read or compared

### The gate

`public."user".role` — read in exactly two functions, both in `src/middleware/jwtAuth.ts`.

| file:line | compares | allows / blocks |
|---|---|---|
| `jwtAuth.ts:8` | `ADMIN_ROLES = ["admin", "super_admin"]` | the whole admin set — one array, two strings |
| `jwtAuth.ts:9-11` | `isAdminRole(role)` → `ADMIN_ROLES.includes(role)` | helper, used only by `/classify-update` |
| `jwtAuth.ts:85` | `SELECT id, email, role FROM "user" WHERE id = <auth uid>` (`.single()`) | no row → **403 `forbidden`** "No CMS profile for this user" |
| `jwtAuth.ts:93-95` | `!ADMIN_ROLES.includes(profile.role)` | **403 `forbidden`** "Requires admin role". **This is the entire admin gate**; below it `admin` and `super_admin` are indistinguishable |
| `jwtAuth.ts:52-56` | `verifyAnyUser`: `.select("email, role")`, `.maybeSingle()` | role is read, never gates; `null` is a valid caller (app parent with no profile row) |

`verifyAdminJwt` is the only gate. It is used by `jwtAuthMiddleware` (`jwtAuth.ts:116-135`) and by
`jobsAuthMiddleware` (`auth.ts:28`).

### Which surfaces sit behind it

From `src/index.ts`:

- **Admin gate** (lines 57-69): `/sub-segments`, `/segments`, `/content-images`, `/lessons`,
  `/voice-lint-rules`, `/tones`, `/size-profiles`, `/structure-blocks`, `/card-positions`,
  `/questionnaires`, `/questionnaire-prompt`, `/quiz`, `/source-documents`. Thirteen routers, one
  gate, **no per-route role distinction inside any of them**.
- **`/jobs`** (`index.ts:97`): `INTERNAL_API_KEY` **or** the same admin gate (`auth.ts:22-32`).
- **`GET /facts/:user_id`**: `adminAuth: jwtAuthMiddleware` (`src/routes/facts.ts:11`), applied
  per-route at `src/facts/router.ts:93`. `POST /facts` and `POST /facts/batch` use `FACTS_API_KEY`
  and no role at all.
- **No role gate**: `/classify-update`, `/mlp`, `/activities`, `/activity-followups`, `/plan`
  (end-user JWT, own rows), `/demo` (access code), `/health`, `/version`.

### Handler-level comparisons — two, both in one file

| file:line | compares | effect |
|---|---|---|
| `classifyUpdate.ts:293` | `!isAdminRole(caller.role)` | **403** "naming a target user_id requires admin" (console mode). Both admin strings pass |
| `classifyUpdate.ts:312` | `isAdminRole(caller.role)` | cosmetic: audit `source` = `app_internal` vs `app`. Child ownership applies to admins identically — no bypass (`:309-314`) |

### Role as a recorded value, never a gate

| file:line | what it does |
|---|---|
| `approvalLog.ts:38` | `actor_role: req.user?.role ?? null` → `content_approvals`, **compared to nothing**. `logApproval` gates on `actorId` only (`:25-30`) and never throws |
| `lessonPublish.ts:47-52` | `resolvePublishActor` returns `null` **only when `id` is missing**; `role` is passed to `set_lesson_published(p_actor_role)` and never checked |
| `subSegments.ts:64-65` | `if (!actorId \|\| !actorRole)` → 401. A **presence** check, not a value check |

### `users_internal` is dead

Read **nowhere** in `src/`. `jwtAuth.ts:7` says so: *"(`users_internal` is intentionally NOT used.)"*
`migrations/026_response_templates.sql:9-10` records the same correction. **0 rows on both projects.**
One RLS policy exists on it (`users_internal_all`, `ALL`, `is_admin`).

### Capabilities — the real second axis

`can_review_editorial` / `can_approve_clinical` (`migrations/056:43-44`), read best-effort and
**fail closed** at `jwtAuth.ts:97-111`. Five checks exist, in two files:

| route | file:line | requires |
|---|---|---|
| `POST /lessons/:id/approve` | `lessons.ts:71` | clinical |
| `POST /lessons/:id/editorial-approve` | `lessons.ts:159` | editorial |
| `POST /segments/:id/editorial-approve` | `segments.ts:190` | editorial |
| `POST /segments/:id/clinical-approve` | `segments.ts:204` | clinical |
| `POST /segments/:id/reject` | `segments.ts:232` | editorial or clinical (variable) |

`hasCapability` appears nowhere else. Capability is independent of role, and sparsely granted:

| project | role | users | editorial | clinical |
|---|---|---|---|---|
| financial | `super_admin` | 1 | 1 | 1 |
| financial | `user` | 2 | 0 | 0 |
| Moosii | `super_admin` | 2 | 1 | 1 |
| Moosii | **`admin`** | **2** | **0** | **0** |
| Moosii | `user` | 6 | 0 | 0 |

Moosii's two plain admins pass the gate and reach every admin route, but can sign nothing.

---

## 2. The RLS helpers and who calls them

### Bodies, exact (`pg_get_functiondef`, identical on both projects)

```sql
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public."user"
    WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
  );
$function$

CREATE OR REPLACE FUNCTION public.is_super_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public."user"
    WHERE id = auth.uid() AND role = 'super_admin'
  );
$function$
```

**`is_admin()` includes `super_admin`.** The sets nest: `is_super_admin() ⊂ is_admin()`. Both read
the same column the backend reads. Last written by `migrations/078_user_active_tracks_rls.sql:102-113`
(`CREATE OR REPLACE`, so the original definition is older than the migrations folder).

### Totals (`pg_policies`, both projects)

| helper | policies | distinct tables |
|---|---|---|
| `is_admin` | **136** | **55** |
| `is_super_admin` | **88** | **23** |

Migration files referencing them: `is_admin()` in 11, `is_super_admin()` in 3 (`078`, `098`, plus
`README.md`). The live catalog is the authority — most policies predate the migrations folder.

### The 23 `is_super_admin` tables

`chat`, `children`, `comments`, `completed_items`, `friends`, `group_chat`,
`group_chat_user_last_seen`, `group_message`, `message`, `notifications`, `posts`, `replies`,
`starred_items`, `user`, `user_demographic_responses`, `user_lesson_progress`, `user_mlp`,
`user_mlp_mods`, `user_questionnaire_progress`, `user_segement_track`, `user_tag`,
`user_track_weights`, `user_tracks`.

Operation by operation, for the ones the CMS touches:

| table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `user` | `is_admin` | `is_super_admin` | `is_super_admin` | `is_super_admin` |
| `children` | `is_admin` | `is_super_admin` | `is_super_admin` | `is_super_admin` |
| `completed_items` | `is_admin` | `is_super_admin` | `is_super_admin` | *(none — dropped by 113)* |
| `user_mlp` | `is_admin` | `is_super_admin` | `is_super_admin` | `is_super_admin` |
| `user_mlp_mods` | `is_admin` | `is_super_admin` | `is_super_admin` | `is_super_admin` |
| `user_facts` | `is_admin` | — | — | — |
| **`user_lesson_progress`** | **`is_super_admin`** | `is_super_admin` | `is_super_admin` | `is_super_admin` |
| **`user_tracks`** | **`is_super_admin`** | `is_super_admin` | `is_super_admin` | `is_super_admin` |

**Admins read, super_admins write** — plus two tables a plain admin cannot even read.

A stale catch-all `user_or_super_admin_access` (cmd `ALL`, `is_super_admin`) survives on `user_mlp`,
`user_mlp_mods`, `user_lesson_progress`, `user_questionnaire_progress` and `notifications`. 113
dropped it on `completed_items` only.

### Non-policy functions mentioning a helper

Two, both projects: `renumber_track_priorities`, `renumber_track_priority_order`.

### No policy compares a role string directly

Policies containing an `'admin'` / `'super_admin'` literal but *not* calling a helper: **0 rows**.
Every RLS role decision goes through the two functions.

---

## 3. Can `super_admin` do anything plain `admin` cannot?

**Yes in RLS. No in any backend route.**

**Yes:** 88 policies over 23 tables call `is_super_admin()`, which excludes `role = 'admin'` by
construction. A plain admin on a Supabase anon-key client cannot insert, update or delete `user`,
`children`, `completed_items`, `user_mlp`, `user_mlp_mods`, `user_tracks` or `user_lesson_progress`,
and cannot read the last two at all.

**No:** every route gates on `ADMIN_ROLES` (`jwtAuth.ts:93`) or `isAdminRole`
(`classifyUpdate.ts:293`), both of which accept either string. `grep -r super_admin src/` outside
`jwtAuth.ts:8` and the generated types returns nothing. And the backend holds the service-role key,
which bypasses RLS — so **any path through the backend erases the distinction entirely**.

Whether the split bites therefore depends only on whether a CMS screen goes through the backend or
writes Supabase-direct.

**It is also partly self-defeating.** 18 tables carry a leftover `INSERT … TO authenticated
WITH CHECK (true)` policy on both projects. Policies OR together, so on `children`,
`user_questionnaire_progress`, `user_segement_track`, `prompts`, `invitees`, `posts`, `comments`,
`chat`, `friends`, `group_chat`, `group_chat_user_last_seen`, `group_message`, `groups_data`,
`message`, `replies`, `starred_items`, `questionnaire_response` and `quiz_response`, **any signed-in
user can insert arbitrary rows** regardless of the super_admin gate. `user` is the one exception —
its check is `id = auth.uid()` (migration 112). `completed_items` and `user_lesson_progress` were
cleaned by migration 105.

Related: `user_questionnaire_progress`, `user_segement_track` and `user_track_weights` still carry
`Enable read access for all users` with `USING (true)` for `authenticated`.

---

## 4. Constraints on `role`

**There are none, on either table, on either project.**

`users_internal`:

```
column_name   data_type   is_nullable   default
role          text        NO            (none)
user_id_auth  uuid        YES           (none)
id            uuid        NO            gen_random_uuid()

users_internal_pkey               PRIMARY KEY (id)
users_internal_user_id_auth_fkey  FOREIGN KEY (user_id_auth) REFERENCES auth.users(id) …

rows: 0
```

No CHECK, no enum, no FK on `role`. Empty and unread.

`public."user"` — the column that actually matters: `role text NOT NULL DEFAULT 'user'`, and the
only constraint on the table is `user_id_fkey` (`id` → `auth.users`). **No CHECK, no enum, no FK.**
Any string is storable, so `'Admin'`, `'superadmin'` or a trailing space silently means "no access",
and neither the database nor the code would flag it.

---

## 5. The `role` enum in `database.types.ts`

`src/types/database.types.ts:7632` — `role: "user" | "admin" | "super"`, runtime constant at `:7776`.
It is a real Postgres enum, present on both projects:

```
typname | labels
role    | user,admin,super
```

- **Used by no column**: `information_schema.columns WHERE udt_name = 'role'` → **0 rows**, both projects.
- **Used by no code**: `Enums<"role">`, `Enums["role"]` and `"super"` → no hits in `src/` outside the
  generated file.
- **Its labels are wrong anyway**: it says `super`; the code and both helpers compare `super_admin`.
  Anything that adopted this enum would break the admin gate.

Safe to drop (`DROP TYPE public.role` on both projects, then regenerate the types). No code change.
Not drafted here.

---

## 6. Approval gating

Five routes are capability-gated; eight comparable ones are not.

| route | file:line | gate beyond the admin role |
|---|---|---|
| `POST /lessons/:id/approve` | `lessons.ts:71` | **clinical** |
| `POST /lessons/:id/editorial-approve` | `lessons.ts:159` | **editorial** |
| `POST /segments/:id/editorial-approve` | `segments.ts:190` | **editorial** |
| `POST /segments/:id/clinical-approve` | `segments.ts:204` | **clinical** |
| `POST /segments/:id/reject` | `segments.ts:232` | **editorial or clinical** |
| `POST /lessons/:id/unapprove` | `lessons.ts:177` | none |
| `POST /lessons/:id/publish` | `lessons.ts:256` | none — actor id only |
| `POST /lessons/:id/unpublish` | `lessons.ts:261` | none |
| `POST /questionnaires/:id/publish` | `questionnaires.ts:16` | none |
| `POST /questionnaires/:id/unpublish` | `questionnaires.ts:50` | none |
| `POST /quiz/:segment_id/approve` | `quiz.ts:34` | none |
| `POST /quiz/:segment_id/unapprove` | `quiz.ts:37` | none |
| `POST /content-images/:id/approve` | `images.ts:9` | none |
| `POST /content-images/:id/reject` | `images.ts:53` | none |

`grep hasCapability` returns nothing in `images.ts`, `questionnaires.ts`, `quiz.ts`, `subSegments.ts`.

So an admin-gate passer **cannot approve a lesson or a segment**, but **can** publish a lesson,
publish a questionnaire, approve a quiz, approve an image, unapprove a lesson, and edit card
content — on role alone.

Three structural notes:

1. **Publishing is not an approval.** `set_lesson_published` takes `p_actor_role` and ignores its
   value; the only refusal is a null actor (invariant 7). A capability-less admin can publish a
   lesson nobody with clinical capability ever signed.
2. **The quiz asymmetry.** `POST /quiz/:segment_id/approve` sets `quiz_questions.answer_status =
   'approved'` with no capability check, and that column derives `lessons.with_quiz` (invariant 10).
   The same approval reached through `POST /lessons/:id/approve` requires clinical capability.
3. **Capability is not role-derived.** A `user`-role account can hold `can_approve_clinical = true`
   and still be blocked at the gate; a `super_admin` with both flags false can sign nothing. Nothing
   enforces a sensible combination.

---

## Open items (not scheduled, nothing drafted)

1. `role` has no CHECK constraint on either table — a typo is a silent lockout.
2. 18 blanket `INSERT … WITH CHECK (true)` policies defeat the `is_super_admin()` INSERT gates.
3. Three per-user tables still have blanket `USING (true)` SELECT.
4. The `user_or_super_admin_access` catch-all survives on five tables.
5. `public.role` enum: orphaned, mislabelled, droppable.
6. `users_internal`: empty, unread, still carries a policy. Drop or populate — currently it is a
   trap for anyone reading the docs rather than the code.
7. Publish / quiz-approve / image-approve take no capability. Whether they should is a decision, not
   a defect; see `docs/backlog.md` if it gets scheduled.

## Docs corrected alongside this report (2026-11-13)

- `CLAUDE.md` — per-user RLS ("admins READ, super_admins WRITE"), the blanket-`USING (true)` claim,
  the policies-OR trap, capability scope, and `FACTS_API_KEY` covering two routes (commit `1a3add8`).
- `docs/api-contract.md` — the Auth convention said the backend "checks `users_internal` for CMS
  access"; it reads `public."user".role`.
- `docs/rls-sweep.md` — the `screen_help` policy template was gated on `users_internal`; added the
  write-side posture, the surviving catch-all, and the list of tables still carrying blanket
  policies.
