# FINDINGS — financial fact derivation from MX data

2026-09-27 · Investigate-first · no code, no migrations. Reads: this repo, the financial DB
(read-only transaction), moosii-cms (read-only grep). MX sandbox: read calls plus four
`widget_urls` requests (§7). Keys never printed.

**Decisions already made (Mark):** no MX Insights (not enabled, not asking); facts derive from
account and transaction data; credit limit = `credit_limit` when present, else
`available_credit + balance` with the fact stamped `source='estimated'`; facts are booleans or enums,
never an amount (invariant 12). Anything below marked **(propose)** is for Mark to decide.

## TL;DR

- **Most of the plumbing exists.** Vocabulary, the append-only log, the latest-wins view, the
  fact→track rules and the facts arm of track resolution are all live on financial (069–076). The
  **7 rules are already authored** (084). What's missing is only the **derivation**: an MX reader,
  four pure rules and a `derive_facts` job. There's **no adapter interface in this repo today**; every
  grep hit for "adapter"/"derive" is unrelated.
- **The MLP doesn't change.** Facts add tracks through `user_fact_track_ids` →
  `user_active_tracks_for_user` (074). `generateFullMLP` / `computeUserMlp` never see a fact.
  **Nothing touches the frozen algorithm** (invariant 1).
- **Identity needs no mapping table.** MX endpoints take `{user_identifier}` = "the user `id` you
  defined or the MX `guid`" (spec:4253), confirmed live: `GET /users/moosii-sandbox-probe-1/accounts`
  → 200. So we **create the MX user with `id` = our Supabase auth uid** and address it by that.
- **One migration is needed:** `user_facts.source` allows only `platform_api | cms | manual` (070), so
  Mark's `'estimated'` (and a `'derived'` for computed facts) needs the CHECK widened. A second one is
  optional (the subscription first-seen ledger, §2.3).
- **Two demo blockers that aren't code:** financial has **one auth user** (the super_admin), and
  `user_facts.user_id` must be an auth user (FK, 076), so a demo user must exist first (Mark creates
  it). And the fact-granted tracks have **no published lessons** (only Getting Oriented has 2), so
  facts will add *tracks* but the MLP will gain no *items* until those tracks get content.
- **Widgets:** `connect_widget` → 200 with a URL. All three Insights widget types → **403 "Client
  does not have access to Pulse features"** (§7).

## 1. What exists today

| Piece | Where | State (financial, 2026-09-27) |
|---|---|---|
| Vocabulary | `fact_keys` / `fact_values` — `migrations/069_fact_vocabulary.sql`; seed `075_seed_demo_vocabulary.sql:41-77` | 6 keys, 13 values. `false` is a real value; **absence = unknown** (075:63-66) |
| Fact store | `user_facts` — `070_user_facts.sql` (append-only; `(fact_key, value)` FK RESTRICT; no-numeric CHECK; `source` CHECK `platform_api\|cms\|manual`; UNIQUE `(user_id, fact_key, observed_at)`); `user_id` FK `auth.users` CASCADE (076) | **0 rows** |
| Current value | `user_facts_latest` — `071` (latest-wins by `observed_at`) | — |
| Fact → track | `fact_track_rules` — `072`; rows seeded by `084_financial_content_seed.sql:461` | **7 rules** (below) |
| Fact → entry lesson | `fact_entry_map` — `073` ("NOT read by anything in v1") | 0 rows |
| Resolution | `user_fact_track_ids(uuid)` SECURITY DEFINER + facts arm in `user_active_tracks_for_user` and its view twin — `074` | live |
| Intake | `POST /facts` (partner, `FACTS_API_KEY`), `GET /facts/:user_id` (admin) — `src/facts/{router,service,validate,db}.ts`; contract §8 | live; `recordFacts` = validate → conflict check → one INSERT … ON CONFLICT DO NOTHING → `enqueueRebuildUserIfIdle` (`service.ts:32-71`) |
| Derivation / adapter | — | **none** |
| CMS display | moosii-cms has no caller of `/facts/` | **none** (moosii-cms seat) |

**The 7 rules (live):** `credit_utilization_band` high → Credit Health; moderate → Credit Health ·
`has_direct_deposit` false → Paycheck Setup · `has_emergency_buffer` false → Building a Buffer ·
`new_subscription_recent` true → Subscription Audit · `saving_for_home` true → Building a Buffer ·
`wants_debt_payoff_plan` true → Debt Payoff Plan. Default track (`new_user_tracks`): Getting Oriented.
Published lessons per track: Getting Oriented 2, all others 0.

## 2. Per fact: MX fields, rule, windows, unknown

Common to all four:
- **Source data:** `GET /users/{id}/accounts` (`AccountResponse`) and
  `GET /users/{id}/transactions?from_date=…` (`TransactionResponse`, paginate to the end). Use only
  `status = POSTED` transactions and accounts with `is_closed = false`.
- **Freshness gate:** if any member `is_being_aggregated`, the job fails "aggregation in progress"
  (retry later). `observed_at` = the latest `successfully_aggregated_at` across the user's members:
  the instant the data describes. It's also the idempotency key (§4).
- **Unknown = write no row for that key** (the 075 convention). The job result records *why* it's
  unknown. Consequence: a fact that was known and becomes unknowable keeps its old value (latest
  wins). Accepted for v1. An expiry would mean touching `user_fact_track_ids` (invariant 8), so it's
  deliberately not proposed now.
- **History length** `H` = days between the earliest and latest POSTED transaction on the relevant
  accounts. Sandbox gives ~90 days (2026-06-29 → 2026-09-27).

### 2.1 `has_direct_deposit` (boolean)
- **Fields:** `TransactionResponse.is_direct_deposit`, `type`, `transacted_at`, `account_guid` →
  account `type` ∈ {CHECKING, SAVINGS}.
- **Rule (propose):** `true` if there are **≥ 2** `is_direct_deposit = true` CREDIT transactions on
  distinct dates in the last **60 days** (the vocabulary says "recurring", and two payments make a
  pattern). `false` if there's at least one deposit account, `H ≥ 60`, and none.
- **Unknown:** no open CHECKING/SAVINGS account; `H < 60`; or `is_direct_deposit` null on every
  transaction (the flag isn't supplied).
- **Sandbox:** 18 flagged "Paycheck" credits on 18 distinct dates → **true** (adds no track).

### 2.2 `has_emergency_buffer` (boolean)
- **Fields:** accounts CHECKING + SAVINGS `balance` (prefer `available_balance` when non-null);
  transactions `type = DEBIT` on those accounts in the last 90 days, excluding transfers between the
  user's own accounts and credit-card payments (`top_level_category` Transfer, and category Credit
  Card Payment).
- **Rule (propose):** `liquid = Σ balances`; `monthly_spend = Σ qualifying debits over the window ÷
  (window days ÷ 30)`. `true` if `liquid ≥ 1 × monthly_spend`, else `false`. **Mark decides the
  multiplier:** 1 month (propose, gentle) or 3 (MX's "Save Enough To Live On" talks in 1–3 months).
  The numbers exist only in memory inside the job; only the boolean is written.
- **Unknown:** no open CHECKING/SAVINGS; `H < 60`; `monthly_spend = 0` (no spending to measure against).
- **Sandbox:** balances ≈ 0.49M + 0.51M against ordinary spend → **true** (adds no track).

### 2.3 `new_subscription_recent` (boolean) — needs first-seen logic
- **Fields:** `TransactionResponse.is_subscription`, `type = DEBIT`, `merchant_guid` (present on 850
  of 910 sandbox transactions; fall back to normalised `description` when null), `transacted_at`.
  `is_recurring` is null in sandbox and `/repeating_transactions` returned 0, so neither is used.
- **Rule (propose):** a subscription merchant is *new* when its **first-seen** date is within the last
  **30 days**. `true` if any merchant is new; `false` otherwise.
- **The state it needs.** "First seen" is only trustworthy with enough history before the window: a
  monthly subscription seen for the first time 5 days ago is new only if we'd have seen it in the
  prior ~60 days. Two options:
  - **(A) Stateless, window-bounded (propose for the demo):** compute first-seen from the fetched
    history; require `H ≥ 90` (30-day window + 60-day baseline). Catches monthly subscriptions, but
    an annual subscription always looks new. No schema.
  - **(B) First-seen ledger (propose for v1 proper):** a backend-only table
    `subscription_first_seen (user_id uuid FK auth.users CASCADE, merchant_key text, first_seen_at
    timestamptz, first_job_id uuid, PK (user_id, merchant_key))`, written INSERT … ON CONFLICT DO
    NOTHING. It keeps the true first sighting as history rolls off the MX window. RLS on, no policy,
    service_role only. It holds no amounts, but a merchant key is spending behaviour, so it stays
    backend-only. On the first run for a user, the ledger is seeded from the whole history and
    **nothing is reported new** until the user has been observed for 30 days, which avoids
    "everything is new" on day one.
- **Unknown:** `is_subscription` null on every transaction, or `H < 90` under (A).
- **Sandbox:** only Netflix, first seen 2026-07-04 (charges 07-04, 07-09, 09-18) → **false** (adds no track).

### 2.4 `credit_utilization_band` (enum low | moderate | high)
- **Fields:** accounts `type = CREDIT_CARD`, open: `balance`, `credit_limit`, `available_credit`.
- **Limit (Mark's rule):** per card, `credit_limit` if > 0; else `balance + available_credit` if both are
  non-null, and the fact is stamped **`source = 'estimated'`** when **any** card used the estimate.
  Negative balances (the card is in credit) count as 0.
- **Rule (propose):** `util = Σ balance ÷ Σ limit` across cards (total, like MX's own definition).
  Bands: **low < 20%, moderate 20–<30%, high ≥ 30%** (propose; the same cut-points as MX's
  CreditUtilization warning/alert, so we'd agree with MX if Insights is ever enabled. Mark decides).
  Only the band is written; `util` never leaves the job's memory.
- **Unknown:** no open credit card (the vocabulary has no "no cards" value); a card with no balance;
  or a card whose limit can't be determined (`credit_limit` and `available_credit` both null).
- **Sandbox:** one card, `credit_limit` null, `available_credit` 3000, balance 8356.55 → estimate ≈ 74%
  → **high, `source='estimated'`** → adds **Credit Health**.

**Expected demo outcome for the probe data:** four rows (`true`, `true`, `false`, `high`/estimated).
The user's tracks = Getting Oriented (default) + Credit Health (fact). The MLP is unchanged in items,
because Credit Health has no lessons yet.

## 3. Identity: partner user → MX user

- **(A) The partner's own MX user.** Data under another MX client isn't readable with our keys, so the
  partner derives and `POST /facts` (the existing path, `source='platform_api'`). We'd need nothing new.
- **(B) We create the MX user (demo assumption).** `POST /users` with `id` = **our Supabase auth uid**,
  then connect via the Connect widget (§7) or, in sandbox, `mxbank` through the API. Every call we need
  accepts that id (spec:4253; verified live), so **no mapping table**. Drafted `077_user_external_ids`
  (partner id ↔ uid) stays unapplied and unrelated.
- **The existing probe user** is `id = moosii-sandbox-probe-1`, not a uuid, and there's no matching
  financial auth user. For the slice: Mark creates a financial demo auth user (Supabase dashboard →
  Add user), then we create a *second* MX sandbox user with `id` = that uid and connect `mxbank`. The
  probe stays as a scratch user, per Mark.

## 4. Job shape: `derive_facts`

```
POST /jobs   (INTERNAL_API_KEY or admin JWT — unchanged)
{ "type": "derive_facts", "input": { "user_id": "<auth uid>" } }   → 202 { job_id }
```
- **Handler** `src/jobs/handlers/deriveFacts.ts`, registered in `src/jobs/registry.ts`. Financial only:
  fails fast with `domain_not_supported` when `DOMAIN ≠ financial` (like `POST /facts`, invariant 4).
- **Steps:** provider.getAggregation(user) → gate → provider.getAccounts / getTransactions (window 90
  days) → four **pure** rule functions (`src/facts/derive/rules.ts`, unit-tested with sandbox-shaped
  fixtures) → **`recordFacts` core** (reused, not duplicated) with `source` `derived` / `estimated` and
  `source_ref = 'job:<job_id>'` → its coalesced per-user rebuild.
- **Idempotent:** `observed_at` = the aggregation timestamp, so re-running on the same MX data inserts
  nothing (`ON CONFLICT DO NOTHING`, `service.ts:14-17`). If a rule change yields a *different* value
  for the same aggregation, `recordFacts` refuses it as a contradiction (`service.ts:38-53`) and the job
  fails loudly; refresh the aggregation first. That's intended: the log never holds two values for
  one instant.
- **Provenance (not `ai_generation_log`, since no AI call):** `jobs.input` (who, which user), the
  `jobs.result` payload below, `user_facts.source` / `source_ref = job:<id>`. The result records
  **evidence without amounts**:
  ```
  { rule_version: "facts-derive/1", observed_at, mx_user_identifier, history_days,
    facts: [ { fact_key, value | null, status: "written"|"unchanged"|"unknown",
               reason: "no_credit_card" | "limit_estimated" | "history_too_short" | …,
               evidence: { accounts: 6, cards: 1, flagged_txns: 18, window_days: 60 } } ],
    written, rebuild_enqueued }
  ```
  No balances, limits, spend or percentages are stored anywhere. MX stays the source of truth: to
  debug, re-run.
- **Trigger for the demo:** manual. A `curl` with `INTERNAL_API_KEY` against the financial service,
  or a CMS button later (moosii-cms seat). No cron, no webhook in v1.
- **Adapter** (`src/facts/derive/provider.ts`):
  `FinancialDataProvider { getAggregation(userRef), getAccounts(userRef), getTransactions(userRef, fromDate) }`,
  with `MxProvider` (HTTP Basic, `Accept-Version: v20250224`, `MX_BASE_URL` default `https://int-api.mx.com`).
  `MX_CLIENT_ID` / `MX_API_KEY` are checked when the job runs, **not at boot**, so a missing key
  fails one job, not the deploy.

## 5. How facts feed the MLP

Exactly like demographics and questionnaire routing on the parenting side. Every source converges on
`user_active_tracks_for_user` (+ view twin), and 074 added facts as one more arm, fed by
`user_fact_track_ids(p_user_id)` (latest fact × `fact_track_rules`). The rebuild reads active tracks
and then runs the frozen algorithm over the published pool.
- **The algorithm needs no knowledge of facts.** It's purely "facts add tracks". **Nothing proposed
  here touches `generateFullMLP` / `computeUserMlp`**, 074, or `mlp_item_pool` (invariants 1 and 8
  untouched).
- `false` values add tracks too (Paycheck Setup, Building a Buffer). `low` adds nothing.
- `fact_entry_map` (a direct entry lesson) stays unused. Using it would need an MLP entry mechanism,
  which *would* touch the algorithm: **flag, out of scope**.

## 6. MockInsightsProvider (behind the same adapter family)

- **Interface:** `InsightsProvider { listInsights(userRef): Promise<Insight[]> }`, with `Insight` = the
  subset of MX `InsightResponse` we'd use: `guid, template, title, micro_title, micro_description,
  micro_call_to_action, created_at, has_been_displayed, is_dismissed`.
- **`MxInsightsProvider`:** `GET /users/{id}/insights`; maps 403 "Client does not have access to
  Pulse features" to `InsightsNotEnabled` (not a crash).
- **`MockInsightsProvider`:** canned list for the probe/demo user. Templates `CreditUtilization`,
  `CreditCardCloseToLimit`, `SubscriptionDetected`; `guid` `MOCK-…`; our own copy with **no amounts**
  and not MX's wording (e.g. "Card use is running high", "One of your cards is near its limit",
  "A new subscription showed up"); CTA "Learn more".
- **Selection:** `INSIGHTS_PROVIDER=mock|mx` (default `mock` on financial while Insights is off).
  **Not an input to facts** (Mark's decision). It only feeds a future display surface. Not in the slice.

## 7. Widgets (sandbox, probe user)

`POST /users/USR-6efa8756-…/widget_urls`:
| `widget_type` | Result |
|---|---|
| `connect_widget` (`mode: aggregation`, `data_request.products: [transactions]`) | **200** — URL on `int-widgets.moneydesktop.com`, path `/md/connect/…` (single-use; not stored — the saved copy was deleted) |
| `pulse_widget` | **403** `{"error": {"message": "Client does not have access to Pulse features", "status": "forbidden", "type": "forbidden_error"}}` |
| `mini_pulse_carousel_widget` | **403** — same body |
| `micro_pulse_carousel_widget` | **403** — same body |

So the Connect widget is usable for a real (non-API) connection flow later; Insights widgets are off,
consistent with §4.4 of FINDINGS-mx-sandbox.

## 8. Contract and migrations

**`docs/api-contract.md`:**
- Job types list (§"Job types in use"): add `'derive_facts'`.
- New section (§8d): `derive_facts` input, preconditions (financial; MX user exists with `id` = uid;
  aggregation finished), result shape (§4), errors (`domain_not_supported`, `mx_user_not_found`,
  `aggregation_in_progress`, `mx_auth_failed`, `facts_conflict`).
- §8 `source` values: add `derived` (computed by us) and `estimated` (computed with an estimated
  input). **`POST /facts` still accepts only `platform_api | cms | manual`**, so a partner can't
  claim `derived`. That means a separate internal allow-list next to `FACT_SOURCES` (`validate.ts:6`).
- `GET /facts/:user_id` is unchanged; it already returns `source` / `source_ref`.

**Migrations:**
- **100 (both projects, schema):** widen `user_facts_source_valid` to
  `platform_api | cms | manual | derived | estimated` (DROP + ADD CONSTRAINT in one transaction;
  existing rows all pass). Both projects, because the schema is shared (invariant 4). Moosii has no
  facts, so it's harmless there.
- **101 (optional, both projects):** `subscription_first_seen`, only if §2.3 option B is chosen.
  Backend-only: RLS on, no policy, grants service_role only; don't repeat the 099 situation.
- **None** for identity (§3), rules (already seeded) or vocabulary.
- **Data, financial only (optional):** the 075 descriptions say "supplied by the platform"; they could
  say "derived from linked accounts". Cosmetic.

## 9. Slice plan: the smallest end to end

0. **Decisions (Mark):** thresholds (§2: 2 deposits in 60 days; buffer multiplier 1 or 3; bands
   20/30); `derived` + `estimated` as source values; §2.3 option A for the demo.
1. **Migration 100** (financial, then Moosii). Code tolerates the old CHECK: until 100 is live, a
   `derived` insert fails the job cleanly with `facts_write_failed`.
2. **Mark:** create a financial demo auth user (Supabase dashboard). Add `MX_CLIENT_ID` /
   `MX_API_KEY` to the **financial** Render service.
3. **MX sandbox (needs a go; sandbox writes):** `POST /users {id: <demo uid>}` and connect `mxbank`
   (`mxuser` + ordinary password), as in §4.4.
4. **Code (this repo):** `MxProvider`, `rules.ts` (+ unit tests, added to `npm test`), the
   `deriveFacts` handler reusing `recordFacts`, a registry entry, contract §8d + migration README.
   About 4 files plus tests.
5. **Run:** `POST /jobs {type: derive_facts, input: {user_id}}` on financial → expect 4 `user_facts`
   rows (true / true / false / high-estimated) → a coalesced rebuild → active tracks = Getting Oriented
   + Credit Health.
6. **Show it:** `GET /facts/:user_id` already returns latest + history. The **CMS user inspector needs
   a small facts panel** (latest per key with `source`; "estimated" visible). That's **moosii-cms seat
   work**, flagged for that seat. The inspector's existing MLP preview (§3b) will show Credit Health
   among the active tracks with no new items, which is correct until Credit Health has lessons.

Not in the slice: MockInsightsProvider (§6), the ledger (§2.3 B), a CMS "derive" button, webhooks or cron.

## Other notes
- Sandbox drift: the probe user's transaction count went from 910 (§4.4 run) to 900 an hour later.
  The sandbox data isn't static, so tests must use fixtures, not live sandbox numbers.
- `observed_at` = aggregation time means two derive runs on the same aggregation are no-ops even hours
  apart. That's the intended idempotency.
