# FINDINGS — visible plan change from a fact, with reasons (2026-11-07)

Investigate-only when written: nothing was changed, written or committed, and no DB row was touched.
Sources: `docs/api-contract.md` §3/§8/§9, `src/mlp/generateFullMLP.ts`, `src/jobs/handlers/rebuildMlp.ts`,
the live `user_active_tracks_for_user` / `mlp_item_pool` definitions on financial, migrations 019–021,
037, 041, 069–076, plus read-only SQL on financial and one throwaway probe run against the frozen
function (deleted). moosii-cms read-only.

**The frozen algorithm is not touched by anything proposed here.** Every lever below is an *input* to
`generateFullMLP` — the track list, each track's `priority`/`weight`, the pool and each item's
`priority` — assembled in the handler (`loadUserMlpInputs`, `src/jobs/handlers/rebuildMlp.ts:452-525`)
or in `user_active_tracks_for_user`. `generateFullMLP` sorts by the priorities it is *given*
(`src/mlp/generateFullMLP.ts:222`, `:231`), so steering the plan never means editing it. One proposal
(item-level "next", §4) needs a new handler-side input; it is flagged as such.

---

## 1. Baseline — how Getting Oriented reaches everyone, and what happens as it grows

`user_active_tracks_for_user` (migration 037) unions five arms. On financial only three can fire today:

| Arm | Source | Live on financial |
|---|---|---|
| default | `user_mlp_data CROSS JOIN new_user_tracks` | **yes** — 1 row: Getting Oriented |
| fact | `user_facts_latest` ⨝ `fact_track_rules` | **yes** — 7 rules |
| manual/insight | `user_mlp_mods` latest-wins per (user, track) | available, 0 rows |
| demographic | `user_demographic_responses` ⨝ `demographic_track_rules` | 0 rules, 0 responses |
| questionnaire | `questionnaire_responses_tracks` | 0 questionnaires |

Getting Oriented is **priority 200, weight 50**; every fact track is **priority 100, weight 70–95**.
Live, both personas resolve to exactly `[fact track, Getting Oriented]`.

> **The real "never empty" risk is not ordering — it is the default arm's gate.** `user_mlp_data` is a
> view over **`public."user"`** LEFT JOIN `children`. A member with no `public."user"` row gets no
> default track, no pool and an **empty plan** — and CLAUDE.md already records that `public."user"`
> only partially covers the auth-uid space. All 3 financial auth users have a row today, so it is
> latent, not broken. `children` is empty on financial, so `youngest_age_in_months` is NULL for
> everyone: the demo runs entirely on CHANGE 4(i)'s no-usable-age branch (without that fix it would
> hang, not mis-order).

**Growth 2 to ~8 items** (frozen function, live weights). Getting Oriented still trails; the interleave
is 1-in-3:

```
SAM today     (CH 4, GO bucket empty — he completed his one GO lesson)
  sequence CH GO CH -> 1:CH1  2:CH2  3:CH3  4:CH4

SAM with GO at 8   (CH 4, GO 8)
  sequence CH GO CH -> 1:CH1  2:GO1  3:CH2  4:CH3  5:GO2  6:CH4  7:GO3 ... 12:GO8

SARAH with GO at 8 (BB 3, GO 8)
  sequence BB GO BB -> 1:BB1  2:GO1  3:BB2  4:BB3  5:GO2  6:GO3 ... 11:GO8

NEW MEMBER, no fact track yet (GO 8 only)
  sequence GO       -> 1:GO1 ... 8:GO8        <- the never-empty fallback works
```

`cycles = round(weight / minWeight)` gives CH 2, GO 1, so the sequence is `[fact, GO, fact]`
(`src/mlp/generateFullMLP.ts:238-274`). Growing Getting Oriented from 2 to 8 **cannot** push a fact
lesson later than position 6 for either persona.

**Can Getting Oriented ever lead?** Three ways, one intended:

1. **Every fact track's bucket is empty** — then it leads, which is the wanted behaviour.
2. **Its `priority` is edited below a fact track's.** Verified: at priority 50 it takes position 1 and
   pushes the fact lesson to 2. The guard is a single number in `tracks`, unenforced.
3. **A priority tie.** At priority 100 for both, the fact track still led in the probe — but only
   because `Array.sort` is stable in V8 and `user_active_tracks_for_user` ends `ORDER BY t.weight DESC`,
   so the heavier track arrives first. **That is an accident, not a rule**: it holds only while Getting
   Oriented's weight (50) stays the lowest. Keep the priority gap; do not rely on the tie.

**Content gap that matters more than the ordering:** Getting Oriented has 3 lessons, **1 published**
(`What the App Can See Now`; the other two are priority 200/300, unpublished). "Grows to ~8" is a
content task. Publishing needs `POST /lessons/:id/publish` or a manual rebuild — the CMS toggle is
still Supabase-direct and enqueues no rebuild (the standing correction in api-contract §3).

## 2. Reasons — available without touching the algorithm

**There was no plan API before this slice.** `src/routes/mlp.ts` exposed only `/:user_id/preview`,
`/:user_id/questionnaire-status`, `/rebuild-all` and `/recompute`. The app and reader read `user_mlp`
**directly** via Supabase under `user_mlp_sel` (own row, or admin, or service).

Every reason already exists in data, because the five union arms *are* the reasons. The clean build is
a **sibling** read-only function — never an edit to `user_active_tracks_for_user` (invariants 4 and 8):

```sql
user_track_reasons_for_user(p_user_id uuid)
  RETURNS TABLE (track_id uuid, kind text, label text, fact_key text, value text,
                 observed_at timestamptz, source text, source_ref text,
                 confidence numeric, action_at timestamptz)
```

with `kind` in `('default','fact','demographic','questionnaire','insight','manual')` — one row per
*reason*, so a track can carry several (Building a Buffer genuinely matches both
`has_emergency_buffer=false` and `saving_for_home=true`). Insight provenance comes from joining
`user_mlp_mods` to `user_track_activations ON source_ref = mod.id::text`, which is where
`source`/`confidence` live.

An item's reason **is its track's reason** — the item is in the plan because its track is active and it
survived published / completed / age / suppression. Stated plainly rather than inventing per-item
reasons.

Member-facing copy is **authored, never derived**: a generated string ("because new_subscription_recent
is true") is not shippable. Hence `reason_label` on the rule rows (migration 119) and `label: null` for
a reason kind with no authored copy — no fallback text in code, the same discipline as the grounding
block.

Why a backend route rather than client assembly: the member *can* read `new_user_tracks`,
`fact_track_rules` and their own facts and mods under RLS, but `user_track_activations` is **RLS-on with
no policy** — backend-only. Insight provenance can only come from the backend.

## 3. Simulating `new_subscription_recent` — one line of code, one blocking content gap

- **The rule exists.** `fact_track_rules` row `9210a093-...`: `new_subscription_recent = true` to
  Subscription Audit (`f0840000-...-0003`). `fact_values` has both `true` and `false`. Sam's derived
  value is `false`, so simulating `true` is a real change: 1 row written, rebuild enqueued, track
  activates.
- **The allowlist is one const** — `SIMULATE_FACT_KEYS`, `src/demo/simulate.ts:13`.
- **But the plan would not visibly change.** Subscription Audit has exactly one lesson,
  `A New Recurring Charge Appeared` (`5dd82ae2-...`), and it is **unpublished**. The pool is
  published-only (`src/jobs/handlers/rebuildMlp.ts:510`), so the member gains a track with an empty
  bucket and sees nothing new. **Publish that lesson or the beat is dead.** Once published the frozen
  function puts it at **position 2** for Sam — the top of the plan, which is the demo moment:
  ```
  CH 4 + SA 1 + GO 8 -> sequence CH SA GO CH SA
    1:CH1  2:SA1  3:GO1  4:CH2  5:CH3  6:GO2  7:CH4  8:GO3 ...
  ```
- **`demo:reset` needs nothing.** It deletes by `source_ref = 'demo-simulate'`
  (`src/demo/reset.ts:54`), key-agnostic, and its "now:" lines print every key from
  `user_facts_latest` (`src/scripts/demoReset.ts:89-90`), so a simulated `new_subscription_recent` is
  already undone and already visible in the output.

## 4. Insights — "add this track" already works; "put this lesson next" does not

**`user_mlp_mods` is NOT unused — the track arm is live.** `user_active_tracks_for_user`'s
`latest_user_mod` CTE takes the latest `action` per (user, track); `add` unions the track in, `delete`
EXCEPTs it out. Classify slice 2 ships on exactly this path: `apply_classification` (live body,
migrations 020/021) writes `user_mlp_mods(action='add')` **plus** a `user_track_activations` row
(`source='classify'`, `source_ref` = the mod id, `confidence`), then re-runs `rebuildOneUser()`.

> **Doc error found:** `docs/api-contract.md:1913` said `user_mlp_mods` is "not yet applied by the
> recompute". True only of **item-level** ordering overrides — the **track** arm is applied and
> load-bearing. Corrected in the same commit as this file.

**`user_track_activations`** (`migrations/019_classify_enrich_apply.sql:66-75`) is provenance only; the
derivation never reads it. It already has the right columns (`user_id, track_id, source, source_ref,
confidence, created_at`) and **no CHECK on `source`**, so `'mx'`, `'partner'`, `'simulated'` are
writable with no migration. It is also the "inference never overrides a human" fence:
`apply_classification` skips a track whose latest mod is a `delete` with no backing activation row.

- **"Add this track" as an input to the unchanged algorithm — YES, it exists.** An insight writer needs
  a route/function doing what `apply_classification` does with a parameterised `source` (today it
  hardcodes `'classify'`), then a rebuild. No algorithm change, no new routing arm.
- **"Put this lesson next" — NO, not expressible today.** `user_mlp_mods` has `track_id` and `tag_id`
  only; no item column exists anywhere in the routing chain. It *is* achievable **without touching the
  frozen function**, because the function sorts buckets by the item `priority` it is handed and tracks
  by the `priority` it is handed: give `loadUserMlpInputs` a per-user override table and lower that
  item's input priority within its track, plus that track's input priority if the item must be position
  1. Two safety notes: apply the override **in the handler, after** the `user_active_tracks_for_user` /
  `mlp_item_pool` reads, never by editing those two objects (invariant 8 — they feed every user); and
  override **priorities only, never weights** — weights drive `minWeight` and the cycle counts, and a
  bad one raises `MlpInvalidWeights`.
- **Where insight events go.** Reuse `user_track_activations` as the event log — it already is one,
  with `source` free-text and `source_ref` pointing at the causing row. A four-way vocabulary
  (`classify|mx|partner|simulated|manual`) is a one-line CHECK. If an insight should be recorded even
  when it activates nothing (no rule matched, or the track was already active), the row must become
  independent of the mod — today it is written only for newly-added tracks, so a "no-op insight" leaves
  no trace.
- **One FK trap:** `user_mlp_mods.user_id` references `public."user"(id)`. An insight for a member with
  no `public."user"` row fails **23503** — the same coverage gap as section 1's empty-plan risk.

## 5. Sizing

| # | Piece | Size | Status |
|---|---|---|---|
| a | Publish `A New Recurring Charge Appeared` + Getting Oriented's 2 unpublished lessons (via the backend publish route, so a rebuild is enqueued) | small | content, not code |
| b | `new_subscription_recent` in `SIMULATE_FACT_KEYS` + test + §9d line | small | **F83** |
| c | `user_track_reasons_for_user` + app-facing `GET /plan` with reasons and `item_count` | medium | **F83** |
| d | Authored reason copy (`fact_track_rules.reason_label`, `new_user_tracks.reason_label`) | small | **F83**, migration 119 |
| e | Insight writer: parameterised-source activation fn + route + rebuild | small–medium | open |
| f | `source` CHECK on `user_track_activations`; recording no-op insights | small | open |
| g | Per-user item/track priority overrides ("put this next") | medium | open |
| h | A real insight engine (mx/partner signal to insight to fact or track, with cadence and dedupe) | large | open |
| i | Guard the empty-plan gap: every member has a `public."user"` row (or move the default arm off `user_mlp_data`) | medium | open — the one correctness item |

## 6. Decisions

1. **Reason in a new `GET /plan`, or columns on `user_mlp`?** Decided: **the route** (Mark, 2026-11-09).
   `user_mlp` is derive-and-overwrite and the reader reads it directly, so columns would make the
   rebuild compute and store reasons for every user on every rebuild; a route computes them on read for
   one user.
2. **Member-facing copy authored or derived?** Decided: **authored** per rule (Mark, 2026-11-09),
   consistent with invariant 11's posture on provisional copy.
3. **Is "Getting Oriented always trails" policy or code?** Policy today: one editable number
   (priority 200 vs 100, weight lowest). Not enforced. Open.
4. **Scope of "put this lesson next" (g)** — absolute position 1, or first-within-track? Open;
   first-within-track is much smaller and needs no track-priority override.
5. **Empty-plan guard (i)** — guarantee the `user` row, or move the default arm off `user_mlp_data`?
   The second changes a shared object and touches Moosii too. Open.
6. **Insight `source` vocabulary** — lock it with a CHECK now, or leave free-text until the engine's
   shape is known? Open.
