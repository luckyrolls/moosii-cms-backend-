# DRAFT contract section — facts intake

**Status: `[DESIGN]`, nothing built, nothing applied.** This is written to be pasted into
`docs/api-contract.md` as a new `§8. Facts intake` when the slice is actually built. It is
NOT in `api-contract.md` yet, deliberately: that file's own preamble says items marked
DELIVERED "reflect actual returned shapes from running code", and no code exists here.
Say the word and I'll inline it as a `[DESIGN]` section instead.

---

## 8. Facts intake — `[DESIGN]` (facts v1; draft migrations 060–066)

Platform-supplied facts about a user (financial domain). A fact is **boolean or a short
enum, never an amount** — enforced by CHECK constraints, not by this contract
(`fact_values`, draft 060). Facts add tracks through the derived resolution
(`user_active_tracks_for_user` + its view twin, draft 065); nothing is stamped.

### 8a. Machine-caller auth — what exists, and what this proposes

**What exists today.** Exactly one machine-caller scheme: a bearer shared secret,
`INTERNAL_API_KEY`, compared by exact match in `src/auth.ts` and mounted on `/jobs` only
(`src/index.ts`). `api-contract.md` §Conventions says to keep it "only for any
server-to-server/cron path". There is no partner concept, no key table, no scoped key.

**Why not reuse `INTERNAL_API_KEY` as-is.** That key also unlocks `POST /jobs`, which
creates arbitrary jobs — LLM and image spend, and writes across the content tree. Handing
an external partner the facts endpoint would hand them all of that too. The blast radius,
not the mechanism, is the problem.

**Proposal: same scheme, separate secret.** Reuse the bearer-shared-secret pattern exactly
— same header shape, same middleware shape, same error envelope — with its own env var
`FACTS_API_KEY`, mounted only on `POST /facts`. This is **not a third auth scheme**; it is
the existing scheme with the key scoped to one route, which is the whole point. Two
refinements over the `/jobs` original, because this key goes to an outside party:

- Compare with `crypto.timingSafeEqual` on equal-length buffers rather than `===`. The
  existing `===` is fine for an internal key; an externally-held one deserves better.
- Log the caller and a key fingerprint (first 6 chars of a SHA-256, never the key) on
  every request, so "who sent this fact" is answerable.

**If there is ever more than one partner**, replace the env var with a `partner_keys`
table storing a hash per partner, and put the partner id on each `user_facts` row via
`source_ref`. Deferred: one partner in v1, and a table for one row is ceremony.

`GET /facts/:user_id` is **not** machine-facing — it is the CMS inspector, so it takes the
ordinary admin JWT gate (`jwtAuthMiddleware`), like every other CMS read.

### 8b. `POST /facts` — record observations, then recompute

```
POST /facts
Authorization: Bearer <FACTS_API_KEY>          // server-to-server only; never the SPA
Content-Type: application/json

Body: {
  user_id?:          string,   // Supabase auth uid — SEE THE IDENTITY DECISION BELOW
  external_user_id?: string,   // partner's own id; requires draft 067 to resolve
  facts: [
    { key: string, value: string, observed_at?: string }   // ISO 8601; defaults to now()
  ]
}

→ 200 {
    user_id: string,
    written: number,            // history rows inserted
    skipped: number,            // exact duplicates (same user, key, observed_at)
    recompute: { ok: true, items_written: number }
                | { ok: false, error: string }    // see "recompute failure" below
  }
→ 400 invalid_request   — no facts, or neither/both id fields
→ 400 unknown_fact      — key or value not in the vocabulary; NAMES THE OFFENDER
→ 401 unauthorized      — bad or missing key
→ 404 unknown_user      — user_id / external_user_id does not resolve
→ 500 facts_write_failed
```

**Validation is all-or-nothing.** The whole batch is checked against `fact_values` before
anything is written, so one bad entry rejects the call and writes nothing — no partial
batches to reconcile. The error names the offending entry and its position:

```json
{ "error": { "code": "unknown_fact",
             "message": "facts[1]: unknown key/value 'credit_utilization_band'='extreme'" } }
```

**Writes are append-only.** Each entry becomes one `user_facts` row with
`source='platform_api'`. A fact that CLEARS is an ordinary write of the new value, not a
delete and not an update. Re-delivering the same observation (same user, key,
`observed_at`) hits the UNIQUE and is counted in `skipped`, so redelivery is safe.

**Then recompute.** After the rows commit, the handler calls `rebuildOneUser(user_id)` —
the same function `POST /mlp/recompute` uses — so the new facts reach the plan in the same
call. Synchronous, following the `/mlp/recompute` precedent (one fast rpc, no job to poll).

**Recompute failure does not fail the request.** The facts are already committed and
durable, and resolution is derived, so the next recompute from any trigger picks them up.
Failing the call would make the partner retry and re-send facts that already landed. So a
rebuild error returns **200** with `recompute: { ok: false, error }` and is logged loudly.
This is now a live possibility rather than a theoretical one: `MlpInvalidWeights` (the
slice-2 guard) throws where the round-robin cannot be built.

**Scope:** one user per call. A partner with a backlog sends N calls.

### 8c. `GET /facts/:user_id` — CMS inspector

```
GET /facts/:user_id?limit=<int?>          // limit applies to history; default 200
Authorization: Bearer <admin Supabase JWT>

→ 200 {
    user_id: string,
    latest: [                    // one entry per key — the CURRENT truth (user_facts_latest)
      { fact_key, value, value_label, observed_at, source, source_ref }
    ],
    history: [                   // every observation, newest first
      { fact_key, value, observed_at, source, source_ref, created_at }
    ],
    tracks_granted: [            // which active tracks the CURRENT facts account for
      { fact_key, value, track_id, track_name }
    ]
  }
→ 401 · 403 (non-admin) · 500 facts_read_failed
```

`latest` and `history` are the two questions an operator actually asks: what does the
system believe now, and how did it get there. `tracks_granted` resolves the current facts
through `fact_track_rules` so "why does this user have that track" is answerable without
reading the SQL — the same instinct behind `suppressed_by` on `/questionnaire-status`.
A user with no facts returns `200` with three empty arrays, never a 404.

### 8d. Identity — the open decision

`external_user_id` cannot be resolved today: no table maps a partner id to a Supabase uid.
Either the partner sends `user_id` and the field is dropped from v1, or draft 067
(`user_external_ids`) is applied AND something in the signup flow populates it. Until that
is settled, treat `POST /facts` as accepting `user_id` only.
