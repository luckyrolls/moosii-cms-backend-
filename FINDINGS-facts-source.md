# FINDINGS — facts-source audit: is every v1 financial fact reachable via a supported MX API? (2026-09-15)

Investigation only. No code, no migrations, no adapter change, no writes to either Supabase project
(financial was read in a read-only session). No call was made to MX (see §3 for why).

## Summary

1. **This repo never says where any fact comes from in MX.** No file, migration, doc, env var or
   commit mentions MX, Nexus or insight types. The only hit is a negative: the optional 077 draft is
   "NOT AN MX ADAPTER" (`docs/drafts/facts-v1/077_user_external_ids.OPTIONAL.sql:21`). The "MX
   Platform API + Nexus API behind the derivation adapter" stack note and the "facts map to MX
   insight types" decision are **not recorded here**; they must live in another repo or outside the
   repos. Every fact is therefore class **D (unstated)**.
2. **The repo's design has the PARTNER PLATFORM derive facts, not this backend.** The vocabulary says
   so fact by fact ("supplied by the platform", "the threshold lives on the platform side",
   `migrations/075_seed_demo_vocabulary.sql:42-54`), and `POST /facts` receives finished facts
   (`docs/api-contract.md:2134-2140`). No derivation adapter exists in this repo.
3. **The sandbox reachability check could not be run: there are no MX credentials.** `.env` and
   `.env.example` contain no MX/Nexus variable (checked by name only), and none appears in code or
   git history. Per the brief's stop rule nothing was created and nothing was called. Core-data and
   Insights reachability are **UNOBSERVED**, not assumed.
4. **Nothing is shown to depend on Nexus.** No fact is recorded as coming from Nexus, so no fact is
   provably dead. Four facts describe bank-account behaviour and need a concrete MX source chosen
   and tested. Two are user-declared intents with no bank-data dependency at all.

## 1. Fact inventory

The v1 vocabulary is the six keys seeded by 075, confirmed **live on financial** (read-only,
2026-09-15: PG 17.6, `app_settings.domain='financial'`; 6 keys, 13 values; 0 `fact_track_rules`,
0 `fact_entry_map`, 0 `user_facts` rows). Moosii does not carry them (decision D6).

"Sandbox result" is **not run** for every row: there are no MX credentials (§3). Status follows the
brief's scale; **re-map** here means "no source is recorded; choose and verify a Platform API core
source", since there is nothing to re-map *from*.

| Fact | Type | Allowed values | Assumed MX source (as recorded) | Class | Sandbox result | Status |
|---|---|---|---|---|---|---|
| `credit_utilization_band` | enum | low, moderate, high | None recorded. Vocabulary: "banded credit utilization supplied by the platform" | D | not run (no creds) | **re-map** → A (proposed: credit-card accounts, balance ÷ credit limit, banded partner-side) |
| `has_direct_deposit` | boolean | true, false | None recorded. Vocabulary: "platform observes a recurring payroll deposit" | D | not run (no creds) | **re-map** → A (proposed: recurring income/paycheck-categorised credits on deposit accounts) |
| `new_subscription_recent` | boolean | true, false | None recorded. Vocabulary: "a new recurring subscription charge in its recent window" | D | not run (no creds) | **re-map** → A (proposed: our own recurrence detection over debit transactions); B only if MX's recurring or insight feature is enabled |
| `has_emergency_buffer` | boolean | true, false | None recorded. Vocabulary: "platform judges the user to hold a cash buffer; the threshold lives on the platform side" | D | not run (no creds) | **re-map** → A (proposed: liquid balances on checking/savings accounts vs a spend-based threshold, all partner-side) |
| `wants_debt_payoff_plan` | boolean | true, false | None — "user-declared intent, forwarded by the platform" | D | n/a (not bank data) | **OK** — no MX dependency; comes from the partner's UI or onboarding |
| `saving_for_home` | boolean | true, false | None — "user-declared goal, forwarded by the platform" | D | n/a (not bank data) | **OK** — no MX dependency; comes from the partner's UI or onboarding |

The proposed mappings are **untested against MX**. They come from what the fact descriptions ask
for, not from MX responses, and the MX field and endpoint names must be confirmed (§5). Whatever
MX returns, the no-amounts rule holds: amounts and percentages stay on the partner side and only the
band or boolean is POSTed (`migrations/070_user_facts.sql:69-72`).

## 2. File:line evidence

**Where each fact is defined**
- Keys, kinds and descriptions: `migrations/075_seed_demo_vocabulary.sql:41-54`.
- Enum values: `:57-61`. Boolean values: `:67-77`. "Bands only; numeric thresholds stay on the
  PLATFORM side": `:10-13`.
- Shape rules for every fact (boolean or short enum, never an amount):
  - vocabulary checks: `migrations/069_fact_vocabulary.sql:7`;
  - observation checks: `migrations/070_user_facts.sql:69-72`;
  - allowed sources `platform_api | cms | manual`: `:74-75`.
- Contract: `docs/api-contract.md:2134-2140` ("platform-supplied facts", boolean or short enum) and
  `:2166` (`source` default `platform_api`).
- Tests use the same six keys: `src/facts/__tests__/{validate,service,router}.test.ts`,
  `docs/drafts/facts-v1/local-test/tests.sql`.

**Where the assumed source is defined**
- Nowhere names an MX API. The only statements about the source are "supplied by / observed by / judged
  by / forwarded by the platform" (`075:42-54`) and "the platform sends … the API layer must bucket
  it" (`FINDINGS-financial.md:444-446`).
- `docs/drafts/facts-v1/077_user_external_ids.OPTIONAL.sql:21` explicitly scopes an MX adapter OUT.
- `docs/architecture-notes.md` has no adapter-interface notes.
- `.env` / `.env.example`: no MX variables. `git log --all --grep` for MX or Nexus: no commits.

## 3. Sandbox reachability — as observed

| Check | Endpoint (intended) | Result | Error class |
|---|---|---|---|
| Credentials present | — | **None found** in `.env`, `.env.example`, code or git history | n/a (precondition failed) |
| List users / members (find an existing test member) | Platform API `GET /users`, `GET /users/{user_guid}/members` | **Not called** | n/a |
| Accounts for an existing member | `GET /users/{user_guid}/members/{member_guid}/accounts` | **Not called** | n/a |
| Transactions for an existing member | `GET /users/{user_guid}/members/{member_guid}/transactions` | **Not called** | n/a |
| Any Insights endpoint | Platform API Insights (e.g. `GET /users/{user_guid}/insights`) | **Not called** | n/a |

**Why it stopped here.** The brief allows existing sandbox members only, read-only, using "the MX
sandbox credentials in .env". Those credentials do not exist in this checkout, so there was nothing
to authenticate with and no member could be listed. Nothing was created. The endpoint paths above
are the ones to call once credentials exist; they are listed from MX's public Platform API layout
and were **not verified by a call**.

**To finish step 3:** put the MX sandbox client id and API key in `.env` (names of your choosing,
e.g. `MX_CLIENT_ID` / `MX_API_KEY` / `MX_BASE_URL`; never committed) and re-run this audit's step 3.
It needs an existing test user and member in that sandbox.

## 4. Gap

- **Survive unchanged (2):** `wants_debt_payoff_plan`, `saving_for_home`. They are user-declared, so
  no bank data or MX product is involved.
- **Need a Platform API core source chosen and verified (4):** `credit_utilization_band`,
  `has_direct_deposit`, `new_subscription_recent`, `has_emergency_buffer`. The proposed derivations
  are in the table. Each needs only accounts (type, balance, credit limit) and categorised
  transactions (plus recurrence, which the partner can compute from transaction history if MX doesn't
  provide it). If "facts map to MX insight types" was the plan, these four are exactly the ones at
  risk. They survive on core data **only if** the fields in §5 are available with our credentials.
- **Dead without Nexus or Insights (0 provable):** no fact is recorded as Nexus-sourced. The real
  risk is `new_subscription_recent`, whose "new recurring subscription" wording reads like an MX
  insight or recurring-transaction feature. It is only safe on core data if we do recurrence
  detection ourselves.
- **Ownership gap:** the repo assumes the partner platform computes facts, while the brief assumes a
  derivation adapter in our stack. Before any derivation code is written, decide who owns derivation
  (partner or us) and in which repo. That changes whose MX credentials matter.

## 5. Ask MX

1. **Sandbox credentials for the Platform API** (client id and API key) for our integration, plus
   confirmation of which products are enabled on them (core aggregation, transactions, Insights).
2. **Nexus replacement:** confirm Nexus is unavailable to us, and name the Platform API endpoint or
   product that replaces each Nexus capability we listed.
3. **Insights enablement:** is the Platform API Insights product enabled for our client in sandbox
   and production? If not, what does enabling it take (contract, pricing)? Which insight types exist
   for recurring or new subscriptions, income or direct deposit, and credit utilization?
4. **Recurring transactions:** is there a Platform API core endpoint or transaction field that marks
   recurring charges and flags a newly started one, and is it enabled for us?
5. **Direct deposit / payroll:** which transaction category or flag identifies a payroll deposit in
   core transaction data?
6. **Credit utilization inputs:** confirm credit-card accounts expose both current balance and
   credit limit in core account data, and how often those refresh.
7. **Sandbox test data:** do the standard test institutions include direct deposits, recurring
   subscriptions and credit cards with limits, so each of the four facts can be exercised end to end?

## 6. Disagreements between fact definitions

| Where | Says | Live / applied (069–075) |
|---|---|---|
| `FINDINGS-financial.md:273, :440` | `has_emergency_fund` / "has an emergency fund" | `has_emergency_buffer` (`075:47`) |
| `FINDINGS-financial.md:327, :336, :375` (draft DDL) | tables `fact_definitions`, `fact_allowed_values`, view `user_facts_current` | `fact_keys`, `fact_values`, `user_facts_latest` (069, 071) |
| `FINDINGS-financial.md:366` (draft DDL) | source may be `platform_api \| questionnaire \| cms \| manual` | `platform_api \| cms \| manual`, no `questionnaire` (`070:74-75`; contract `:2166`) |
| `FINDINGS-financial.md:445-446` | example enum band `low\|mid\|high` for a savings rate | only enum is `credit_utilization_band` = `low\|moderate\|high` (`075:59-61`); no savings-rate fact exists |

The first three are an early draft that the applied migrations superseded. None of them is a live
inconsistency: the database, contract, code and tests all agree on the six keys and 13 values above.
The brief's "stack notes" and "v1 decision" about MX are the one source that cannot be compared,
because they are not in this repo.
