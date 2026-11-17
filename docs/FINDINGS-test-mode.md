# FINDINGS — test mode: catalog modes + test-account reset (2026-11-17)

Investigation only. Nothing changed, no migrations, no commits, **no live DB access** — every
query in this document is written out for Mark to run in the Supabase SQL editor. Sources are
this repo's migrations and `src/`, plus read-only greps of `moosii-cms` and `moosii-rn`.

Context (decided by Mark, 2026-11-17): `tracks.test_group` + `tracks.mode_archived`, one global
mode picked by a super_admin, a questionnaire same-group rule, and an `is_test_account` flag with
a two-depth reset (`activity` / `full`).

**STATUS: DRAFT, uncommitted — held for Mark's go.**

---

## The five things to settle before anything is drafted

1. **financial gets zero `live` tracks** under `created_by='mooselist' → live` (§A8.1). Mode
   switching is a no-op there until financial has its own backfill rule.
2. **"Reset never touches the user row" makes `'full'` impossible** — `onboarding_complete` and
   the intro flags live on it, and so does the `moosies` balance (§B1). Needs restating as a
   column denylist.
3. **`defer_topic` is a third cross-group target** with no downstream archive filter, and it fails
   by silently hiding content (§A2).
4. **`questionnaire` has no reader RLS policy** — migration 103 skipped it (§A1, leak 2).
5. **`archive_guard` is UPDATE-only** and loses the actor on the service-role path (§A3).

`card_positions`: untouched. **MLP: the algorithm is untouched** (invariant 1) — modes reuse the
045/046 archive parent-invisibility, and the only MLP-adjacent work is enqueuing the existing
scope:all rebuild. The caveat is §A1 leak 1: `user_mlp` is a stored snapshot with no FK.

---

# A. Catalog modes

## A1. Everything that references `tracks.id`

14 real FKs + 6 unconstrained `track_id` columns. The decisive fact: `user_active_tracks_for_user`
and its view twin filter archival at **one place — the final `JOIN tracks t … AND t.archived_at IS
NULL`** (`migrations/045_archive_exclude_tracks_active_set.sql:101,165`), and migration 074
preserved it on both twins (`074:222-224, 298-299`). Every path that *adds* a track funnels through
that filter and is already inert. The leaks are the paths that do not.

| referencing column | FK? | ON DELETE | inert for parents when archived? |
|---|---|---|---|
| `lessons.track_id` | yes | pre-existing | **Yes, three ways** — 045, `mlp_item_pool` queried `.in("track_id", trackIds)` (`src/jobs/handlers/rebuildMlp.ts:513`), and RLS `reader_lesson_visible` (`103:28-32`) |
| `questionnaire.track_id` (host) | yes | RESTRICT (`040:41`) | Mostly — pool arm is track-scoped. **But see leak 2** |
| `questionnaire.defer_topic` | yes | NO ACTION (`042:37`) | **No — §A2** |
| `questionnaire_answer_actions.track_id` | yes | RESTRICT (`047a:163`) | Yes — `questionnaire_responses_tracks`, filtered at 045's final JOIN |
| `questionnaire_response.track_id` | yes | RESTRICT (`040:65`) | Yes — same path |
| `demographic_track_rules.track_id` | yes | RESTRICT (`040:49`) | Yes — `base_tracks` arm |
| `new_user_tracks.track_id` | yes | pre-existing | Yes — `default_tracks` arm |
| `fact_track_rules.track_id` | yes | RESTRICT (`072:58`) | Yes — 074's facts arm (`074:222`) |
| `track_tag_map.track_id` | yes | RESTRICT (`040:57`) | Yes — tag→track, then filtered |
| `user_mlp_mods.track_id` | yes | CASCADE (`040:24`) | Yes — `latest_user_mod` arm |
| `user_tracks.track_id` | yes | CASCADE | Yes, vacuously — 020 moved the write target to `user_mlp_mods` |
| `user_track_actions_MM_unsed.track_id` | yes | — | Yes — no reader |
| `age_track_weights.track_id` | yes | pre-existing | Yes — weighting runs after the set is resolved |
| `quiz_response.track_id` | yes | pre-existing | Yes — no reader in `src/` except `src/lib/contentTeardown.ts:72` |
| **`user_mlp.track_id`** | **no FK** | — | **No — leak 1** |
| `user_mlp_v2`, `user_mlp_bs_backup` `.track_id` | no FK | — | same shape (v2 is the write target, `006`) |
| `user_track_weights.track_id` | no FK | — | Yes, vacuously — no reader in `src/` |
| `user_track_activations.track_id` | no FK (`019:66-74`) | — | Yes — classify audit only |
| `user_update_signals.matched_track_id` | no FK (`016:44`) | — | **No — the deferral input, §A2** |

### Leak 1 — `user_mlp` is a stored snapshot with no FK

045's own header says it: *"Enforcement is AT RECOMPUTE … stale `user_mlp` rows are a non-issue"* —
true only because no live users existed. The app reads `user_mlp_not_completed`. **Between a mode
switch and the rebuild finishing, every member's plan still lists the outgoing group's content.**
This is why §A6 matters, and why the switch must enqueue the rebuild itself.

### Leak 2 — `questionnaire` has no reader RLS policy

Migration 103 created `*_select_admin_or_visible` for `lessons`, `segments`, `sub_segments`,
`quiz_questions`, `quiz_answers` — **not `questionnaire`, `questionnaire_questions` or
`questionnaire_answers`** (`103:46-84`) — and `questionnaire` carries no `archived_at` of its own
(`046:17-19`). moosii-rn reads `questionnaire` directly (3 call sites). So a questionnaire id
already in a stale plan, or any id a client knows, still resolves after its host track is archived.
Confirm the live policy set with §A8.4 before relying on anything here.

### Leak 3 — mods survive archival and re-fire on unarchive

`apply_classification` skips a track only if it is already in `user_active_tracks` (`020:57`), which
excludes archived ones — so classify writes `user_mlp_mods(action='add')` rows against archived
tracks. Harmless while archived (045 filters them), but on a switch *back* those rows silently
re-add the track for those members. `src/lib/classifyCatalog.ts:39` filters `archived_at`, so no
*new* ones can be created; the set is bounded to rows written before archival.

## A2. `defer_topic`

**What it does.** Opt-in per questionnaire (`defer_topic` + `defer_days`, both NULL = off, `042`).
A "mention" — a classify signal that proposed that track, `user_update_signals.matched_track_id`,
persisted only under apply — **hides** the questionnaire for `defer_days`, then re-opens it as DUE,
possibly earlier than its recurrence band (`rebuildMlp.ts:179-221`).

**Who reads it.** Two readers sharing one pure function so they cannot drift: the rebuild
(`rebuildMlp.ts:424-443`, via `decideQuestionnaire`) and the questionnaire-status inspector
(`src/mlp/questionnaireStatus.ts:119-183`).

**Does archive filter it? No, at both ends.**

- `loadDeferConfig` (`rebuildMlp.ts:228-254`) selects `questionnaire` where `defer_topic` and
  `defer_days` are non-null. No join to `tracks`, no `archived_at` check.
- `loadLatestMentionByTrack` (`:256-280`) is called with the **defer-topic ids**, not the active
  track set (`:426`; inspector `:121`).

**An archived `defer_topic` track keeps hiding a live questionnaire.** Under catalog modes this is
a cross-group failure: a `live` questionnaire whose `defer_topic` points at a track archived by a
switch stays deferred, indefinitely if the mention is recent and nothing re-answers it. It fails
*closed* (hides content), so it will not leak the other group's content — it will make a check-in
silently vanish, the hardest class of bug to notice.

`defer_topic` is a **third** target alongside the host track and the response targets, and the one
with no FK-side protection downstream. §A8.3 covers it.

## A3. Migration 126's archive trigger under a bulk switch

```sql
CREATE TRIGGER tracks_archive_guard_trg
  BEFORE UPDATE OF archived_at ON public.tracks
  FOR EACH ROW EXECUTE FUNCTION public.archive_guard();
```
(`126:432-435`; body `126:396-427`)

`archive_guard` reads `v_actor uuid := auth.uid()` (`126:403`) and refuses unless `is_super_admin()`
**only when `v_actor IS NOT NULL`** (`126:413-416`). `auth.uid()` reads the `request.jwt.claims`
GUC, which is session state — **`SECURITY DEFINER` does not clear it.** So:

- **CMS calls a switch RPC with its own JWT** → `auth.uid()` is real, the super_admin check binds,
  every audit row carries `actor_id`. But no backend is in the loop to enqueue the rebuild (§A6).
- **Backend route calls it with the service role** → `auth.uid()` is NULL, the capability check is
  **skipped entirely**, and every audit row is written `actor_id = NULL, actor_role = 'service'`
  (`126:424`) — legal, because 126 relaxed `actor_id` for exactly these two actions
  (`126:161-164`). **The actor is lost.**

**Recommendation:** backend route (it must enqueue the rebuild, and it must check `is_super_admin`
in TypeScript since the trigger will not), plus **one dedicated audit row carrying the real actor**
(§A4). Do not smuggle the actor into `auth.uid()` — `set_config('request.jwt.claims', …)` through
PostgREST is fragile and would make the trigger's "no JWT ⇒ trusted" contract a lie.

**Two gaps in the trigger as it stands:**

1. **`BEFORE UPDATE` only.** A track **INSERTed with `archived_at` already set** is neither gated
   nor audited. The backfill creates exactly that shape.
2. **`NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at` returns early** (`126:407-409`), so a
   re-archive writes no row. Combined with `now()` being the *transaction* timestamp, a whole
   switch's audit rows share one `created_at` — which a banner can key on.

**Cost: one row per changed track per switch.** At Moosii's 69 tracks that is ≤69 rows against the
74 rows in `content_approvals` today (2026-11-14) — negligible on storage. The real cost is that
`content_approvals` stops being an approvals log. Either filter
`WHERE action NOT IN ('archive','unarchive')` wherever it is read as approval history, or use a
separate table.

## A4. Where to store the mode

`app_settings` is `(key text PK, value text NOT NULL, updated_at timestamptz)` — deliberately
generic (`064:54-59`), RLS-on with **no policy** (`064:82`), read by `src/lib/domain.ts` at boot and
by `content_edit_policy_guard` as its definer.

It *can* hold the mode, but not cleanly:

1. The CHECK is key-specific and hand-written (`064:71-74`: `key <> 'domain' OR value IN (…)`).
2. The banner needs **mode + actor + time**. `app_settings` has `updated_at` but **no actor** and
   no history — "who" and "previous mode" are unavailable.
3. Boot **exits fatal on any read failure** of `app_settings` other than 42P01/PGRST205
   (`src/lib/domainCheck.ts`, `classifyDomainReadError`). Widening what lives there widens the
   blast radius of a mistake.

**Proposal — a dedicated table**, which also fixes §A3's lost actor:

```
catalog_mode_switches(
  id, mode text NOT NULL CHECK (mode IN ('live','mem','mdm')),
  previous_mode text, actor_id uuid NULL → auth.users, actor_role text,
  switched_at timestamptz NOT NULL DEFAULT now(),
  tracks_archived int, tracks_unarchived int)
```

Current mode = the latest row (the `user_facts_latest` pattern, `071`). Append-only; the banner
reads mode + actor + time from one row and switch history comes free. RLS: signed-in read (the
banner needs it), service write.

## A5. Every archive/unarchive path today

**There is no backend archive route.** `src/routes/lessons.ts` has 9 routes, none archives.
`archived_at` appears in `src/` only as a read filter (`classifyCatalog.ts:39`) and an error string
(`lessonPublish.ts:55`).

Archival is **100% CMS-direct**, two call sites:

| path | code | after-effects |
|---|---|---|
| track | `moosii-cms/src/data/tracks.ts:113-128` — `.from('tracks').update({ archived_at: … }).eq('id', id)` | `markMlpStale()`, then cache invalidation |
| lesson | `moosii-cms/src/data/lessons.ts:446-458` — same shape on `lessons` | **no** `markMlpStale()`, cache invalidation only |

`markMlpStale()` (`moosii-cms/src/data/priorities.ts:10-17`) calls `supabase.rpc('mark_mlp_stale')`
and **swallows errors**. That RPC is created by no migration in this repo — 094's comment is the
only mention. **Check its body (§A8.5)**: if it only flips a flag, nothing today recomputes plans
after an archive, and the mode switch would be the first path that does.

**Where to enforce "manual archive clears `mode_archived`": a trigger, in this shape.** The switch
and a manual archive write the same column, so a trigger cannot tell them apart by value. The clean
discriminator is **whether the writer named `mode_archived` at all**:

```
BEFORE UPDATE ON tracks, FOR EACH ROW:
  if NEW.archived_at IS DISTINCT FROM OLD.archived_at
     and NEW.mode_archived IS NOT DISTINCT FROM OLD.mode_archived   -- writer stayed silent
  then NEW.mode_archived := false
```

The switch sets both columns in one UPDATE and passes through untouched; every existing CMS-direct
path sets only `archived_at` and is forced to `false` — **no CMS change required**, which matters
because the CMS is a separate seat. No session GUC, no "am I the switch" flag.

**Trigger ordering:** same-table, same-timing triggers fire alphabetically.
`tracks_archive_guard_trg` sorts before anything starting `tracks_mode_…`, so the audit row is
written before `mode_archived` is adjusted. Harmless (the audit does not record it), but name the
new trigger deliberately rather than by accident.

## A6. Enqueuing the rebuild

The mechanism exists and is the right one:

```ts
const rebuild = await enqueueRebuildAllIfIdle({ reason: "catalog_mode_switch", correlationId: <switch id> });
res.json({ ..., ...describeRebuild(rebuild) });
```

`src/jobs/rebuildTrigger.ts` — `enqueueRebuildIfIdle` never throws, folds only into a **QUEUED**
rebuild and never a RUNNING one (the 2026-11-11 defect), and fails toward enqueuing.
`describeRebuild` returns `{ rebuild: "queued" | "coalesced" | "failed", rebuild_job_id }`, already
surfaced by the publish routes (`src/routes/lessons.ts:262-264`).

Two switch-specific notes:

- `await` it **after** the switch transaction commits, as publish does — and a *refused* switch must
  never enqueue (`lessons.ts:241-245` returns before `:262`).
- A switch is a worse coalescing candidate than a publish: it changes the pool for every user. The
  QUEUED-only rule handles it, but `rebuild: "coalesced"` must reach the banner, not be swallowed —
  "mode switched, plans rebuilding" vs "mode switched, rebuild pending".

**Duration: not measured, not guessed.** Run §A8.6. Shape: scope:all walks the user base calling
`loadUserMlpInputs` per user (`rebuildMlp.ts:452-530`) — one RPC + up to 3 queries each — so roughly
linear in users; today 3 (financial) / 10 (Moosii).

## A7. RL28

**`RL28` appears nowhere** in this repo, `moosii-cms`, or `moosii-rn`
(`grep -riE '\bRL[0-9]+\b'` over all `.md`/`.ts`/`.tsx`, excluding `node_modules`, returns nothing;
neither `docs/backlog.md` nor `moosii-cms/TODO.md` uses that numbering). Status cannot be reported
against a list not in the repos.

**The behaviour itself is delivered and live.** `publish_archived → 409`:

- `lesson_publish_blocker` returns `'publish_archived'` when the lesson's **or its track's**
  `archived_at` is non-null, checked **first** (`126:197-199`).
- Enforced at both points from one definition — the RPC (`126:294-300`) and
  `lessons_publish_guard_trg`, which also covers Supabase-direct UPDATE and INSERT
  (`126:373-379, 388-390`).
- Mapped by `mapPublishError` → `{ status: 409, code: "publish_archived", message: "This lesson, or
  its track, is archived. Unarchive it before publishing." }` (`src/lib/lessonPublish.ts:55`),
  returned at `src/routes/lessons.ts:238-244`.
- Covered by `src/routes/__tests__/capabilityGates.test.ts:66`.
- Applied on both projects (high-water financial 126 · Moosii 126) and deployed — both services
  report `d857d6a` from `GET /version`, `{"status":"ok"}` from `/health`.

Open half: the **CMS** must render the 409 `publish_archived` code usefully, because in non-live
modes editors will hit it in normal use. Slice-4 work in the other seat.

## A8. Read-only SQL for Mark

All pure `SELECT`. Run each against both projects.

**A8.1 — `created_by` distribution with the active/archived split**

```sql
SELECT coalesce(created_by, '(null)') AS created_by,
       count(*) AS total,
       count(*) FILTER (WHERE archived_at IS NULL)     AS active,
       count(*) FILTER (WHERE archived_at IS NOT NULL) AS archived,
       CASE WHEN coalesce(created_by,'') = 'mooselist' THEN 'live' ELSE 'legacy' END AS proposed_group
FROM public.tracks
GROUP BY 1, 5
ORDER BY total DESC;
```

Measured 2026-11-14 (re-run to confirm): **Moosii** `mooselist` 30 · `legacy` 14 ·
`milestone-batch-2026-07` 10 · 3 emails · 12 NULL = 69. **financial** `migration_084` 6 · 1 email = 7.

**The proposed backfill gives financial ZERO `live` tracks** — all 7 land in `legacy`, which the
switch never touches. financial needs its own rule (or `migration_084` → `live`), or mode switching
is a no-op there. Settle this before the migration is drafted.

**A8.2 — rolled up**

```sql
WITH g AS (
  SELECT id, track_name, archived_at,
         CASE WHEN coalesce(created_by,'') = 'mooselist' THEN 'live' ELSE 'legacy' END AS grp
  FROM public.tracks
)
SELECT grp, count(*) AS tracks,
       count(*) FILTER (WHERE archived_at IS NULL) AS active
FROM g GROUP BY 1 ORDER BY 1;
```

**A8.3 — cross-group questionnaire host/target pairs under the backfill** (all four target paths,
including the tag indirection and `defer_topic`)

```sql
WITH g AS (
  SELECT id, CASE WHEN coalesce(created_by,'') = 'mooselist' THEN 'live' ELSE 'legacy' END AS grp
  FROM public.tracks
),
pairs AS (
  SELECT q.id AS q_id, q.questionnaire_name, 'questionnaire_response.track' AS via,
         q.track_id AS host, qr.track_id AS target
    FROM public.questionnaire q
    JOIN public.questionnaire_response qr ON qr.questionnaire_id = q.id
   WHERE qr.track_id IS NOT NULL
  UNION ALL
  SELECT q.id, q.questionnaire_name, 'questionnaire_response.tag', q.track_id, ttm.track_id
    FROM public.questionnaire q
    JOIN public.questionnaire_response qr ON qr.questionnaire_id = q.id
    JOIN public.track_tag_map ttm ON ttm.tag_id = qr.tag_id
   WHERE qr.tag_id IS NOT NULL
  UNION ALL
  SELECT q.id, q.questionnaire_name, 'answer_action.track', q.track_id, qaa.track_id
    FROM public.questionnaire q
    JOIN public.questionnaire_questions qq ON qq.questionnaire_id = q.id
    JOIN public.questionnaire_answers  qa ON qa.question_id = qq.question_id
    JOIN public.questionnaire_answer_actions qaa ON qaa.answer_id = qa.id
   WHERE qaa.track_id IS NOT NULL
  UNION ALL
  SELECT q.id, q.questionnaire_name, 'answer_action.tag', q.track_id, ttm.track_id
    FROM public.questionnaire q
    JOIN public.questionnaire_questions qq ON qq.questionnaire_id = q.id
    JOIN public.questionnaire_answers  qa ON qa.question_id = qq.question_id
    JOIN public.questionnaire_answer_actions qaa ON qaa.answer_id = qa.id
    JOIN public.track_tag_map ttm ON ttm.tag_id = qaa.tag_id
   WHERE qaa.tag_id IS NOT NULL
  UNION ALL
  SELECT q.id, q.questionnaire_name, 'defer_topic', q.track_id, q.defer_topic
    FROM public.questionnaire q
   WHERE q.defer_topic IS NOT NULL
)
SELECT p.via, p.questionnaire_name,
       gh.grp AS host_group, gt.grp AS target_group, count(*) AS rows
FROM pairs p
LEFT JOIN g gh ON gh.id = p.host
LEFT JOIN g gt ON gt.id = p.target
WHERE gh.grp IS DISTINCT FROM gt.grp
GROUP BY 1,2,3,4
ORDER BY 1,2;
```

Empty = the same-group trigger can be added with no data repair. Any rows = fix those first, or the
trigger refuses existing config.

**A8.4 — settle the `questionnaire` RLS gap (leak 2)**

```sql
SELECT tablename, policyname, cmd, roles, qual
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('questionnaire','questionnaire_questions','questionnaire_answers')
ORDER BY tablename, policyname;
```

**A8.5 — what `mark_mlp_stale` actually does (§A5)**

```sql
SELECT pg_get_functiondef(oid) FROM pg_proc
WHERE oid = 'public.mark_mlp_stale()'::regprocedure;
```

**A8.6 — scope:all rebuild duration (§A6)**

```sql
SELECT id, status, created_at,
       finished_at - started_at AS duration,
       jsonb_pretty(result) AS result
FROM public.jobs
WHERE type = 'rebuild_mlp' AND input->>'scope' = 'all'
ORDER BY created_at DESC
LIMIT 10;
```

---

# B. Test accounts

## B1. Every table keyed to a user or a child

58 tables carry a user key; 4 carry a child key. Derived from `src/types/database.types.ts`
(generated from **Moosii**) cross-checked against the migrations. Two caveats: **(a)** financial-only
tables (`demo_outcome_series`, `demo_outcome_aggregate`, migration 106) are **absent from the types
file** and added here by hand; **(b)** FKs and ON DELETE for pre-BuildShip tables are in no
migration here — run §B2's catalog query before trusting them.

### Identity / admin — never touch

`user` (but see the conflict), `admin`, `profiles`, `free_trial`, `account_types`, `accounts`,
`payment_history`, `recurring_invoices`, `transactions`, `subscription_plans`.

**⚠ The spec and the schema conflict.** "Reset NEVER touches the user row" — but three things the
reset must change live **on the `user` row**:

| column | why |
|---|---|
| `onboarding_complete` | `'full'` = "re-onboards as new". Left `true`, the app never shows onboarding and `full` silently degrades to `activity` |
| `has_seen_mlp_intro`, `has_seen_lesson_intro`, `has_seen_questionnaire_intro` | same — the intros *are* the onboarding experience |
| `moosies` | the **running balance** of `moosie_awards` (`111:95-97`). Delete `completed_items` + `moosie_awards` and leave it, and the account shows a balance with no ledger |

`display_name`, `name`, `gender`, `birth_date`, `parenting_status`, `financials`,
`daily_reminder_time` are profile/onboarding data on the same row.

**Recommendation: restate the rule as a column denylist** — never `id`, `email`, `role`,
`can_review_editorial`, `can_approve_clinical`, `can_publish`, `is_verified`, `auth_provider`. That
preserves the intent (the super_admin CMS logins survive) and lets `full` actually work. As written,
the rule makes `'full'` impossible.

### Onboarding — `full` only

| table | key | note |
|---|---|---|
| `children` | `parent_id` → `"user"` | |
| `user_demographic_responses` | `user_id` | feeds `base_tracks` (`045:41-46`). Keeping it at `activity` depth is **correct** — the plan rebuilds the same shape |
| `user_configurations` | `user_id` | per-user limits/fees |
| `user_settings` | `user_id` | financial display prefs |
| `user_tracks`, `user_track_weights` | `user_id` | legacy/unused, but user-keyed |
| `"user"` onboarding columns | — | see the conflict |

### Activity — both depths

| table | key | note |
|---|---|---|
| `completed_items` | `user_id` | ⚠ **INSERT trigger** → `trigger_add_moosies` → `moosie_awards` + `"user".moosies` (`111:108-146`) |
| `user_lesson_progress` | `user_id` | |
| `user_segement_track` | `user_id` | |
| `user_questionnaire_progress` | `user_id` | |
| `questionnaire_user_answers` | `user_id` → `"user"` CASCADE (`047a:93`) | |
| `quiz_user_progress` | **none — see below** | |
| `user_mlp`, `user_mlp_v2`, `user_mlp_bs_backup` | `user_id`, no FK | the plan; rebuilt, not just deleted |
| `user_mlp_mods` | `user_id` | manual + classify track mods |
| `user_track_activations` | `user_id`, no FK | classify audit |
| `user_update_events` | `user_id`, `child_id` | classify input |
| `user_update_signals` | `event_id` CASCADE (`016:38`) | **the deferral input (§A2)** |
| `distress_detections` | `event_id` CASCADE (`025:75`), `user_id`, `child_id` | |
| `health_detections` | `event_id` CASCADE (`081:61`), `user_id`, `child_id` | |
| `user_activity_followups` | `user_id` → auth.users CASCADE (`113:102`) | |
| `moosie_awards` | `user_id` → `"user"` CASCADE (`111:80`) | balance conflict, above |
| `starred_items` | `"user id"` (literal space in the name) | |
| `user_template_history` | `user_id` | response-template rotation |
| `notifications`, `notification_log` | `user_id` | |
| `child_milestones` | `child_id`, **no FK** | "milestone facts"; `contentTeardown.ts:84-86` documents the no-FK choice as deliberate |
| `user_tag` | `user_id` | |

**`quiz_user_progress` has no user column at all** — `(id, lesson_id, question_id, answers_ids,
created_at, updated_at)`. It cannot be reset per user, and cannot be *correct* per user. Either dead
or a real bug; out of scope here.

### `user_facts` — needs a decision, not a classification

`user_facts` carries six provenances: `source ∈ {platform_api, cms, manual, derived, estimated,
seed}` (`101:31`, `104:27`). On financial, `platform_api` rows are the **partner intake**
(`POST /facts`) and `seed` rows are the demo outcome story (`106`). Wiping those at `activity` depth
would break the demo's plan, because `fact_track_rules` routes tracks off them (074's facts arm).

**Recommendation: split by `source`.** `activity` deletes `derived` + `manual`; `full` additionally
deletes `platform_api` + `estimated`; `seed` is never deleted. `user_facts` is append-only with
RESTRICT on the vocabulary FK (`070:67`) — deleting *rows* is fine; the RESTRICT protects
`fact_values`.

### Other

`demo_outcome_series`, `demo_outcome_aggregate` (financial only, `106`) — seeded demo narrative,
labelled `"seeded"`, read by `GET /demo/outcomes`. Not parent activity; **do not wipe at either
depth.** Social tables (`chat`, `message`, `friends`, `group_*`, `posts`, `comments`, `replies`,
`reports`, `invitees`, `user_groups`, `user_feed_posts`) — present, mostly unused; decide once
rather than per table. `user_month_group` has no user key despite the name.

## B2. Delete order, blockers, triggers

**No `ON DELETE RESTRICT` FK points at a per-user table.** Every RESTRICT in the repo guards
**content or vocabulary**: tracks (`040:41,49,57,65`), milestones and tags (`047a:159,161`),
demographic questions/answers (`038:39,47`), `fact_values` (`070:67`, `072:54`, `073:52`, `106:46`).
An activity reset should hit **no 23503**. Confirm with the catalog query below.

**Cascades that do the work:**

- `user_update_events` → `user_update_signals` (`016:38`), `distress_detections` (`025:75`),
  `health_detections` (`081:61`) all CASCADE.
- `user_activity_followups.verified_fact_id → user_facts(id) ON DELETE SET NULL` (`113:111`) — so
  `user_facts` can be deleted **before** followups; the link just nulls.

**Recommended order** (leaf-first and explicit — do not rely on cascade for anything you mean to
delete, per the `purgeImages` lesson in invariant 5):

1. `moosie_awards` → then reconcile `"user".moosies`
2. `completed_items`, `user_lesson_progress`, `user_segement_track`, `starred_items`
3. `user_activity_followups`
4. `user_questionnaire_progress`, `questionnaire_user_answers`
5. `user_mlp`, `user_mlp_v2`, `user_mlp_bs_backup`, `user_mlp_mods`, `user_track_activations`
6. `user_facts` (filtered by `source`), `child_milestones`
7. `user_update_events` (signals + both detections cascade)
8. `user_template_history`, `notifications`, `notification_log`, `user_tag`
9. **`full` only:** `user_demographic_responses`, `user_configurations`, `user_settings`,
   `user_tracks`, `user_track_weights`, `children`, then the `"user"` onboarding columns
10. **Recompute** — `rebuild_user_mlp` for that user, not a scope:all

**Triggers on delete.** Every trigger created by this repo's migrations is **content**-scoped:
`sub_segments_reset_review_trg` is `AFTER INSERT OR DELETE OR UPDATE OF title, content, image,
sequence ON sub_segments` (`066:111`), `quiz_answers_reset_review_trg` likewise (`066:159`), and the
storage-delete trigger (`087:180`) is on `storage.objects`. **None is on a user-keyed table.**

The one that matters runs on the other side: `completed_items_insert_trigger` → `trigger_add_moosies`
(`111:108-151`) fires on **INSERT**, not DELETE — so deleting `completed_items` does **not** reverse
the award. That is the mechanical reason `"user".moosies` must be reconciled explicitly.

**`child_milestones.child_id` has no FK** (`019:54-56`), nor do `user_update_events.child_id`,
`distress_detections.child_id`, `health_detections.child_id`. A `full` reset deleting `children`
**orphans** those rows instead of failing. Delete them by `child_id` explicitly, before the children.

**Run before writing the function** — the only way to see the legacy FKs the migrations do not record:

```sql
-- every FK pointing AT a per-user table, with its delete action
SELECT con.conrelid::regclass AS child_table,
       a.attname              AS child_col,
       con.confrelid::regclass AS parent_table,
       CASE con.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                            WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
                            WHEN 'd' THEN 'SET DEFAULT' END AS on_delete
FROM pg_constraint con
JOIN LATERAL unnest(con.conkey) WITH ORDINALITY k(attnum, ord) ON true
JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
WHERE con.contype = 'f'
  AND con.confrelid::regclass::text IN (
    'public."user"', 'children', 'completed_items', 'user_facts',
    'user_update_events', 'user_activity_followups', 'user_mlp', 'user_mlp_v2',
    'moosie_awards', 'user_lesson_progress', 'questionnaire_user_answers')
ORDER BY 3, 1;

-- every non-internal trigger on the reset tables
SELECT c.relname AS tbl, t.tgname, pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname = 'public'
  AND c.relname IN (
    'user','children','completed_items','user_lesson_progress','user_segement_track',
    'user_questionnaire_progress','questionnaire_user_answers','user_mlp','user_mlp_v2',
    'user_mlp_mods','user_facts','user_update_events','user_activity_followups',
    'moosie_awards','starred_items','child_milestones','user_demographic_responses')
ORDER BY 1, 2;
```

## B3. Where `is_test_account` should live

**Recommendation: a column on `public."user"` — because migration 112 already built the guard you
need, and a separate table would not inherit it.**

### The decisive fact: `"user"` is privilege-locked, not policy-locked

112 revoked table-level writes and granted exactly the client-written columns
(`112:128-133`):

```sql
REVOKE INSERT, UPDATE ON public."user" FROM anon, authenticated;
GRANT UPDATE (display_name, name, gender, parenting_status, financials, birth_date,
              onboarding_complete, has_seen_mlp_intro, has_seen_lesson_intro,
              has_seen_questionnaire_intro) ON public."user" TO authenticated;
GRANT INSERT (id, email, daily_reminder_time, onboarding_complete) ON public."user" TO authenticated;
```

**A new column on `"user"` is therefore unwritable by any client the moment it is added** — no new
policy required, and the refusal is **42501 at the privilege layer**, which RLS's OR-ing cannot
defeat. 112's own header records that this is deliberate: *"A new client write to any other column
now fails 42501 until a migration grants it."* That is the strongest guard available in this schema
and it already exists.

### Why RLS alone would NOT be enough (the trap)

The live UPDATE policy set on `"user"` is **two policies that OR together**:

| policy | cmd | effect |
|---|---|---|
| `user_self_update` | UPDATE | own row (`docs/rls-sweep.md:188`; `111:40` and `112:26` both name it) |
| the `is_super_admin` UPDATE policy | UPDATE | `docs/FINDINGS-roles.md:151` — `user` is `is_admin` SELECT / `is_super_admin` INSERT, UPDATE, DELETE |

Policies **OR**, so `user_self_update` means **RLS by itself permits an account to write its own
row** — including a new flag. 112's header spells out what that cost before the column grants:
*"`role`, `can_review_editorial`, `can_approve_clinical`, `is_verified`, `email` … were ALSO
self-writable through `user_self_update` — a signed-in app user could make themselves super_admin."*
So: **do not add an RLS policy and call it a guard.** The column grant is the lock.

Full current policy set on `"user"`, from the docs (names and quals to be confirmed with the query
below — most policies predate the migrations folder, `FINDINGS-roles.md:135-136`):

| policy | cmd | qual |
|---|---|---|
| `user_self_select` | SELECT | `id = auth.uid() OR is_admin() OR auth.role() = 'service_role'` (`078:143-144`) |
| `user_self_update` | UPDATE | own row |
| *(is_super_admin)* | UPDATE | `is_super_admin()` |
| `"Enable insert for authenticated users only"` | INSERT | `WITH CHECK (id = (SELECT auth.uid()))` since 112 (`112:138-139`) |
| `user_self_insert` | INSERT | own row, super_admin, service (`112:35`) |
| *(is_super_admin)* | DELETE | `is_super_admin()` |

### The proposed guard — four layers, in order of strength

1. **Privilege (the real lock).** Add `is_test_account boolean NOT NULL DEFAULT false` and **grant
   nothing**. Then *assert* it in the migration's VERIFY block rather than assuming it:
   `has_column_privilege('authenticated', 'public."user"', 'is_test_account', 'UPDATE')` must be
   **false**, same for `anon`, and `anon`/`authenticated` must still hold no table-level UPDATE.
2. **RLS.** Add **no** policy. Document in the migration header *why* — the `user_self_update` OR is
   exactly CLAUDE.md's "policies OR together" trap, and the next reader will otherwise assume RLS
   covers it.
3. **Trigger (belt, and the audit row).** `BEFORE UPDATE OF is_test_account ON public."user"`, in
   126's `archive_guard` shape: refuse with `ERRCODE = 'check_violation'`,
   `HINT = 'test_account_not_permitted'` when `auth.uid() IS NOT NULL AND NOT is_super_admin()`;
   write the audit row in the same transaction. Note the first test accounts are Mark's and
   Michelle's **own super_admin logins**, so a super_admin flagging **themselves must be allowed** —
   the check is on the actor's role, never on `auth.uid() = NEW.id`.
4. **Backend route.** `PATCH /users/:id/test-account`, admin JWT + `is_super_admin` checked in
   TypeScript, service-role write. Because `auth.uid()` is NULL under the service role, layer 3
   skips its capability check on this path (§A3, same shape) — **so the route must write the audit
   row carrying the real actor itself.**

The reset function's own guard is separate and already specified: SECURITY DEFINER, RAISE unless the
target is flagged. Per 094 it must `REVOKE … FROM PUBLIC, anon, authenticated` and
`GRANT EXECUTE TO service_role`, or PostgREST exposes it at `/rest/v1/rpc/*` to anyone with the anon
key.

### Why not a separate table

A separate table needs its own RLS, its own policies, and becomes a 24th `is_super_admin` table with
the same OR-trap exposure — while **not** inheriting 112's column-grant lock, which is the only
thing that actually stops self-write. The one genuine advantage of a table is audit (who flagged
whom, when); take that from `content_approvals` (126 already widened `action` and `entity_type`) or a
small `test_account_audit` table, and keep the flag on `"user"`.

### SQL for Mark — confirm the live policy and grant set before drafting

```sql
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user'
ORDER BY cmd, policyname;

SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'user'
  AND grantee IN ('anon','authenticated')
ORDER BY grantee, privilege_type;

SELECT grantee, column_name, privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public' AND table_name = 'user'
  AND grantee IN ('anon','authenticated')
ORDER BY grantee, privilege_type, column_name;
```

Expected from 112: no table-level INSERT/UPDATE for either role; column UPDATE on exactly 10 columns
and column INSERT on exactly 4, for `authenticated` only.

## B4. Does moosii-rn actually re-onboard after a `full` reset?

**Yes — on the next cold start. Not while the app is open, and only if the reset writes `false`
rather than NULL.** Three concrete findings.

### The gate is a live DB read, and nothing caches it on disk

`app/_layout.tsx` AuthGuard branches on `profile?.onboardingComplete` (`:40, :63, :74-80`) and
redirects to `/(onboarding)/info/name` when it is false. `profile` comes from `useUserProfile`
(`src/hooks/useUserProfile.ts:17-48`), which queries `public."user"` every time the query is cold.

**There is no persisted client state to defeat it:**

- **No AsyncStorage anywhere** — `grep -rn "AsyncStorage"` over `moosii-rn` (excluding
  `node_modules`) returns **zero hits**.
- **No React Query persister.** `src/lib/queryClient.ts` is a plain `new QueryClient({ defaultOptions
  … })` — no `persistQueryClient`, no `createJSONStorage`. The cache is memory-only and dies with the
  process.
- **No auth-metadata copy.** `grep -rn "app_metadata\|user_metadata"` returns **zero hits** — the app
  never reads onboarding state off the JWT.
- SecureStore holds only the Supabase **auth session** (`src/lib/supabase.ts:14-27`) and one MLP
  freshness key (below). The session persisting is correct and desirable: the test account stays
  signed in through a reset.

### Gap 1 — `onboarding_complete` must be written `false`, never NULL

`src/hooks/useUserProfile.ts:42`:

```ts
onboardingComplete: data.onboarding_complete ?? true,
```

**NULL is coerced to `true`.** A reset that nulls the column instead of setting it `false` leaves the
app believing the account is onboarded, and `'full'` silently degrades to `'activity'`. The reset
must write a literal `false`.

### Gap 2 — the switch is not live; it lands on the next cold start

`useUserProfile` has `staleTime: 5 * 60_000` and the AuthGuard re-evaluates only when that query
refetches. There is **no `focusManager` wiring** (`grep` for `focusManager` / `refetchOnWindowFocus`:
zero hits), so React Query's focus refetch does not fire in RN. In practice the app must be
restarted. Two hooks are worse: `src/hooks/useFirstTimeFlag.ts:14` and `src/hooks/useMlpIntro.ts:13`
use `staleTime: Infinity`, so the `has_seen_*` intro flags never refetch within a session at all.

Not a blocker for a demo reset done between sessions — but the reset must be *documented* as
"restart the app", not "it reappears".

### Gap 3 — the MLP freshness marker survives the reset

`src/lib/mlpFreshness.ts` stores `mlp_last_recompute_<userId>` in **expo-secure-store**, and
`src/hooks/useMlpForegroundRecompute.ts:30-31` returns early when it is newer than
`STALE_THRESHOLD_MS` (6 hours, `mlpFreshness.ts:8`):

```ts
const last = await getLastRecomputeAt(userId);
if (last !== null && Date.now() - last < STALE_THRESHOLD_MS) return; // still fresh
```

So for up to 6 hours after a reset the app will **not** trigger its own recompute on cold start or
foreground. This is covered as long as the reset function **recomputes server-side itself** (as
specified) — the stale marker then only suppresses a redundant second recompute. It stops being
covered the moment the reset is changed to skip the recompute. Worth a line in the reset's contract.

### Files named

| file | role |
|---|---|
| `moosii-rn/app/_layout.tsx:40,55,63,74-87` | the AuthGuard; the only onboarding redirect |
| `moosii-rn/src/hooks/useUserProfile.ts:17-48` (`:24` staleTime, **`:42` the NULL coercion**) | the gate's data source |
| `moosii-rn/src/hooks/useCompleteOnboarding.ts:14-26` | the only writer of `onboarding_complete = true` |
| `moosii-rn/src/lib/queryClient.ts` | memory-only cache, no persister |
| `moosii-rn/src/lib/supabase.ts:14-27` | SecureStore session persistence (auth only) |
| `moosii-rn/src/lib/mlpFreshness.ts:8,13-30` | the 6-hour SecureStore freshness marker |
| `moosii-rn/src/hooks/useMlpForegroundRecompute.ts:27-50` | the early-return that reads it |
| `moosii-rn/src/hooks/useFirstTimeFlag.ts:14`, `useMlpIntro.ts:13` | `staleTime: Infinity` on the intro flags |
| `moosii-rn/app/(onboarding)/verify.tsx:95` | the only client INSERT into `"user"` |

**moosii-rn follow-ups (other seat — flagged, not actioned):** the `?? true` coercion at
`useUserProfile.ts:42` is the fragile one; it should be `?? false` so an unset column means
"not onboarded". Optionally clear the `mlp_last_recompute_*` key on sign-in.
