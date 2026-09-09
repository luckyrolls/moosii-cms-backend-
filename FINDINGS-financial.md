# FINDINGS — second-domain (financial) deployment readiness

Investigation only. No code changed, no migration applied, no prompt row touched, no push.
Read fresh against `CLAUDE.md`, `docs/api-contract.md`, the MLP code and migrations on
2026-09-09 at commit `93ff65c`. Every claim carries a `file:line` ref. Where something
could not be verified from the repo it is marked **UNVERIFIED** and says why.

**FLAG (per brief):** sections A, B and the risk list touch the FROZEN MLP algorithm's
inputs (`src/mlp/generateFullMLP.ts:1-12`). Nothing here modifies it; one finding (A.7)
is a reproduced hang inside it and is reported, not fixed.

**What was executed:** one isolated run of the pure `generateFullMLP` function with
synthetic inputs and a 15 s kill timeout (scratchpad script, not committed). A read-only
probe of the live `user_mlp_data` view was attempted and **blocked by the permission
classifier**, so the view's zero-children behaviour is inferred from code comments only.

---

## A. Zero-children behaviour

Definition used throughout: a user with a valid Supabase session and **no row in
`children`** where `children.parent_id = <uid>` (`children` has no FK on `parent_id`;
`src/types/database.types.ts:405-437`).

### A.1 `POST /mlp/recompute` — `src/routes/mlp.ts:81-110`
- Token → `userId` from `supabase.auth.getUser` (`src/routes/mlp.ts:91-93`). No `user`
  row, no `children` row required. **Passes.**
- `recordCheckinMilestones(userId)` (`src/routes/mlp.ts:104` →
  `src/mlp/recordCheckinMilestones.ts:96-143`): resolves candidate facts first; if the user
  has completed a check-in with a `record_milestone` action, it counts children
  (`:103-105`) and hits `childCount !== 1` (`:107-118`) → **writes nothing**, logs one
  structured skip per fact, returns. Never throws (`:135-142`). **Gate closed** (fact
  writer structurally off for zero-children users).
- `rebuildOneUser(userId)` (`src/routes/mlp.ts:105` → `src/jobs/handlers/rebuildMlp.ts:673-691`).
  Calls `computeUserMlp` then the `rebuild_user_mlp` rpc (`:677-680`), which is
  `DELETE … ; INSERT … FROM jsonb_array_elements(p_items)` (`migrations/017_rebuild_user_mlp_cutover.sql:31-51`).
  An empty `items` array → deletes any old rows, inserts none, returns 0 →
  `200 { ok:true, items_written: 0 }`. **Empty path, no throw.**

### A.2 `computeUserMlp` — `src/jobs/handlers/rebuildMlp.ts:567-669`
- `loadUserMlpInputs` (`:572`, see A.3).
- `ageMonthsUsed = overrides.ageMonthsOverride ?? childAgeMonths` (`:575`) → **`null`** on
  the real path (no override).
- Completed-items + questionnaire due/deferral (`:582-625`) are user-keyed, not
  child-keyed → unaffected.
- Milestone suppression (`:630-638`, see A.5) → `[]`.
- The frozen call (`:642-652`):
  - `ages: ageMonthsUsed !== null ? [ageMonthsUsed] : []` (`:646`) → **`[]` (an empty
    array — not `null`, not `undefined`, not `0`).** Answering the brief's question
    directly: `ages: [ageMonthsUsed]` is never built when there is no youngest child; the
    ternary substitutes `[]`.
  - `youngestAgeMonths: ageMonthsUsed` (`:647`) → **`null`**.

### A.3 `loadUserMlpInputs` — `src/jobs/handlers/rebuildMlp.ts:453-527`
1. Active tracks via `user_active_tracks_for_user` rpc (`:458-460`). The function's arms
   (`migrations/045_archive_exclude_tracks_active_set.sql:35-103`):
   - `base_tracks` (`:40-46`) — demographic responses ⨝ rules. Child-independent. Works.
   - `default_tracks` (`:47-51`) — **`FROM user_mlp_data u CROSS JOIN new_user_tracks`**.
     Requires a `user_mlp_data` row for the user. `user_mlp_data` is a VIEW whose
     definition is NOT in the repo (types only: `src/types/database.types.ts:6307-6317`,
     columns `child_count`, `youngest_age_in_months`, `financials`, `gender`,
     `parenting_status`, `user_id`). The backend's own comment says a row exists only for
     users with "at least one child with valid birth data" (`rebuildMlp.ts:700-701`).
     **UNVERIFIED (probe blocked).** Two branches:
     - (a) view is an inner join on `children` → **zero-children user has NO row → the
       default-tracks arm is EMPTY → no `new_user_tracks` for them.** (Consistent with the
       comment.)
     - (b) view is a left join from `user` → row exists with `child_count` 0/NULL and
       `youngest_age_in_months` NULL → defaults apply.
     Either way `youngest_age_in_months` is NULL.
   - `questionnaire_track_actions` (`:56-79`) and `latest_user_mod` (`:80-95`) — user-keyed,
     unaffected. Final `JOIN tracks … archived_at IS NULL` (`:97-102`).
   - So the zero-children track set = demographic ∪ questionnaire-routed ∪ manual/classify
     mods, **plus defaults only in branch (b)**.
2. `track_type` enrichment (`:467-482`) skipped when `trackIds` is empty (`:468`).
3. `user_mlp_data` query `.maybeSingle()` (`:494-500`): no row → `mlpData` null →
   `num(undefined)` → **`null`** (`:500`; `num` at `:21-25`). A row with NULL age → also
   `null`. No throw either way (`dErr` is only a transport error).
4. Pool (`:503-524`) is guarded `if (trackIds.length > 0)` (`:504`) → zero tracks ⇒
   `pool = []` (**empty path**); some tracks ⇒ every published `mlp_item_pool` item in
   them, no age filtering at this layer.

### A.4 `isAgeEligible` (pool filter) — `src/mlp/generateFullMLP.ts:91-101`
`if (youngestAgeMonths === null || youngestAgeMonths === undefined) return true;` (`:96`).
And the filter itself only runs when the age is non-null (`:172-176`). **Gate OPENS
completely:** every lesson passes regardless of `min_child_age`/`max_child_age`
(`migrations/046_…:33-34`), and every questionnaire passes regardless of
`questionnaire.age` (wired as `min_child_age` by `migrations/041_…:51`; header `:17`). `removedByAge = 0`.

### A.5 `computeMilestoneSuppressionDetail` — `src/jobs/handlers/rebuildMlp.ts:56-123`
Early-outs in order: no questionnaires in pool (`:63`); no mapped questionnaires (`:77`);
youngest-child query (`:80-87`) returns `[]` → `childId` undefined → **`return []`**
(`:92-93`, "no child → nothing to suppress against"). Never throws. **Gate CLOSED for
suppression:** a zero-children user can never have a questionnaire suppressed, so
"retire on Yes" (contract §2j, `docs/api-contract.md:1633`; §2j `:1190-1206`) never fires; a
recurring check-in repeats on its cadence forever.

### A.6 `generateFullMLP` age-bracket weighting — `src/mlp/generateFullMLP.ts:103-227`
- `numericAges = []` (`:119-121`) → `activeBrackets = []` → **`totalAgeWeight = 0`** (`:135`).
- Non-`Age` tracks: weight unchanged (`:186`).
- Any track with `track_type === "Age"` (`:182`): `weight * (0 / totalTrackWeight)` →
  **adjusted weight 0** (`:184`).

### A.7 REPRODUCED HANG (frozen algorithm; report only)
With any active `Age`-type track and `ages = []`:
`minWeight = 0` (`:211`) → `trackCycles`: the Age track `round(0/0) = NaN`, the others
`round(w/0) = Infinity` (`:213-217`) → `maxCycles = Math.max(NaN, …) = NaN` (`:220`) →
the sequence-building loop never runs (`:221-227`) → `weightedSequence = []` → Phase 1
(`:231-264`): nothing is ever shifted, `addedInThisCycle` stays false, and `:261-263`
re-arms `hasItemsRemaining = some bucket non-empty` → **infinite `while` loop**.

Isolated execution (pure function, synthetic input, 15 s kill):

| case | result |
|---|---|
| `Age`-type track + `ages:[]`, `youngestAgeMonths:null` | **HUNG** (killed at 15 s) |
| no `Age` track + null age | 2 items, `trackWeights {A:2,B:1}` |
| zero tracks | 0 items, no hang |
| any track with `weight = 0`, real age | **HUNG** (same mechanism, children-independent) |
| `Age` track + real age (control) | 2 items, `A:1.33` |

`generateFullMLP` is synchronous on the Express event loop, so one such user pegs the
whole process: every route including `/health` (`src/index.ts:36`) stops answering →
Render restarts the instance → the next `/mlp/recompute`, `GET /mlp/:user/preview`
(no `age_months`), or `rebuild_mlp scope:all` re-triggers it. `scope:all` iterates
`user_mlp_data` rows only (`rebuildMlp.ts:703`), so under branch A.3(a) the batch skips
zero-children users, but `/recompute` and `/preview` do not.

Whether this already bites Moosii depends on whether any live track has
`track_type = 'Age'` exactly (free-text column, ~15 inconsistent values per
`CLAUDE.md` "Not yet built / parked") **and** a user with NULL `youngest_age_in_months`
exists (the `birth_month = 0` bug, `docs/questionnaire-evolution-roadmap.md:229`, is a
plausible source). **UNVERIFIED live.**

### A.8 `GET /mlp/:user_id/preview` — `src/routes/mlp.ts:20-35` → `src/mlp/mlpPreview.ts:45-72`
- No `age_months`: identical to A.2–A.7 (including the hang). Returns
  `{ child_age_months: null, age_months: null, items: [] | <unweighted plan> }`. Contract
  already promises `200 items: []` for an unknown user (`docs/api-contract.md:1822`).
- With `age_months=N`: `ageMonthsUsed = N` (`rebuildMlp.ts:575`) → the age gate and the
  brackets behave as if a child of N months existed. **The preview can show a plan the
  real recompute can never produce for that user** (no child ⇒ real path is always the
  null-age path). Not a crash; a misleading inspector.

### A.9 `GET /mlp/:user_id/questionnaire-status` — `src/routes/mlp.ts:42-51` → `src/mlp/questionnaireStatus.ts:63-140`
- `loadUserMlpInputs` (`:70`) as A.3. Zero tracks ⇒ `pool=[]` ⇒ returns `[]` (`:72`).
- Otherwise suppression → `[]` (A.5) ⇒ `status` can never be `"suppressed"`.
- `age_gated: !isAgeEligible(null, …)` ⇒ **always `false`** (`:217`);
  `youngest_age_months: null` (`:219`). Does not throw.

### A.10 Adjacent: `POST /classify-update`
App mode requires a `child_id` owned by the caller (`src/routes/classifyUpdate.ts:290-296`)
→ a zero-children user gets 400/403; `apply_classification` takes `p_child_id` and
`child_milestones.child_id` is NOT NULL (`migrations/019_classify_enrich_apply.sql:54-64`).
The whole classify → track-proposal → milestone-fact path is **unreachable** without a child.

### A summary (state at each site)

| site | zero-children outcome |
|---|---|
| `/mlp/recompute` | 200, `items_written` 0 or an unweighted plan; never throws |
| `recordCheckinMilestones` | gate closed (count ≠ 1) |
| `user_active_tracks_for_user` | defaults arm empty **if** `user_mlp_data` has no row (UNVERIFIED) |
| `loadUserMlpInputs` | `youngestAgeMonths = null`; pool `[]` when no tracks |
| `isAgeEligible` / pool age filter | gate open (everything eligible) |
| bracket weighting | `totalAgeWeight 0`; `Age` tracks weight 0 → **hang** |
| milestone suppression | gate closed (never suppresses) |
| `/preview` | same as recompute; `age_months` override fabricates a child |
| `/questionnaire-status` | `age_gated` always false, never `suppressed` |
| `/classify-update` | unreachable (needs a child) |

---

## B. Reuse map for facts

### B.1 How a demographic answer adds a track today
Tables (`migrations/008_demographic_config_tables_backfill.sql`):
`demographic_questions` (`:38-49`, `is_active`) → `demographic_answers` (`:52-65`,
`is_active`, `UNIQUE (question_id, answer_key)` `:105-107`) → `demographic_track_rules`
(`:68-81`, bare `answer_id → track_id`, `UNIQUE (answer_id, track_id)` `:74`) ←
`user_demographic_responses` (`:84-101`, `UNIQUE (user_id, question_id)` `:91` = single
select per question; FKs flipped to `ON DELETE RESTRICT` by `migrations/038_…:33-47`;
`track_id` FK restricted by `migrations/040_…:43-49`).

Resolution is DERIVED, never stored (`migrations/045_…:7-13`). Both objects — the
function `user_active_tracks_for_user` (`045:35-103`) and the view `user_active_tracks`
(`045:106-166`) — must stay in sync (`037:42-43`, `045:17-18`). Arms, in order:

| arm | source | lines (fn) |
|---|---|---|
| `base_tracks` | responses ⨝ active question ⨝ active answer ⨝ rules | `045:40-46` |
| `default_tracks` | `user_mlp_data × new_user_tracks` | `045:47-51` |
| `base_set` | UNION of the two | `045:52-55` |
| `questionnaire_track_actions` / `latest_questionnaire_action` | `questionnaire_responses_tracks` view (diagnostic band arm + check-in `add_track`/`add_tag` arm, `048`/`049`), direct + `track_tag_map` expansion, latest action wins | `045:56-79` |
| `latest_user_mod` | `user_mlp_mods` add/delete, latest wins; EXCEPT deletes | `045:80-95` |
| final | `JOIN tracks`, sentinel + `archived_at IS NULL` | `045:97-102` |

Consumers: the function → `loadUserMlpInputs` (`rebuildMlp.ts:458`); the view →
`apply_classification` (`migrations/020_…:57`) and any app-side reader (unknown, separate
repo). Retroactive semantics: config edits change existing users' tracks on next
recompute (`docs/api-contract.md:1934-1948`).

### B.2 How a milestone fact suppresses a questionnaire today
- Link: `questionnaire.milestone_id` (`migrations/023_…:33-34`) — its existence IS the
  suppressibility permission (`023:4-16`).
- Facts: `child_milestones (child_id, milestone_id, source, source_ref, confidence)`,
  `UNIQUE (child_id, milestone_id)` (`019:54-64`). Writers: `apply_classification`
  (`019:115-122`, `ON CONFLICT DO NOTHING`) and `recordCheckinMilestones`
  (`src/mlp/recordCheckinMilestones.ts:125-133`, `ignoreDuplicates`). No UPDATE or DELETE
  path anywhere; teardown deliberately leaves them (`src/lib/contentTeardown.ts:85-86`;
  `src/routes/questionnaires.ts:78-79`).
- Read: `computeMilestoneSuppressionDetail` (`rebuildMlp.ts:56-123`): mapped questionnaires
  in pool (`:67-77`) ∩ youngest child's fact set (`:80-105`) → hits (`:120-122`) →
  `questionnaire:<id>` keys (`:127-132`) → `generateFullMLP` `suppressedItemKeys`
  (`generateFullMLP.ts:158-165`, same channel as completed items).
- A second, WRITE-side link exists: `questionnaire_questions.milestone_id`
  (`047a:109-112`) and `questionnaire_answer_actions.record_milestone` (`047a:147-153`,
  ≤1 per answer by `051`). The read side consults only `questionnaire.milestone_id`; the
  contract asks the two to agree by convention (`docs/api-contract.md:1204-1206`).

### B.3 Minimal insertion points for a `user_facts` row
**(i) Add a track via a rule table — one SQL touch, zero TS.**
Add a sixth arm to `user_active_tracks_for_user` AND its view twin, UNION'd into
`base_set` beside `base_tracks`/`default_tracks` (`045:52-55`):

```sql
), fact_tracks AS (
  SELECT ufc.user_id, ftr.track_id
  FROM user_facts_current ufc                      -- latest value per (user, fact_key), §C
    JOIN fact_track_rules ftr
      ON ftr.fact_key = ufc.fact_key AND ftr.value = ufc.value
  WHERE ufc.user_id = p_user_id
), base_set AS (
  SELECT user_id, track_id FROM base_tracks
  UNION SELECT user_id, track_id FROM default_tracks
  UNION SELECT user_id, track_id FROM fact_tracks           -- NEW
)
```
`loadUserMlpInputs` consumes the rpc output unchanged (`rebuildMlp.ts:458-490`);
`generateFullMLP` is untouched. The questionnaire and mods layers above `base_set` keep
their precedence (a human `delete` mod still overrides a fact-added track — consistent
with `020:64-68`). Both twins must change in the same migration (`045` precedent).

Rejected alternative: writing `user_mlp_mods(action='add')` rows on fact arrival (the
classify path, `020:70-72`). That STAMPS assignment instead of deriving it, contradicting
`045:7-9`, and a cleared fact would need a `delete` mod that then looks like a manual
override.

Decision needed: the `default_tracks` arm is anchored on `user_mlp_data` (children).
For a childless domain the anchor must move — e.g. `FROM "user" u` or `FROM
user_facts_current` — or defaults never apply (A.3).

**(ii) Suppress a questionnaire via a fact — one TS touch in the resolver, zero algorithm.**
Suppression is child-keyed end to end (`child_milestones.child_id NOT NULL`; youngest-child
resolution `rebuildMlp.ts:80-93`). Add a user-keyed sibling branch inside
`computeMilestoneSuppressionDetail` (or a sibling `computeFactSuppressionDetail` merged
before `:632`): a `fact_questionnaire_suppressions (questionnaire_id, fact_key, value)`
table (or two nullable columns on `questionnaire`) matched against `user_facts_current`
by `user_id`. It returns the same `SuppressionHit` shape (`:52`) so the exclusion channel
(`:642-652`) and `generateFullMLP` need no change. The inspector's `suppressed_by` payload
(`questionnaireStatus.ts:43`, contract §3a) carries `milestone_id`/`milestone_name` and
would need a fact-shaped variant — a contract change.

Rejected: synthesising a `children` row to reuse `child_milestones`. That table is
child-health data with RLS enabled (`019:81-82`); wrong semantics, wrong privacy surface.

### B.4 The monotonic assumption and where a CLEARING fact breaks it
Stated at: `docs/api-contract.md:1170-1171` ("a fact never un-happens"), `:826`,
`:1203-1204`; `migrations/023_…:6-13`; `recordCheckinMilestones.ts:101-102`;
`contentTeardown.ts:85-86`. Enforced structurally by `UNIQUE (child_id, milestone_id)` +
`ON CONFLICT DO NOTHING` (`019:63,120`; `recordCheckinMilestones.ts:132`) — first-reach-wins,
no update, no delete.

Financial facts are NOT monotonic ("has an emergency fund" can become false; "has a
mortgage" can clear). Exactly where the existing shape breaks:

1. **Presence-as-truth.** `child_milestones` has no `value`; the resolver tests
   `facts.has(milestone_id)` (`rebuildMlp.ts:104-105,121`). Reusing that shape means a
   fact, once asserted, suppresses forever even after it clears. The fact branch must
   match on the **latest value**, never on row existence (hence `user_facts_current`,
   §C).
2. **First-reach-wins insert.** `ON CONFLICT DO NOTHING` silently drops a re-assertion
   after a clear. Facts need append-and-resolve-latest (observed_at), not DO NOTHING.
3. **"Retire on Yes" relies on suppression trumping due-ness** (`docs/api-contract.md:1180-1190`;
   `rebuildMlp.ts:627-652`). Because suppression is recomputed fresh every rebuild
   (`:627-638`, no state table), un-suppression is automatic **provided** the predicate
   reads the current value — no cleanup needed. That property is worth keeping.
4. **Routing has no removal for check-ins**: the check-in arm hardcodes `add = true`
   (`048:31-34`, `049:46`). A derived `fact_tracks` arm (B.3.i) removes the track
   automatically when the latest value no longer matches a rule — but only because it is
   an arm, not a stamped mod. If facts were ever written as `user_mlp_mods`, clearing
   would need an explicit `delete` row and would collide with the manual-override guard
   (`020:64-68`).
5. **`recordCheckinMilestones`** writes a permanent fact from an answer
   (`recordCheckinMilestones.ts:15-33`). A financial check-in answer that should write a
   fact needs a `record_fact` action carrying a value, and its write must be latest-wins
   too — the `record_milestone` writer cannot be reused as is.
6. Unaffected: `completed_items` one-shot exclusion (`rebuildMlp.ts:622-624`) is a
   separate monotonic assumption (a completed lesson stays completed) and holds.

---

## C. Schema proposal (DRAFT SQL for review — DO NOT APPLY)

Design choices, stated up front:
- **History = observed_at-keyed rows in ONE table + a latest-wins VIEW** (recommended over
  a separate history table). One write path, no dual-write, and it is the exact pattern
  the active-track resolution already uses for mods and questionnaire actions
  (`045:65-68,80-84`: `DISTINCT ON … ORDER BY … DESC`).
- **Values are validated by FK, not by convention.** A `(fact_key, value)` pair must exist
  in `fact_allowed_values`; booleans are just the two rows `true`/`false`. Rules and
  entry maps FK the same pair, so a rule can never target a value a fact can't hold.
- **Numeric-looking values are rejected by CHECK** (twice: shape regex requires a leading
  letter; an explicit not-numeric CHECK documents the intent). No amounts can land.
- `user_id` FKs `public."user"(id)` to match `user_demographic_responses` (`008:97-99`).
  **Decision needed:** `children.parent_id` lives in the auth-uid space and `"user"` covers
  it only partially (`src/middleware/jwtAuth.ts:29-33`). If platform users will not have
  a `"user"` row, FK `auth.users(id)` instead.

```sql
-- ============================================================================
-- DRAFT — user_facts + rule tables for the fact-driven MLP inputs (financial domain)
-- NOT APPLIED. Review before running. Idempotent where practical.
-- ============================================================================
BEGIN;

-- 1. Fact vocabulary (CMS-authored). A fact_key is boolean or a short enum.
CREATE TABLE IF NOT EXISTS public.fact_definitions (
  fact_key    text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('boolean', 'enum')),
  label       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fact_definitions_key_shape CHECK (fact_key ~ '^[a-z][a-z0-9_]{1,63}$')
);

-- 2. Legal values per key. Booleans get exactly ('true','false').
CREATE TABLE IF NOT EXISTS public.fact_allowed_values (
  fact_key    text NOT NULL REFERENCES public.fact_definitions (fact_key) ON DELETE CASCADE,
  value       text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (fact_key, value),
  -- STRUCTURAL: a value is a short lowercase token starting with a letter …
  CONSTRAINT fact_allowed_values_shape CHECK (value ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- … and can never look like a number/amount/percentage (belt and braces).
  CONSTRAINT fact_allowed_values_not_numeric
    CHECK (value !~ '^\s*[+-]?[$€£]?[0-9]')
);

-- 3. Observations (append-only history). Latest per (user_id, fact_key) wins via the view.
CREATE TABLE IF NOT EXISTS public.user_facts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public."user" (id) ON DELETE CASCADE,  -- see decision above
  fact_key     text NOT NULL,
  value        text NOT NULL,
  observed_at  timestamptz NOT NULL DEFAULT now(),
  source       text NOT NULL,
  source_ref   text,                      -- platform event id / questionnaire answer id / admin uid
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- The pair must be a legal vocabulary value (FK is the validator, not app code).
  CONSTRAINT user_facts_value_fkey
    FOREIGN KEY (fact_key, value) REFERENCES public.fact_allowed_values (fact_key, value)
    ON DELETE RESTRICT,
  -- Same shape CHECKs on the observation itself so a bad row can't exist even if the
  -- vocabulary table is later loosened.
  CONSTRAINT user_facts_value_shape       CHECK (value ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT user_facts_value_not_numeric CHECK (value !~ '^\s*[+-]?[$€£]?[0-9]'),
  CONSTRAINT user_facts_source CHECK (source IN ('platform_api', 'questionnaire', 'cms', 'manual')),
  -- One observation per instant per key (keeps DISTINCT ON deterministic with the id tiebreak).
  CONSTRAINT user_facts_one_per_instant UNIQUE (user_id, fact_key, observed_at)
);
CREATE INDEX IF NOT EXISTS user_facts_user_key_observed_idx
  ON public.user_facts (user_id, fact_key, observed_at DESC);

-- 4. Latest-wins resolution. security_invoker so RLS on user_facts applies to any
--    non-service reader; the backend (service role) bypasses RLS as usual.
CREATE OR REPLACE VIEW public.user_facts_current
  WITH (security_invoker = true) AS
  SELECT DISTINCT ON (uf.user_id, uf.fact_key)
         uf.user_id, uf.fact_key, uf.value, uf.observed_at, uf.source, uf.source_ref, uf.id
  FROM public.user_facts uf
  ORDER BY uf.user_id, uf.fact_key, uf.observed_at DESC, uf.created_at DESC, uf.id DESC;

-- 5. fact → track rules (CMS-authored). Mirrors demographic_track_rules (008:68-81):
--    bare mapping, no is_active, unique per (pair, track), RESTRICT on the track (040 rule:
--    a track deletes only when bare).
CREATE TABLE IF NOT EXISTS public.fact_track_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_key    text NOT NULL,
  value       text NOT NULL,
  track_id    uuid NOT NULL REFERENCES public.tracks (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,                       -- admin uid from the verified JWT (no FK, like content_approvals)
  CONSTRAINT fact_track_rules_value_fkey
    FOREIGN KEY (fact_key, value) REFERENCES public.fact_allowed_values (fact_key, value)
    ON DELETE RESTRICT,
  CONSTRAINT fact_track_rules_unique UNIQUE (fact_key, value, track_id)
);
CREATE INDEX IF NOT EXISTS fact_track_rules_track_idx ON public.fact_track_rules (track_id);

-- 6. fact → direct entry point (lesson OR segment). Exactly one target (content_images
--    one-owner pattern, docs/api-contract.md §5). One entry point per (pair).
CREATE TABLE IF NOT EXISTS public.fact_entry_map (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_key    text NOT NULL,
  value       text NOT NULL,
  lesson_id   uuid REFERENCES public.lessons  (id) ON DELETE RESTRICT,
  segment_id  uuid REFERENCES public.segments (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  CONSTRAINT fact_entry_map_value_fkey
    FOREIGN KEY (fact_key, value) REFERENCES public.fact_allowed_values (fact_key, value)
    ON DELETE RESTRICT,
  CONSTRAINT fact_entry_map_one_target CHECK (num_nonnulls(lesson_id, segment_id) = 1),
  CONSTRAINT fact_entry_map_one_per_value UNIQUE (fact_key, value)
);

-- 7. Optional: questionnaire suppression by fact (B.3.ii). Kept as a table, not columns
--    on questionnaire, so the milestone link stays the ONE canonical child-fact link.
CREATE TABLE IF NOT EXISTS public.fact_questionnaire_suppressions (
  questionnaire_id uuid NOT NULL REFERENCES public.questionnaire (id) ON DELETE CASCADE,
  fact_key         text NOT NULL,
  value            text NOT NULL,
  PRIMARY KEY (questionnaire_id, fact_key, value),
  CONSTRAINT fqs_value_fkey
    FOREIGN KEY (fact_key, value) REFERENCES public.fact_allowed_values (fact_key, value)
    ON DELETE RESTRICT
);

-- 8. RLS posture (see notes below).
ALTER TABLE public.user_facts                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fact_definitions               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fact_allowed_values            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fact_track_rules               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fact_entry_map                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fact_questionnaire_suppressions ENABLE ROW LEVEL SECURITY;

COMMIT;
```

Notes on the draft:
- **Latest-wins semantics for clearing:** writing `('has_emergency_fund','false')` is a
  new observation; the view flips, the `fact_tracks` arm (B.3.i) drops the track and the
  suppression branch (B.3.ii) releases the questionnaire on the next recompute. No
  delete, no un-record path needed — history is preserved (B.4).
- **Not modeled on purpose:** amounts, dates, free text. Anything numeric is rejected at
  the row. If the platform sends "savings_rate: 12%", the API layer must bucket it to an
  enum (`low|mid|high`) BEFORE it becomes a fact; the DB refuses the raw value.
- **RLS implications:** `user_facts` is per-user financial-adjacent data → RLS enabled,
  no anon/authenticated read policy (backend-mediated only, service role bypasses;
  `docs/rls-sweep.md:34-38` pattern). If the app or a signed-link reader ever reads it
  directly, that needs a `user_id = auth.uid()` policy. The four config tables are
  CMS-authored: if managed via backend routes (like `/tones`, `CLAUDE.md` "Content prompt
  composition"), default-deny is correct; if the CMS wants Supabase-direct writes (the
  `screen_help` pattern), they need an admin policy or they break (`docs/rls-sweep.md:39-48`).
  Add all six to `docs/rls-sweep.md` when the migration lands. The `user_facts_current`
  view must be `security_invoker` or it silently bypasses the table's RLS for any
  non-service reader.
- **Migration bookkeeping:** this is a SQL-editor migration → file as DRAFT, apply gate per
  `CLAUDE.md` "Doc maintenance"; regenerate `database.types.ts` after apply; separate
  Supabase project means its own reconciliation list starts fresh — the 006–057 hand-apply
  walk (`migrations/README.md:126-128`) must be replayed there first.

---

## D. `DOMAIN` env

### D.1 What exists today
- Env is read ad hoc at import time; no central validation. Hard-fail precedents:
  `src/supabase.ts:8-11` (`process.exit(1)` when Supabase vars are missing) and
  `src/index.ts:72-78` (`validateImagePrompts()` aborts boot on a bad prompt file so
  Render keeps the old deploy). Soft-default precedent: `src/middleware/cors.ts:18-33`.
- Env vars read (grep over `src`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `INTERNAL_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `PROMPT_WRITER`,
  `IMAGE_GENERATOR`, `QUESTIONNAIRE_WRITER`, `CLASSIFY_WRITER`, `REVIEW_WRITER`,
  `BATCH_CONCURRENCY`, `ALLOWED_ORIGINS`/`CORS_ALLOWED_ORIGINS`, `PORT`,
  `RENDER_GIT_COMMIT`/`RENDER_GIT_BRANCH`. `.env.example` lists most; `REVIEW_WRITER`
  and `BATCH_CONCURRENCY` are undocumented there.
- **CMS bootstrap:** there is NO config/whoami endpoint. The CMS learns the backend from
  its own build-time `VITE_API_BASE_URL` (`docs/api-contract.md:40`) and uses
  `GET /health` as the reachability probe (`:55-57`, `src/index.ts:36-38`).
  `GET /version` (`src/index.ts:42-44`, `src/lib/version.ts:16-45`) is the only
  identity-shaped unauthenticated endpoint and returns `{ commit, short, branch, source }`.
  Admin identity is per-request via the JWT (`src/middleware/jwtAuth.ts:69-114`,
  `user.role` — note `CLAUDE.md` "Auth" still says `users_internal.role`; the code reads
  `user.role`, `jwtAuth.ts:6-8`).

### D.2 Proposal
`src/lib/domain.ts` (new), evaluated at import like `supabase.ts`:

```ts
export const DOMAINS = ["parenting", "financial"] as const;
export type Domain = (typeof DOMAINS)[number];
const raw = process.env.DOMAIN?.trim();
if (!raw || !(DOMAINS as readonly string[]).includes(raw)) {
  console.error(`FATAL: DOMAIN must be one of ${DOMAINS.join("|")} (got ${JSON.stringify(raw)})`);
  process.exit(1);
}
export const DOMAIN = raw as Domain;
```
Required (no default) so the existing Moosii Render service also fails until
`DOMAIN=parenting` is set — that is the point: an unlabelled deployment is a bug.
Import it first in `src/index.ts` (before `validateImagePrompts`, `src/index.ts:72-78`).
Add `DOMAIN=` to `.env.example` and the README env table.

Where `DOMAIN` should eventually gate (report only): the image prompt base with its
infant safety rules (`prompts/image/base.md`, `CLAUDE.md` "Prompt model"), the milestone
alias table (`src/lib/milestones.ts:9-21`), the classify catalog, and the CMS copy —
none of which are domain-neutral today.

### D.3 Smallest `docs/api-contract.md` diff
Expose it on the endpoint that already answers "what is this instance": `/version`.

```diff
 - **Version — DELIVERED:** `GET /version → 200 { commit, short, branch, source }`,
-  **no auth**. Reports the commit the running instance is on — `source:"render"`
+  **no auth**. Reports the commit the running instance is on — `source:"render"`
   (from `RENDER_GIT_COMMIT`) in prod, `source:"git"` locally. Answers "what's
-  deployed?" without opening the Render dashboard.
+  deployed?" without opening the Render dashboard.
+- **Domain — [DESIGN]:** `GET /version` also returns `domain: "parenting" | "financial"`
+  (from the required, boot-validated `DOMAIN` env). The CMS reads it on bootstrap and
+  refuses to render if it differs from its own build-time `VITE_DOMAIN` — a CMS pointed at
+  the wrong backend fails loudly, never silently edits the other domain's content.
```
(`docs/api-contract.md:58-61`.) One field on one existing unauthenticated endpoint; the
CMS-side check is a separate-repo slice — flag for that seat.

---

## E. Web lesson view (read-only, signed link) — proposal only

### E.1 What exists
- **Backend has no lesson READ route.** `src/routes/lessons.ts` exposes only
  `POST /generate`, approve/unapprove/publish/unpublish, coverage-accept and `DELETE`
  (`:22,61,149,169,191,206,232,303`); `/segments` reads are regen-prompt and
  generation-log only (`src/routes/segments.ts:108,145`).
- **CMS preview** reads Supabase-direct with the admin's JWT (`CLAUDE.md` "Auth";
  `docs/rls-sweep.md:39-41` pattern). **App lesson read** is Supabase-direct with the
  anon key under the end user's RLS: plan from `user_mlp_not_completed`
  (`src/types/database.types.ts:6318-6340`; archival note `docs/api-contract.md:1727`),
  content via `v_lesson_details`/`v_segment_details` (views list, `database.types.ts:5549+`).
  Render gates the app applies: content on `segments.seg_status='complete'`, images on
  `sub_segments.image`, quiz on `quiz_questions.answer_status='approved'`
  (`docs/api-contract.md:191-194`).
- Both auth paths call `supabase.auth.getUser` (`jwtAuth.ts:40-61,69-81`); neither can
  verify a non-Supabase token. No JWT/HMAC library is installed (`package.json`), but
  Node 20's `crypto` (`createHmac`, `timingSafeEqual`) is enough.

### E.2 What a signed-link route needs that nothing provides today
1. **Token issue + verify** (new): payload `{ user_id, lesson_id, exp, jti }`, HMAC-SHA256
   over a canonical encoding with a new `READER_LINK_SECRET` env (boot-validated like
   `DOMAIN`). Verify with `timingSafeEqual`; reject on `exp`. A `jti` lets the email job
   (§F) tie a link to a send row and lets a link be revoked by deleting that row. No
   Supabase session, so the route is mounted WITHOUT `jwtAuthMiddleware`/`verifyAnyUser`
   (same mounting style as `/mlp`, `src/index.ts:61-66`).
2. **Content assembly** (new, service role): `lessons` (`is_published`, and the DERIVED
   archival rule — `lessons.archived_at IS NULL AND tracks.archived_at IS NULL`,
   `CLAUDE.md` invariant 6; the app gets this for free via `user_mlp`, a direct route
   must apply it itself) → `segments` (`seg_status='complete'`) → `sub_segments` ordered by
   `sequence` (card roles are role-by-position, invariant 2 — the renderer derives
   first/body/takeaway from position, never stores a role) → approved images
   (`sub_segments.image`) → quiz (`answer_status='approved'`). No existing function bundles
   this; the closest is the approve bundle's fan-out (`src/routes/lessons.ts:61-147`).
3. **Grant semantics** (decision): the token alone is the grant, bounded by `exp`; the
   route should additionally re-check the lesson is still in the user's `user_mlp` (or
   `completed_items`) and return 410 when it left the plan or was unpublished/archived.
4. **Shape:** recommend the backend serves JSON (`GET /reader/lessons/:lesson_id?t=<token>`)
   and a minimal static reader page lives with the CMS/app seat. Serving HTML from
   Express avoids CORS entirely; JSON requires the reader origin in `ALLOWED_ORIGINS`
   (`cors.ts:18-33`).
5. **No write-back in v1.** Marking completion is an app-side `completed_items` write
   today and drives MLP exclusion AND diagnostic routing (`049:38`); a web reader that
   writes it is a new write path and a product decision. Read-only first.
6. **Images:** `sub_segments.image` is a storage URL FK'd to `image_assets.url`; fine if
   the `lessons` bucket is public (`migrations/README.md:82`), else the route must mint signed
   storage URLs.
7. **Zero-children safe:** nothing in this path reads `children` or age.

---

## F. Email cadence job — proposal only

### F.1 What exists
- **Scheduled work on Render: none.** No `render.yaml`/cron config in the repo; no
  `setInterval`/cron in `src` (only `dummy.ts:4`, `retry.ts:102`, a test script). The only
  boot-time work is `reapStaleJobs` (`src/jobs/runner.ts:139-159`, `src/index.ts:78`).
  Every job is request-triggered: `POST /jobs` (`runner.ts:24-31`) or the coalesced
  publish trigger `enqueueRebuildAllIfIdle` (`runner.ts:33-76`). `INTERNAL_API_KEY` is
  already reserved for "any server-to-server/cron path" (`docs/api-contract.md:44-45`).
- **Due-ness lives in** `src/jobs/handlers/rebuildMlp.ts`: `matchRecurringBand` (`:155-162`),
  `isQuestionnaireDue` (`:167-177`), `decideQuestionnaire` (`:202-223`, deferral +
  band/answer interval), `loadCheckinRecurrenceIntervals` (`:294-356`),
  `computeQuestionnaireDecisions` (`:373-445`, returns `{ due, deferred }`). The inspector's
  `classifyQuestionnaire` (`src/mlp/questionnaireStatus.ts:166-225`) derives `due_at`
  (`:177-179`) — bands only; check-in intervals are not reflected there
  (`docs/api-contract.md:1636-1638`).
- Due-ness is DERIVED and only takes effect when a recompute runs
  (`docs/api-contract.md:1617-1619`); a "due-moment trigger" was explicitly left app-side.
  **The email job is that trigger** and must recompute before it reads.
- **"New top item":** `rebuild_user_mlp` deletes and re-inserts with `created_at = now()`
  on every rebuild (`017:31-51`), so `created_at` cannot detect novelty. "New" must be
  `user_mlp` position 1 `item_id` ≠ the `item_id` last emailed.
- **Resend: not integrated.** No dependency (`package.json:11-19`), no env var
  (`.env.example`), no code. `user.email` exists (nullable) and app-owned notification
  toggles exist (`allow_daily_*`, `database.types.ts:4269-4273`), but no email opt-out
  column.

### F.2 Proposed job
- **Job type** `email_digest` in the registry (`src/jobs/registry.ts:28-41`);
  `input: { user_id } | { scope: 'all' }` mirroring `rebuild_mlp` (`rebuildMlp.ts:745-756`).
- **Trigger:** a Render **Cron Job** service (not in-process timers) calling
  `POST /jobs { type:'email_digest', input:{ scope:'all' } }` with `INTERNAL_API_KEY`
  once daily. In-process `setInterval` would also work on the always-warm Starter tier but
  duplicates the moment a second instance exists; the cron is the debuggable option
  (`CLAUDE.md` priorities). Coalesce like `enqueueRebuildAllIfIdle` (`runner.ts:44-76`).
- **Per user:**
  1. `rebuildOneUser(userId)` (`rebuildMlp.ts:673`) so due items re-enter `user_mlp`.
  2. `computeQuestionnaireDecisions` (`:373`) → `due` set; `user_mlp` position 1 → top item.
  3. Events: `checkin_due:<questionnaire_id>:<due_at ISO>` (due_at = latest
     `completed_items.created_at` + interval — stable for the whole cycle, so a daily run
     cannot re-fire it) and `new_top:<item_id>`.
  4. Skip if no email, or opted out (needs a new `email_opt_out` column — decision).
- **Idempotency (structural, not behavioural):**
  ```sql
  CREATE TABLE email_sends (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            uuid NOT NULL,
    event_key          text NOT NULL,
    reserved_at        timestamptz NOT NULL DEFAULT now(),
    sent_at            timestamptz,
    provider_message_id text,
    reader_link_jti    uuid,
    UNIQUE (user_id, event_key)
  );
  ```
  Order: `INSERT … ON CONFLICT (user_id, event_key) DO NOTHING RETURNING id` for every
  event in this run → zero rows returned ⇒ nothing new ⇒ no email. Otherwise ONE email
  bundling the newly reserved events, with a signed reader link (§E, `jti` = the send
  row) → stamp `sent_at` + `provider_message_id`. On provider failure delete the
  reservations so the whole job retries cleanly (whole-unit jobs, `CLAUDE.md`
  "Architecture"). Pass the same key as Resend's `Idempotency-Key` header as a second
  wall. Log each provider call to `ai_generation_log`? No — it is not an AI call; a
  `correlation_id` on `email_sends` is enough.
- **Env:** `RESEND_API_KEY`, `EMAIL_FROM`, `READER_LINK_SECRET`, `READER_BASE_URL`, all
  boot-validated.

---

## Ranked risk list — what breaks first on a zero-children deployment

1. **Process hang (reproduced).** Any active track with `track_type = 'Age'` (or any
   track with `weight = 0`) + a null age → `generateFullMLP` loops forever on the event
   loop, taking `/health` down and putting Render in a restart loop
   (`generateFullMLP.ts:184,211-227,261-263`). Zero-children users ALWAYS have a null age,
   so this is one authoring slip away. Structural guard that does not touch the algorithm:
   `CHECK (weight IS NULL OR weight > 0)` on `tracks`, and in the financial project
   `CHECK (track_type IS DISTINCT FROM 'Age')`. Also worth verifying in Moosii today.
2. **No default tracks, and skipped by every batch rebuild** if `user_mlp_data` has no
   row for childless users (`045:47-51`; `rebuildMlp.ts:700-703`). A fresh platform user
   has an empty plan until a fact/demographic rule adds a track, and publish-triggered
   `scope:all` rebuilds never reach them → stale plans. UNVERIFIED view definition; must
   be read from the live DB (`pg_get_viewdef('user_mlp_data')`) before design.
3. **Suppression and the milestone writer are structurally off** (`rebuildMlp.ts:92-93`;
   `recordCheckinMilestones.ts:107`). "Retire on Yes" never retires; check-ins recur
   forever; `/classify-update` is unreachable (`classifyUpdate.ts:290-296`). Facts need
   the user-keyed branch in B.3.ii.
4. **Age gate silently open** (`generateFullMLP.ts:96,172`). Any `min/max_child_age` or
   `questionnaire.age` authored by habit (the lesson-stub contract still emits child ages,
   `CLAUDE.md` "Scope v1.5") is inert. Harmless per se, but it means the domain has NO
   eligibility gate until facts supply one.
5. **Inspector lies:** `/preview?age_months=N` fabricates a child (A.8);
   `/questionnaire-status` reports `age_gated:false` for everything (A.9).
6. **Fresh Supabase project bookkeeping:** the 006–057 hand-applied walk must be replayed
   in order (`migrations/README.md:126-128`); `user.role` admin rows must exist for the
   CMS gate (`jwtAuth.ts:83-95`); `ALLOWED_ORIGINS` must list the new CMS origin
   (`README.md` CORS section).
7. **Parenting-specific prompt and vocabulary surfaces** run unchanged until `DOMAIN`
   gates them (D.2): image base rules, milestone aliases, classify catalog.
8. **Email/reader are net-new surfaces** (E, F): no scheduler, no mailer, no non-Supabase
   auth exists; each is a new env secret and a new RLS-listed table.

## Decisions needed from Mark (not made here)
- Read `user_mlp_data`'s live definition; choose the default-tracks anchor for a childless
  domain (B.3.i).
- `user_facts.user_id` FK target: `public."user"` vs `auth.users` (C).
- Whether the web reader writes `completed_items` (E.2.5) — recommend no in v1.
- Email opt-out column and sender identity (F.2).
- Whether to add the two `tracks` CHECKs in BOTH projects now (risk 1).
