# FINDINGS — activity follow-ups ("Did it / I'll do it / Not for me")

2026-10-12 · Investigate-first · no DDL, no code, no commits. Both projects read in read-only sessions
(identity checked: financial `system_identifier 7678069749886157684`, domain `financial`; Moosii
`7481590244898220655`, domain `moosii`). moosii-rn (`3148a58`) and moosii-reader (`337f0d6`) read-only.
`docs/api-contract.md` read fresh (§3, §8, §9).

**The idea.** An activity (`lessons.kind = 'activity'`, migration 107) ends with three choices. **Did it** completes
it. **I'll do it** creates a pending follow-up that comes back after N days (set per activity), is asked at most
twice, and then lapses. **Not for me** dismisses it. Some financial activities auto-resolve when a named fact
reaches a target value. Follow-ups live **outside** the MLP. The algorithm and `mlp_item_pool` are frozen and out
of scope.

## TL;DR

- **The loop can be built without touching the MLP, the pool, check-in recurrence or `repeat_after_days`.** The
  trick: **every one of the three choices writes the ordinary lesson completion.** The activity then leaves the
  plan the way any lesson does (the `user_mlp_not_completed` anti-join). The follow-up lives in its own table and
  surfaces on its own. If "I'll do it" did *not* complete, the activity would sit at the top of the plan and block
  it. Lessons are always one-shot in the rebuild (`rebuildMlp.ts:623` re-includes only questionnaires), so nothing
  re-surfaces through the plan.
- **Nobody treats activities differently today.**
  - **RN:** doesn't know `kind` exists. Its generated types predate 107, and `useLesson.ts:25` doesn't select it.
  - **Reader:** shows activity UI ("Do" badge, a "Done" end card) but **writes nothing to Supabase**. "Done" is
    sessionStorage only.
  - **Backend:** writes no completions except `demo:reset` deletes and one hand-applied Sam seed.
- **⚠ Moosies are awarded TWICE per completion today, on both projects.**
  - The DB trigger `trigger_add_moosies` adds `user_configurations.moosi_to_add` (10) on every `completed_items`
    INSERT.
  - RN separately adds `lessons.points` (5) or `questionnaire.points` (7) with a client read-then-write.
  - So a first lesson completion = +15. This must be settled before follow-ups add a third award path (§6).
- **The single hook point for auto-resolve is `recordFacts`** (`src/facts/service.ts:64-72`). `POST /facts`,
  `derive_facts` and `seed_facts` all write through it, and nothing else writes `user_facts`.
  - It does **not** know old vs new values. It only checks for a clash at the same `observed_at`, and returns
    `written` (a count).
  - Resolve against `user_facts_latest` *after* the write. Require an observation dated after the commitment. Then
    no transition tracking is needed.
- **The email digest is not built** (FINDINGS-financial §F, decisions E1–E5). The follow-up fits it as a third
  event type next to `checkin_due` and `new_top`, with the same `email_sends` idempotency (§4).
- **Demo reset:** add the new table to `RESET_TABLES`. Nothing else is needed, since the activity's completion rows
  are already covered (§5).
- **Schema:** three nullable columns on `lessons`, plus one `user_activity_followups` row per (user, activity).
  Status and ask count are stored. *Due* and *lapsed* are derived in a view (§7).

---

## 1. Every writer of `completed_items` / `user_lesson_progress`

| Where | Writes | When | Activity-aware? |
|---|---|---|---|
| **RN** `src/hooks/useCompleteLesson.ts:28-35` | reads `completed_items` (user, item_id, `item_type='lesson'`) → `wasAlreadyCompleted` | every lesson finish | no |
| **RN** `useCompleteLesson.ts:37-42` | UPSERT `user_lesson_progress {user_id, lesson_id, is_completed:true}` on `(user_id, lesson_id)` | every finish, incl. retakes | no |
| **RN** `useCompleteLesson.ts:45-60` | INSERT `completed_items` (`item_type 'lesson'`, `item_id = lesson_id`, name, description, `with_quiz`, `score 0`) | first finish only (client-side existence gate, not atomic) | no |
| **RN** `useCompleteLesson.ts:64-72` | `awardMoosies(lessons.points)` (§6) | first finish only | no |
| …fired from | `app/(app)/lesson/[id].tsx:69-75` (no quiz: forward past last card) · `app/(app)/quiz/[lessonId].tsx:39-60` (quiz: Next on last question) | | |
| **RN** `src/hooks/useFinishQuestionnaire.ts:81-94` | INSERT `completed_items` (`item_type 'questionnaire'`, `score`) **every time** (no existence check, by design: recurrence reads the latest row) | questionnaire / check-in submit | n/a (branches on `questionnaire.kind`, :71) |
| **RN** same file :33-63, :96-122 | `user_questionnaire_progress`, `questionnaire_user_answers`, inline moosies, then `POST /mlp/recompute` | | |
| **Reader** | **nothing.** No insert/upsert/update/delete/rpc anywhere. `src/data/doneThisVisit.ts:1-26` and `CompletionCard.tsx:22-27,41-43` say so explicitly: "Done" goes to sessionStorage | | the only activity UI: `CompletionCard.tsx:11-12,49,60-62` (kind-specific copy), `KindBadge.tsx`, `PlanWidget.tsx:93` ("Let's do it"), `usePlan.ts:48-61` (reads `lessons.kind`) |
| **Backend demo endpoints** (`src/routes/demo.ts`) | nothing (all four routes are reads) | | |
| **`demo:reset`** `src/scripts/demoReset.ts` + `src/demo/reset.ts:17-25` | DELETEs both tables (and five others) for Sam + Sarah, keeping Sam's orientation seed (`isProtectedSeed`, :51-57); recomputes `user.moosies` | manual script, financial only | no |
| **Sam's seeded completion** (FINDINGS-demo-personas, "Seeded completion") | one hand-applied INSERT of each, 2026-09-30 | once | no |
| **Backend otherwise** | **no writer.** `rebuildMlp.ts:586`, `questionnaireStatus.ts:87` and `recordCheckinMilestones.ts:46` only read; `contentTeardown.ts:69-71` counts; DB functions: only `trigger_add_moosies` (fires on insert, writes `user.moosies`) | | |

**Live schema facts that matter (both projects identical):**
- `completed_items`: **no unique key** on `(user_id, item_id, item_type)`. 0 duplicate triples today. The only
  guard against a double lesson completion is RN's read-then-insert.
- `completed_items.user_id` FKs `public."user"`, **not** `auth.users`. So a parent with no `user` row cannot complete
  anything (CLAUDE.md "Users").
- No source/seed column, so a completion's origin (app, auto-resolve, seed) is invisible.
- `user_lesson_progress` has `UNIQUE (user_id, lesson_id)`.
- Policies after 105 are own-row / super_admin / service only.
- Activities live: financial has 1 ("Set a Statement-Date Reminder", published, priority 250); Moosii has 0.

**RN has no end card for activities:**
- `src/components/lesson/CompletionCard.tsx:10-30` takes `lessonName, withQuiz, onContinue` (no kind). It shows
  "Lesson complete!" or "Ready for the quiz?".
- A questionnaire has no end card at all (`questionnaire/[id].tsx:100` routes straight home).

## 2. Check-ins and `repeat_after_days` — confirmed separate

**How a check-in gets into a plan.** Exactly like any questionnaire:
1. It is a `mlp_item_pool` questionnaire-arm row whose **host** track is in `user_active_tracks_for_user`
   (`rebuildMlp.ts:459,506`).
2. `generateFullMLP` orders it, and `rebuild_user_mlp` writes `user_mlp`.
3. Clients read `user_mlp_not_completed`. RN (`useUpcomingMlp.ts:31-36`) only learns it's a check-in after loading
   `questionnaire.kind`.

**How `repeat_after_days` is scheduled.** It isn't scheduled. It is derived at rebuild time:
- `computeUserMlp` (`rebuildMlp.ts:567`) loads `completed_items`.
- `computeQuestionnaireDecisions` (:373) returns `{due, deferred}` from two interval sources:
  - diagnostics: score bands (`questionnaire_response.repeat_after_days`, 033);
  - check-ins: per answer (`questionnaire_answers.repeat_after_days`, 053, MAX).
  - Topic-mention deferral (042) also feeds this.
- Then **only questionnaires** drop out of the completed-exclusion (`:623`).
- Due-ness takes effect only when a recompute runs. RN recomputes on cold start / foreground when the plan is
  older than 6h (`useMlpForegroundRecompute.ts:35`, `mlpFreshness.ts:8`), after a questionnaire, and after
  onboarding. It does **not** recompute after a lesson.

**Confirmed: a follow-up loop needs none of this.**
- It reads its own table, gets its own N from `lessons`, and never adds a row to the pool or `user_mlp`.
- Invariants 1 and 8 are untouched, as long as nobody "helpfully" makes a pending follow-up re-include the
  activity in the plan. That would be a pool/rebuild change: flag it if it ever comes up.

**Rejected alternative.** Reusing check-in machinery (a `complete_activity` action on
`questionnaire_answer_actions`, FINDINGS-activities §6) fits Moosii verification *later*. But it would route the
follow-up through the plan and through the CHECK on `questionnaire_answer_actions` (live today:
`add_track | add_tag | record_milestone`). It isn't needed for this loop.

## 3. Facts: the single hook point, and old vs new

**The single write path.** Every `user_facts` write goes through `recordFacts` (`src/facts/service.ts:36-79`):

| Caller | File | `source` |
|---|---|---|
| `POST /facts` | `src/facts/router.ts:43` | partner (`platform_api`/`cms`/`manual`) |
| `derive_facts` (facts-derive/2) | `src/facts/derive/derive.ts:101-115` | `derived` / `estimated` |
| `seed_facts` | `src/facts/seed.ts:206-211` | `seed` |

- Nothing else in `src/` inserts `user_facts`. `demoSarahData.ts:158` only DELETEs Sarah's old seed rows.
- The order inside it: validate → `findExisting` → **one** `insertRows` (:64) → `enqueueRebuild` (:72).

**Hook placement.** The natural slot is between those two calls, as a new injected dep:

```ts
// after insertRows succeeded, only when written > 0
await deps.resolveFollowups(v.userId, correlationId)   // non-fatal: catch + log, like the rebuild enqueue
```

- It is injected, so the ordering stays unit-testable with fakes, like the rest of `FactsDeps`.
- One place covers all three callers.

**Does derivation know old vs new?** No.
- `findExisting` (`db.ts`) fetches only rows at the **same** `observed_at`, to refuse contradictions. It never
  reads the previous current value.
- `recordFacts` returns `{written, rebuild_enqueued}` only.
- `derive.ts:95-118` computes the current values and writes them. It has no notion of a "change".
- Seed reads `user_facts_latest` first (`seed.ts`) to skip unchanged keys, but discards the old value.

**So resolve by state, not by transition.** After the write, a pending follow-up resolves when **both**:
1. `user_facts_latest` for the activity's `fact_key` equals its target value, **and**
2. there is a `user_facts` row with that value and `observed_at > followup.created_at` (evidence *after* the user
   said "I'll do it").

This handles the awkward cases correctly:
- **Late-arriving older observation.** latest-wins (071) won't let it override.
- **Fact already at the target when the user committed.** No post-commit evidence, so no instant fake
  resolution.
- **Redelivery.** `written = 0`, so no hook run, and the resolve is idempotent anyway.

Old→new transition matching would need a new read in `recordFacts` and buys nothing here.

**Put the rule in SQL, call it from TS.** One `SECURITY DEFINER`-free SQL function,
`resolve_activity_followups(p_user_id uuid)`, that UPDATEs matching pending rows and returns them. Then:
- the definition lives in one place (the `lesson_with_quiz_derive` pattern, 063);
- the email job can call it before reading;
- it is `EXECUTE service_role` only (094 rule).

**Rejected: an `AFTER INSERT ON user_facts` trigger.** It is structural, but it hides behaviour from the job
result. And `recordFacts` already is the single path.

**Which facts can drive it** (FINDINGS-activities §4 still holds):
- Good: `has_direct_deposit → true`, `credit_utilization_band → low|moderate`, `has_emergency_buffer → true`
  (slow).
- Weak: `new_subscription_recent → false`, which flips by itself after 30 days.
- "Set a Statement-Date Reminder" has **no** fact. It resolves only by the user.
- **Moosii:** `POST /facts` is 404 there and derivation is financial-only, so auto-resolve is financial in
  practice. The columns are domain-agnostic, and stay NULL on Moosii.

## 4. Email cadence: where "you said you'd do X" slots in

**Nothing to change, because nothing is built.**
- No route, no job, no `email_sends` table, no Resend.
- The design is FINDINGS-financial **§F.2 + §F.3**:
  - a `pg_cron` tick every 15 minutes → `pg_net` → `POST /cron/email-digest` (a `CRON_API_KEY` in Vault, E2) →
    a coalesced `email_digest` job;
  - per user: `rebuildOneUser`, then pick events;
  - **send only when there is news** (E3);
  - email only (E1);
  - an IANA timezone column in the cadence slice (E4).
- How it picks content (proposed): events `checkin_due:<questionnaire_id>:<due_at>` (from
  `computeQuestionnaireDecisions`) and `new_top:<item_id>` (`user_mlp` position 1 ≠ the last emailed item). Each is
  reserved in `email_sends UNIQUE (user_id, event_key)` before sending.

**The slot.** A third event type, read from the follow-ups view (§7), not from the MLP:

```
followup_due:<followup_id>:<ask_number>      -- e.g. followup_due:7c1…:1
```

- Stable for the whole ask, so a 15-minute tick can't send it twice.
- A new ask number makes a new key.
- It counts as news under E3, so a due follow-up alone justifies an email.
- Order in the email: due check-in, then follow-up, then new top item.
- Call `resolve_activity_followups(user_id)` first, so nobody is reminded of something the bank data already
  shows done.

**Open question:** does a *sent email* count as one of the two asks? (§8, Q3)

## 5. Demo personas: what `demo:reset` must clear

- **Add `user_activity_followups` to `RESET_TABLES`** (`src/demo/reset.ts:17-25`) and to `SELECT_COLUMNS`. That is
  all.
- The design must keep the table compatible with the reset. The reset deletes `WHERE id = ANY(...) AND user_id =
  ANY(...)` and relies on "each has an `id` PK and a `user_id` column; none has a DELETE trigger" (:15-16). So:
  - `id` PK and `user_id` column;
  - **no DELETE trigger**;
  - no FK *into* it from a table outside the reset list.
- Add a case to `src/demo/__tests__/reset.test.ts`.
- **No protected seed.** Sam's only seed is the orientation *lesson*, not an activity. If a demo ever wants a
  pre-seeded pending follow-up (e.g. "Sam said he'd do it 3 days ago"), it needs an `isProtectedSeed` rule. Seeding
  it would break invariant-3 hygiene only on financial demo users, which is fine.
- **Already covered:** the activity's own `completed_items` / `user_lesson_progress` rows (same tables, deleted
  today). The moosies recompute (`moosiesAfterReset`) counts the remaining completions × `moosi_to_add`.
  - It **ignores the client `points` half** of the double award (§6). So a reset after a demo completion leaves
    moosies at trigger-only arithmetic. That's harmless (Sam = 10), but it shows the two award sources disagree.
- **Auto-resolve in a demo:**
  - Sam's facts are **derived** (MX test bank). Sarah's are derived from manual MX accounts (`demo:sarah-data`).
  - Exercising auto-resolve live means a new `derive_facts` run with *changed* MX data after the "I'll do it". For
    Sarah that's `demo:sarah-data` with a new transaction plan.
  - `seed_facts` rows: if the rule excludes `source = 'seed'` (recommended, as FINDINGS-activities §4), seeding
    can't demo it. **Q6.**
- **Reader:** `doneThisVisit` is sessionStorage. A reload already "resets" it, but the reader would need to call
  the new write route (§7) for the follow-up to exist at all.

## 6. Points / Moosies: server-side vs client-side

| Path | Side | What | Where |
|---|---|---|---|
| `trigger_add_moosies` | **server (DB)** | `user.moosies += user_configurations.moosi_to_add` on **every** `completed_items` INSERT (lesson or questionnaire, any source) | AFTER INSERT trigger `completed_items_insert_trigger`, both projects |
| `useAwardMoosies` | **client** | read `user.moosies`, write back `+ lessons.points`. Not atomic: two concurrent awards lose one | `moosii-rn/src/hooks/useAwardMoosies.ts:11-25`, from `useCompleteLesson.ts:69-71` (first completion) |
| inline in `useFinishQuestionnaire` | **client** | same read-then-write, `+ questionnaire.points` | `useFinishQuestionnaire.ts:96-113` |
| streak | derived | view `completed_items_streak` (read-only; RN `useStreak.ts:28`) | |
| reader / backend routes | none | no awards | |

**Live values:**
- `moosi_to_add` = 10 for all financial configs (3) and 5 of 6 Moosii configs (one is 0).
- `lessons.points` = 5 on every lesson, both projects.
- Moosii `questionnaire.points` = 7. Financial has no questionnaires.

**⚠ Double award.** Read from code, not observed live. A first lesson completion in RN fires the trigger (+10)
**and** the client award (+5). A questionnaire gets +10 and +7. One of the two is unintended. Probably the client
path was written without knowing the BuildShip-era trigger existed. It's a moosii-rn + schema decision. **Q1.**

**What it means for follow-ups:**
- Completing on all three choices fires the trigger on all three. So **"Not for me" and "I'll do it" earn moosies**
  unless awards change.
- The follow-up "Did it" (resolution) writes no new `completed_items` row, so it earns **nothing** today.
- Auto-resolve, server-side, earns nothing unless the SQL function awards.
- **Recommendation:** settle a single award source first. Then award the activity's points on `done` /
  `auto_resolved`, in one place (the write route / resolve function), not on the plan-clearing completion. That
  probably means the trigger stops firing for activity completions: a shared trigger on both projects, with the RN
  app as the other consumer (invariant 4).

## 7. Proposed schema (proposal only — no migration written)

### 7a. `lessons` columns (both projects, schema only)

```sql
ALTER TABLE public.lessons
  ADD COLUMN followup_after_days int,           -- NULL = no follow-up offered ("I'll do it" hidden)
  ADD COLUMN resolve_fact_key    text,          -- auto-resolve target (financial in practice)
  ADD COLUMN resolve_fact_value  text;

ALTER TABLE public.lessons
  ADD CONSTRAINT lessons_followup_days_range   CHECK (followup_after_days BETWEEN 1 AND 90),
  ADD CONSTRAINT lessons_followup_only_activity
      CHECK (kind = 'activity' OR (followup_after_days IS NULL AND resolve_fact_key IS NULL)),
  ADD CONSTRAINT lessons_resolve_pair
      CHECK ((resolve_fact_key IS NULL) = (resolve_fact_value IS NULL)),
  ADD CONSTRAINT lessons_resolve_fact_fk
      FOREIGN KEY (resolve_fact_key, resolve_fact_value)
      REFERENCES public.fact_values (fact_key, value) ON UPDATE RESTRICT ON DELETE RESTRICT;
```

- **Max asks stays a constant (2)**, in the view below, not a column. It's a product rule, not a per-activity
  setting. Add a column only if Mark wants it per activity.
- `fact_values` FK: authored vocabulary only, never an amount (invariant 12). RESTRICT keeps a target from silently
  vanishing. It needs `fact_values (fact_key, value)` unique (it is the PK pair per 069, verify at draft).
- The 064 edit guard and the 066 review reset touch **only** lessons' two content columns (066 header at
  :170-177). So editing these settings on a published activity needs **no re-approval**. Probably right, but it
  means the auto-resolve target is behaviour that never passes clinical/editorial review. **Q7.**
- **financial:** `GRANT SELECT (followup_after_days) ON lessons TO anon` only if the anon reader needs it. The demo
  reader is signed-in (`authenticated` has table SELECT), so it likely doesn't.
- `create_lessons_with_segments` doesn't need them (activities are hand-authored). Leave it alone (invariant 9;
  hash guard churn).
- Regenerate `database.types.ts`. moosii-rn's types also need a regen (they predate 107).

### 7b. `user_activity_followups`

```sql
CREATE TABLE public.user_activity_followups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,     -- 076 convention
  lesson_id      uuid NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE, -- matches completed_items
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','done','dismissed','auto_resolved')),
  after_days     int  NOT NULL CHECK (after_days BETWEEN 1 AND 90),   -- COPIED from lessons at creation
  ask_count      smallint NOT NULL DEFAULT 0 CHECK (ask_count BETWEEN 0 AND 2),
  next_ask_at    timestamptz NOT NULL,                                -- created_at + after_days; bumped per "not yet"
  last_asked_at  timestamptz,
  resolved_at    timestamptz,
  resolved_by    text CHECK (resolved_by IN ('user','fact')),
  resolved_fact_id bigint,                                            -- user_facts row that proved it (fact path)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, lesson_id),                                        -- one follow-up per user per activity
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK ((status = 'auto_resolved') = (resolved_by = 'fact')),
  CHECK (status <> 'done' OR resolved_by = 'user')
);
ALTER TABLE public.user_activity_followups ENABLE ROW LEVEL SECURITY;
-- own-row SELECT; admin SELECT (is_admin()); writes service-role only (through the route)
```

- **Only "I'll do it" creates a row.** "Did it" and "Not for me" at the end card are ordinary completions and need
  no row.
  - If Mark wants to measure "Not for me" rates, either create the row directly as `dismissed`, or (cleaner) treat
    it as analytics and leave it out. **Q2.**
- **`lapsed` is DERIVED, not stored** (the invariant-6 habit): `pending AND ask_count = 2 AND now() >=
  next_ask_at`. Nothing has to wake up to flip it, so no scheduler.
- **"Due" is derived:** `pending AND ask_count < 2 AND now() >= next_ask_at`.
- `after_days` is copied, so a later CMS edit doesn't move an existing promise.
- `resolved_fact_id` has no FK, deliberately. History is append-only, and `user_facts` deletes (Sarah's seed purge)
  must not be blocked.
- **No DELETE trigger**, `id` + `user_id` present → `demo:reset` compatible (§5).

**The read surface.** A `security_invoker` view (so RLS binds, per the CLAUDE.md trap):

```sql
CREATE VIEW public.user_activity_followups_due WITH (security_invoker = true) AS
SELECT f.*, l.lesson_name, l.description,
       CASE WHEN f.ask_count >= 2 THEN 'lapsed' ELSE 'due' END AS state
FROM user_activity_followups f
JOIN lessons l ON l.id = f.lesson_id
JOIN tracks  t ON t.id = l.track_id
WHERE f.status = 'pending' AND now() >= f.next_ask_at
  AND l.kind = 'activity' AND l.is_published
  AND l.archived_at IS NULL AND t.archived_at IS NULL;    -- archival is derived (invariant 6)
```

**Writes go through one app-facing backend route.** This is a proposal. Calling it from RN or the reader is that
seat's work.

```
POST /activities/:lesson_id/response      Authorization: Bearer <end-user JWT>   (actor from token, invariant 7)
Body: { choice: "did_it" | "will_do" | "not_for_me" }            // end card
      { choice: "did_it" | "not_yet" | "never_mind" }            // follow-up prompt (followup exists)
```

In ONE transaction:
1. insert-if-absent `completed_items` + upsert `user_lesson_progress`, the same columns `useCompleteLesson` writes;
2. on `will_do`, insert the follow-up `ON CONFLICT (user_id, lesson_id) DO NOTHING`;
3. on `not_yet`, `ask_count + 1`, `last_asked_at = now()`, `next_ask_at = now() + after_days`.

A route rather than RN direct writes, because:
- `next_ask_at` and the ask rule live in one place;
- the reader (demo) can use the same call with its demo JWT;
- it closes the client read-then-insert race on `completed_items`.

The end card writes completions server-side for the first time. It must honour the trigger's quirks: a
`user_configurations` row must exist, or `moosies + NULL` violates `user.moosies NOT NULL` (0 users lack one today).

## Risks

1. **Double moosies** (§6). Follow-ups would add a third award path to a system that already double-counts. Fix
   the award model first.
2. **Moosies for non-completion.** Writing `completed_items` on "I'll do it" / "Not for me" fires the trigger.
   Without a decision, users earn points for declining.
3. **`completed_items` has no unique key.** Two writers (RN and the new route) racing on the same activity can
   insert two rows: two awards, harmless to the plan. Consider a partial unique index `(user_id, item_id) WHERE
   item_type = 'lesson'`. 0 duplicates today. It must stay *off* questionnaires, which insert per answer by design.
   That's a schema change on a table the app writes, so name moosii-rn as the second consumer (invariant 4).
4. **RN is kind-blind.** Until moosii-rn reads `kind` and renders the three-choice card, an activity in the app
   completes as a lesson ("Lesson complete!"). No follow-up is ever created there. Its types predate 107. That is
   moosii-rn seat work.
5. **What counts as an "ask"** is undefined (app card shown? answered? email sent?). It decides whether the cap
   is "2 prompts" or "2 non-answers". Getting it wrong either nags or lapses silently.
6. **Moosii clinical.** A follow-up on a baby activity ("you said you'd do tummy time") is parent-facing advice
   copy.
   - It follows the activity's clinical approval and `safety_sensitive`.
   - **Age drift:** by `next_ask_at` the child may be past `max_child_age`. The due view should re-check age
     eligibility on Moosii, or the follow-up nudges an out-of-band activity. The MLP's age gate does not cover
     follow-ups.
   - Follow-ups must never compete with a distress response (invariant 11). They're separate surfaces today; keep
     them out of `/classify-update` responses.
7. **Auto-resolve on stale or lucky data.** `has_emergency_buffer` can flip for reasons unrelated to the activity.
   `new_subscription_recent` flips by itself. Only curate the good ones (§3). Excluding `seed` keeps demos honest
   but makes them harder to show.
8. **Edits bypass review** (§7a). The follow-up interval and fact target are behaviour outside the approval chain.
9. **Archival and deletion.** Deletion cascades (`ON DELETE CASCADE`; add a count to `contentTeardown.ts:69-71`).
   Archival and unpublish hide pending rows through the view but leave them `pending` forever. That's acceptable:
   they are derived out. Unarchive brings them back possibly long overdue, so the first ask after unarchive should
   probably reset `next_ask_at`.
10. **No timezone column yet** (E4). "After N days" is UTC days. That's fine for days-granularity, but the email
    slot inherits E4's open column.
11. **Kind flip.** The CHECK stops follow-up settings on a `kind='lesson'` row, but existing follow-up rows survive
    a flip. The view filters `kind='activity'`, so they go dark rather than wrong.

## Open questions for Mark

- **Q1 — DECIDED 2026-10-13:** the server is the only award path (migration 111: `moosie_awards` ledger, trigger pays
  the item's own points, activities 0; RN stops awarding in its own slice). Original question:
- **Q1.** Moosies: which source wins, the DB trigger (`moosi_to_add`) or the client (`lessons.points`)? Until
  decided, follow-up awards have nowhere clean to go.
- **Q2.** Should "Not for me" / an end-card "Did it" also get a follow-up row (for analytics), or only "I'll do
  it"? The proposal: only "I'll do it".
- **Q3.** Does an email reminder count as one of the two asks, or only an in-app prompt the user answered?
- **Q4.** Points for a follow-up "Did it" and for auto-resolve: same as the activity's points, a bonus, or none?
- **Q5.** In-app surface for a due follow-up: a card above the plan (RN/reader read `user_activity_followups_due`)?
  That's moosii-rn / moosii-reader seat work. Confirm it stays visually separate from the plan, so nobody asks for
  it to be merged into `user_mlp`.
- **Q6.** Should seeded facts ever auto-resolve? This matters for demos.
- **Q7.** Should changing `followup_after_days` / the fact target on a published activity require re-approval?
- **Q8.** Max asks: a global constant 2 (proposed) or per activity?

## Follow-ups for other seats (not done here)

- **moosii-rn:**
  - regen types (107+);
  - read `lessons.kind`;
  - add a three-choice activity end card and call the route;
  - add a due-follow-up card;
  - settle the client moosies award (Q1).
  - Its `CLAUDE.md:336-346` still says `wasAlreadyCompleted` reads `user_lesson_progress`, but the code reads
    `completed_items` (`useCompleteLesson.ts:24-27`).
- **moosii-reader:** replace sessionStorage "Done" with the route for activities; show due follow-ups.
- **moosii-cms:** fields for `followup_after_days` + fact target on the activity editor.
