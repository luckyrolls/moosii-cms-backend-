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

## ⚠ RENUMBER BEFORE APPLYING

These drafts claim **060–067**, but migrations **060–063** were subsequently filed for the
catalog-integrity set (`migrations/060`–`063`, FINDINGS-catalog-integrity.md), which applies
first. Renumber this set to **064–071** before applying it, and update the cross-references
inside the files (065 cites 062 and 063 as its dependencies; the README table below does too).
Nothing here has been applied, so this is a rename, not a migration.

## 1. Apply order

Run in this order. Each file has its own header rationale and a VERIFICATION block.

| # | File | One-line rationale |
|---|---|---|
| 060 | `060_fact_vocabulary.sql` | `fact_keys` + `fact_values`: a closed CMS-authored vocabulary, so "is this a real fact?" is a foreign key — and the composite `(fact_key, value)` becomes the FK target everything else uses. Home of the "no amounts" CHECKs. |
| 061 | `061_user_facts.sql` | Append-only observation log. Financial facts are not monotonic, so clearing must be an ordinary write, not a special un-record path. Keeps history; index serves both read patterns. |
| 062 | `062_user_facts_latest.sql` | Latest-wins view. Current value is DERIVED, never stored — same discipline as `user_active_tracks` and milestone suppression. |
| 063 | `063_fact_track_rules.sql` | `(fact_key, value) → track_id`, the direct analogue of `demographic_track_rules`. Bare CMS-authored mapping, RESTRICT on the track per migration 040. |
| 064 | `064_fact_entry_map.sql` | `(fact_key, value) → exactly one lesson or segment`, exactly-one enforced by `num_nonnulls(...) = 1`. **Nothing reads it in v1** — authoring config ahead of a forced-entry mechanism that does not exist. |
| 065 | `065_user_active_tracks_facts_arm.sql` | The additive arm on `user_active_tracks_for_user` **and its view twin**, joining `user_facts_latest` to `fact_track_rules`. The one change that makes facts do anything. **Must be applied last** — it will not compile without 062 and 063. |
| 066 | `066_seed_demo_vocabulary.sql` | Seeds the six demo keys + 13 values. Data only, separate from DDL, idempotent. No rules or entry-map rows: which track a fact grants is a content decision. |
| — | `067_user_external_ids.OPTIONAL.sql` | **Decision required, probably do not apply.** Only needed if `POST /facts` must accept a partner id. See §3. |

Independence: 063 and 064 need only 060. 061 → 062 → 065 is the chain. 066 can run any
time after 060.

**Both Supabase projects.** With no `fact_track_rules` rows, the 065 arm returns nothing
and resolution is byte-identical to migration 045. So the whole set is safe to apply to
the Moosii project too, which keeps the two schemas identical as intended. Applying to
financial only is also fine but the two projects' resolution functions then diverge —
that divergence is the thing to avoid, so **apply to both** unless there is a reason not to.

**Not 059.** That number is reserved for the `user_mlp_data` LEFT JOIN rewrite already with
Mark (`CLAUDE.md`, parked list). 059 does not touch these objects; either order works.

---

## 2. RLS posture per table

All six new objects follow the **backend-mediated** pattern from `docs/rls-sweep.md`: RLS
enabled with **no policy** (default-deny). The service-role backend bypasses RLS, so
nothing breaks, and every anon/authenticated client is shut out.

| Object | Posture | Note |
|---|---|---|
| `fact_keys`, `fact_values` | RLS on, no policy | CMS reads/writes through backend routes. If the CMS ever writes these Supabase-direct (the `screen_help` pattern) it needs an admin policy — a no-policy enable would deny the CMS itself. |
| `user_facts` | RLS on, no policy | Per-user, financial-adjacent. **The app never reads facts directly in v1**; admin reads go through `GET /facts/:user_id`. |
| `user_facts_latest` | `security_invoker = true`, plus REVOKE from anon/authenticated, GRANT SELECT to service_role | A plain view would run as its owner and be a hole in `user_facts`' RLS. Invoker semantics change nothing operationally (every v1 reader is service-role or a SECURITY DEFINER function running as owner) and close that hole permanently. |
| `fact_track_rules`, `fact_entry_map` | RLS on, no policy | CMS-authored config, backend-mediated. |
| `user_external_ids` (optional) | RLS on, no policy | Identity mapping, backend-only. |

One subtlety worth knowing before someone "fixes" it: `user_active_tracks` (a plain view)
reads `user_facts_latest`. Permission checks on a plain view's underlying objects run as
the **view owner**, so revoking `user_facts_latest` from `authenticated` does **not** break
an authenticated client's read of `user_active_tracks`. The revoke only stops a *direct*
`SELECT ... FROM user_facts_latest`. That is exactly the intended split.

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
field from v1 (partner sends `user_id`; nothing to build) or apply draft 067 **and** decide
what populates it in the signup flow. Drafted 067 so the option is concrete, but it should
not be applied on its own — an empty mapping table plus a contract that 404s is worse than
not having the field.

**D3 — clearing semantics.** See §4. The brief states v1 behaviour as "a cleared fact stops
adding the track but does not remove it." That is **only half true** as drafted, and the
half that is false is worth a deliberate decision.

**D4 — `FACTS_API_KEY`.** Confirm a separate key rather than reusing `INTERNAL_API_KEY`
(reasoning in `contract-facts-intake.draft.md` §8a: the internal key also unlocks `POST
/jobs`, i.e. arbitrary AI spend and content writes).

---

## 4. A fact that CLEARS, against §B's five monotonic sites

§B.4 of `FINDINGS-financial.md` listed five places the existing model assumes "a fact never
un-happens". How each one lands in this design:

1. **Presence-as-truth.** `child_milestones` has no value column, so the resolver tests
   `facts.has(milestone_id)` — asserting a fact is permanent by construction.
   **AVOIDED.** `user_facts` carries `value`, and the 065 arm joins `ON fact_key AND value`.
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
