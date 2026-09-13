# Facts v1 — DRAFT migrations, seeds and contract (nothing applied)

Slice 5 of the second-domain work. Proposal only: **no code, no applies, no pushes.**
Everything here is a draft for Mark to review and run via the Supabase SQL editor.

Sources: `FINDINGS-financial.md` §B–C, plus the decisions taken since (suppression sibling
dropped from v1; latest-wins with history; boolean or short enum only, no amounts ever).

**Why this folder and not `migrations/`.** The brief asked for a clearly-marked draft path.
Note this deviates from the standing convention in `CLAUDE.md` (Doc maintenance), where a
migration file is normally committed **into `migrations/` as DRAFT (pending apply)** and
its reconciliation entry flips on Mark's confirmation. On apply these files should **move
to `migrations/` proper** and get their README entries + high-water bump there. Flagging so
the deviation is deliberate rather than a precedent.

---

## Numbering — renumbered to 069–076 (2026-09-12)

These drafts were first written as 060–067. That range was later taken by real, applied
migrations — the catalog-integrity set (060–063), the published-edit policy (064–066), the
`create_lessons_with_segments` fix (067) and the atomic lesson publish (068). The set is now
**069–076**, and every internal cross-reference has been updated to match. Nothing here has
been applied. References to 037, 038, 040, 045, 048/049 and 059 below are to REAL applied
migrations and were deliberately left alone.

## 1. Apply order

Run in this order. Each file has its own header rationale, a **PRE-CHECK** block to run first, and a VERIFICATION block to run after.
**Apply each file to the financial project first, then Moosii** — see below.

| # | File | One-line rationale |
|---|---|---|
| 069 | `069_fact_vocabulary.sql` | `fact_keys` + `fact_values`: a closed CMS-authored vocabulary, so "is this a real fact?" is a foreign key — and the composite `(fact_key, value)` becomes the FK target everything else uses. Home of the "no amounts" CHECKs. |
| 070 | `070_user_facts.sql` | Append-only observation log. Financial facts are not monotonic, so clearing must be an ordinary write, not a special un-record path. Keeps history; index serves both read patterns. |
| 071 | `071_user_facts_latest.sql` | Latest-wins view. Current value is DERIVED, never stored — same discipline as `user_active_tracks` and milestone suppression. |
| 072 | `072_fact_track_rules.sql` | `(fact_key, value) → track_id`, the direct analogue of `demographic_track_rules`. Bare CMS-authored mapping, RESTRICT on the track per migration 040. |
| 073 | `073_fact_entry_map.sql` | `(fact_key, value) → exactly one lesson or segment`, exactly-one enforced by `num_nonnulls(...) = 1`. **Nothing reads it in v1** — authoring config ahead of a forced-entry mechanism that does not exist. |
| 074 | `074_user_active_tracks_facts_arm.sql` | The additive arm on `user_active_tracks_for_user` **and its view twin**, joining `user_facts_latest` to `fact_track_rules`. The one change that makes facts do anything. **Must be applied last** — it will not compile without 071 and 072. |
| 075 | `075_seed_demo_vocabulary.sql` | Seeds the six demo keys + 13 values. Data only, separate from DDL, idempotent. No rules or entry-map rows: which track a fact grants is a content decision. |
| — | `076_user_external_ids.OPTIONAL.sql` | **Decision required, probably do not apply.** Only needed if `POST /facts` must accept a partner id. See §3. |

Independence: 072 and 073 need only 069. 070 → 071 → 074 is the chain. 075 can run any
time after 069.

**Both Supabase projects — financial FIRST, then Moosii.** Per the standing rule in
`migrations/README.md`, every file from 069 is applied to the **financial** project first
(pre-check, apply, verification), and only then to Moosii. A defect found on financial stops the
Moosii apply. Applying to both keeps the schemas identical, which is the point: with no
`fact_track_rules` rows the 074 arm returns nothing, so on Moosii resolution stays
byte-identical to migration 045. Facts only DO anything on financial, where rules get authored
and `POST /facts` is meant to live (decision D5).

**Financial's starting point is confirmed.** It was built from a schema dump of Moosii, so it
already has everything through 068 — including 045's `user_active_tracks_for_user` + view twin,
which 074 recreates — and its `app_settings.domain` is `'financial'`. Nothing below 069 needs
replaying before this set.

**059 is applied, and it helps this set.** The `user_mlp_data` LEFT JOIN rewrite went live
2026-09-11. It does not touch any object here, but it means zero-child users now get default
tracks — and financial-domain users are zero-child, so they will receive default tracks
alongside any fact-granted ones. ⚠ 059 has **no file in `migrations/`**; that gap is flagged
separately in `migrations/README.md` and does not block this set.

---

## 2. RLS posture per table

All six new objects follow the **backend-mediated** pattern from `docs/rls-sweep.md`: RLS
enabled with **no policy** (default-deny). The service-role backend bypasses RLS, so
nothing breaks, and every anon/authenticated client is shut out.

| Object | Posture | Note |
|---|---|---|
| `fact_keys`, `fact_values` | RLS on, no policy | CMS reads/writes through backend routes. If the CMS ever writes these Supabase-direct (the `screen_help` pattern) it needs an admin policy — a no-policy enable would deny the CMS itself. |
| `user_facts` | RLS on, no policy | Per-user, financial-adjacent. **The app never reads facts directly in v1**; admin reads go through `GET /facts/:user_id`. |
| `user_facts_latest` | **Plain view** + REVOKE ALL from anon/authenticated, GRANT SELECT to service_role | The REVOKE is what stops a client reading every user's facts; a direct SELECT is a permission error (tested). `security_invoker` was the first draft and was **rejected after a local test**, see below. |
| `fact_track_rules`, `fact_entry_map` | RLS on, no policy | CMS-authored config, backend-mediated. |
| `user_external_ids` (optional) | RLS on, no policy | Identity mapping, backend-only. |

**Why not `security_invoker` — measured, not theorised** (local PostgreSQL 17, §5).
`user_active_tracks` is a plain view, so its arms read their tables with the view OWNER's
rights. With `user_facts_latest` drafted as a `security_invoker` view nested inside it,
`user_facts`' RLS was applied as the CALLER instead. An `authenticated` reader of
`user_active_tracks` then got **zero** fact-granted tracks, silently, while service_role got
them all: the twins disagreed by role, with no error. As a plain view, the authenticated reader
sees the fact track exactly as it sees every other arm's, and a direct
`SELECT FROM user_facts_latest` is still refused. Do not "harden" it back.

**What does change for clients.** `user_active_tracks_for_user()` is SECURITY INVOKER, so an
anon/authenticated **call of the function** fails after 074 with `permission denied for view
user_facts_latest` — on Moosii too, since 074 applies to both. Reading the view is unaffected.
The backend calls the function as service_role only; 074's pre-check 5 asks Postgres whether
anything else does (D7).

**Add all of these to `docs/rls-sweep.md` when applied** — that file is the running list and
the standing rule is to add a table when its migration lands.

---

## 3. Decisions needed from Mark

**D1 — `user_facts.user_id` FK target.** The brief said "FKs the same target
`children.parent_id` does". Verified: **`children.parent_id` has no FK at all** — bare uuid
in the auth-uid space (`database.types.ts`, children `Relationships: []`). So "the same
target" is literally "no constraint". Options, drafted as (a):
- **(a) no FK** — matches `children.parent_id` exactly; accepts facts for a user that does
  not exist yet; gives up structural safety that invariant 3 prefers.
- **(b) `REFERENCES auth.users (id) ON DELETE CASCADE`** — the real referent, and what the
  recompute's `user_id` (from the verified JWT) actually is. **Recommended if facts only
  ever arrive for users who already exist.**
- **(c) `REFERENCES public."user" (id)`** — what `user_demographic_responses` does.
  **Rejected:** `user` only partially covers the auth-uid space, so it would reject facts
  for legitimate users. Not recommended.

**D2 — `external_user_id`.** Nothing maps a partner id to a Supabase uid. Either drop the
field from v1 (partner sends `user_id`; nothing to build) or apply draft 076 **and** decide
what populates it in the signup flow. Drafted 076 so the option is concrete, but it should
not be applied on its own — an empty mapping table plus a contract that 404s is worse than
not having the field. **New input (2026-09-12):** the cadence decision has partner provisioning
supply each financial user's timezone, which means the partner provisions the accounts. If that
provisioning goes through us, the partner can be handed the Supabase uid at that moment — which
makes **dropping `external_user_id` (076 unapplied)** the natural fit.

**D3 — clearing semantics.** See §4. The brief states v1 behaviour as "a cleared fact stops
adding the track but does not remove it." That is **only half true** as drafted, and the
half that is false is worth a deliberate decision.

**D4 — `FACTS_API_KEY`.** Confirm a separate key rather than reusing `INTERNAL_API_KEY`
(reasoning in `contract-facts-intake.draft.md` §8a: the internal key also unlocks `POST
/jobs`, i.e. arbitrary AI spend and content writes).

**D5 — domain gating for `POST /facts` (new since the first draft).** These migrations apply to
**both** Supabase projects so the schemas stay identical; with no rules authored, the 074 arm
is a no-op on Moosii. But `POST /facts` is a financial intake, and a partner has no business
writing facts into the Moosii deployment. The backend has known which deployment it is since
slice 1 (`DOMAIN`, boot-validated and cross-checked against `app_settings.domain`).
**Proposal:** the route returns `404` unless `DOMAIN = 'financial'`, so on Moosii it simply does
not exist. `GET /facts/:user_id` stays available on both, since an empty inspector is harmless
and is a quick way to confirm the schema landed. Detail in `contract-facts-intake.draft.md`
§8c-domain. Financial's `app_settings.domain` is confirmed `'financial'`, so the gate has a
correct value to key off on both projects.

**D6 — run 075 (demo vocabulary seeds) on financial ONLY?** 075 is data, not schema, and the
apply-both rule exists to keep SCHEMAS identical, which 069–074 already do. **Recommended:
financial only**, so a Moosii vocabulary screen never lists six financial facts. Both is
harmless if you prefer symmetry.

**D7 — two consumers 074 affects beyond its twins.**
- **Function callers.** After 074, an anon/authenticated *call* of
  `user_active_tracks_for_user()` fails on both projects (§2). The backend is service_role.
  Whether the app calls it with a user token is a question for the moosii-rn seat, and
  074's pre-check 5 answers it from `pg_stat_statements`. If something does, the options are to
  move that caller to the view, or to keep the function callable by making the fact arm read
  through a narrow SECURITY DEFINER helper. Decide once the answer is known.
- **`user_active_tracks_with_reason`.** A third derivation of active tracks that exists live
  but in no repo migration. It matches `user_active_tracks` exactly on Moosii today, but only
  the `new_user_default` arm is exercised. If it re-derives the arms, it will be missing every
  fact-granted track after 074 and needs a `fact` reason arm in the same transaction. 074's
  pre-check 6 dumps its definition, and that is the input for this decision.

**D8 — require `observed_at` for platform facts?** Without it, a retried call writes duplicate
history rows (tested; contract "Redelivery and conflicts"). Recommended: required when
`source='platform_api'`.

---

## 4. A fact that CLEARS, against §B's five monotonic sites

§B.4 of `FINDINGS-financial.md` listed five places the existing model assumes "a fact never
un-happens". How each one lands in this design:

1. **Presence-as-truth.** `child_milestones` has no value column, so the resolver tests
   `facts.has(milestone_id)` — asserting a fact is permanent by construction.
   **AVOIDED.** `user_facts` carries `value`, and the 074 arm joins `ON fact_key AND value`.
   Nothing anywhere tests for the mere existence of a fact row.
2. **First-reach-wins insert.** `ON CONFLICT DO NOTHING` silently drops a re-assertion.
   **AVOIDED.** The UNIQUE is `(user_id, fact_key, observed_at)` — an idempotency guard
   against redelivery of the *same observation*, not a latch on the key. A new value at a
   new instant always inserts.
3. **Suppression trumps due-ness, recomputed fresh each rebuild, no state table.**
   **INHERITED, and it is the good news.** Because resolution is derived per call,
   un-adding needs no cleanup path, no reconciliation, no "un-grant" record. The same
   property that makes milestone un-suppression automatic makes fact-clearing automatic.
4. **The check-in routing arm hardcodes `add = true`** — no removal in that vocabulary.
   **MIRRORED DELIBERATELY.** The fact arm likewise only ever ADDS; it emits no removal
   row and cannot subtract a track another arm granted.
5. **`recordCheckinMilestones` writes a permanent fact from an answer.**
   **NOT REUSED.** It is child-scoped and writes to `child_milestones`; facts v1 does not
   touch it. A financial check-in answer that should write a fact would need a separate
   `record_fact` action with a value — out of scope for v1.

### What actually happens when a fact clears

Precisely, because the brief's one-liner is half right:

- **TRUE — the arm never removes anything.** It contributes to `base_set` and emits no
  removal. If the track is *also* granted by a demographic rule, questionnaire routing, or
  a manual `add` mod, clearing the fact changes nothing at all.
- **TRUE — a human `delete` still wins.** The final `EXCEPT` on `user_mlp_mods` runs after
  `base_set`, so a fact can never resurrect a track an admin explicitly removed.
- **FALSE as a blanket claim — if the fact was the SOLE source, the track DOES leave.**
  The whole resolution is derived and recomputed per call. With the fact cleared,
  `fact_tracks` stops emitting the row, nothing else emits it, so it is absent from
  `final_tracks` on the next recompute. Nothing was stamped, so there is no orphan
  membership to clean up — and equally, nothing holds the track in place.
- **What genuinely persists:** `completed_items` history (a lesson already done stays
  done), and the user's existing `user_mlp` rows until a recompute actually runs —
  enforcement is at recompute, exactly as archival is (api-contract.md §3c).

**So: "stops adding" and "does not remove" are the same statement only when another arm
also grants the track.** If Mark wants a fact-granted track to be *sticky* — added once,
survives the fact clearing — that is a different mechanism: intake would have to stamp a
`user_mlp_mods(action='add')` row, which contradicts "derived, never stamped" and collides
with `apply_classification`'s manual-override guard (migration 020), since a stamped add is
indistinguishable from a human one at that point.

**Recommendation: keep derived removal as drafted.** It matches every other activation
source in the system, needs no cleanup path, and is the behaviour that makes a
non-monotonic fact model coherent in the first place. Confirm or overrule.

---

## 5. Local verification (2026-09-12) — what has actually been executed

Everything above was run, not just read, against a **throwaway local PostgreSQL 17.11**
cluster with Supabase-shaped roles (`anon`, `authenticated`, `service_role BYPASSRLS`, default
grants to all three). Stubs cover only the objects these files touch, and 074's predecessor was
rebuilt as 045 by stripping the two `ADDED (074)` edits. **This is not the live schema**: it
proves the SQL and the semantics, not that the live objects still match 045 — pre-checks 2, 3,
3b and 6 in 074 exist for that. Harness: `local-test/` (`run.py`; see its header).

| Result | |
|---|---|
| All 8 files apply cleanly, and apply cleanly **a second time** (idempotent) | PASS |
| 069/070 reject `1200`, `$40`, `0.82`, ` 12`, `-5`, `Low`, a numeric-leading key, an unknown pair, an unknown source | PASS |
| 070/071 history kept, latest-wins, a late-arriving OLDER observation does not win | PASS |
| 074 with zero rules: resolution identical to the 045 snapshot; function and view agree | PASS |
| 074 grant, then clear as sole source: track appears, then leaves, in BOTH twins (§4) | PASS |
| 074 clear when another arm also grants: track stays · archived target inert · admin `delete` beats a live fact | PASS |
| 072 rule on an unknown value refused · deleting a rule-targeted track refused | PASS |
| 073 exactly one target · one entry point per pair | PASS |
| 076 both uniqueness directions, per-partner namespaces, shape CHECKs · D1 option (b) FK compiles and cascades | PASS |

**Defects the run found, now fixed in the drafts:**
1. **071 `security_invoker` hid fact tracks from authenticated readers of `user_active_tracks`**,
   silently (§2). Now a plain view; re-tested: visible.
2. **070 `ON UPDATE CASCADE` rewrote history** — renaming `moderate`→`medium` changed past
   observations in place. Now `ON UPDATE RESTRICT`; re-tested: refused when in use, allowed when not.
3. **The contract's "redelivery is safe" was only partly true** — duplicate keys in one call,
   same-instant contradictions and redelivery without `observed_at` (contract, D8).
4. **RESTRICT raises 23503, not 23001.** Real PostgreSQL 17.11 returns 23503 for RESTRICT and
   NO ACTION alike. 072 is corrected. ⚠ **Outside this set**, migration 038 (verified in pglite),
   `CLAUDE.md` invariant 3 and `api-contract.md` all state 23001; any CMS code that catches 23001
   would miss the refusal. Not changed here; flagged for a rolled-back delete on Moosii to confirm.
