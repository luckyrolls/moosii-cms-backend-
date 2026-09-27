# FINDINGS — MX sandbox: Insights readability + "Learn more" link

2026-09-27 · Investigate-first · no code, nothing written to any database, **no MX call made** (§0).
Sources: MX public docs (raw `.md` pages via `docs.mx.com/llms.txt`) and the published OpenAPI spec
for the current Platform API version, `v20250224` (`https://docs.mx.com/openapi/platform-api/v20250224.yaml`).
Line numbers `spec:N` refer to that YAML as downloaded 2026-09-27.

## 0. Blocker: the sandbox credentials aren't in `.env`

The brief says `MX_CLIENT_ID` / `MX_API_KEY` are in `.env`. They are not. The file (last modified
2026-09-14) holds 10 keys, none MX-related (checked by name only; no value was read or printed).
moosii-reader's `.env` has no MX keys either. So the sandbox calls in Q4 and the enablement check in Q3
**were not run**, and those answers are from the docs only. §4.3 has the exact calls, ready to run as
soon as the keys are added. The dashboard check in Q3 needs a login to `dashboard.mx.com`, which I
can't do.

## TL;DR

1. **Insights are NOT widget-only.** The Platform API has `GET /users/{user_guid}/insights` and
   related endpoints. The type is the `template` field (e.g. `CreditUtilization`), with copy fields
   and flags for linked accounts, transactions and so on. Customer Analytics is not a substitute: it's
   an MX-hosted dashboard product with no per-user API.
2. **"Learn more" has no URL anywhere.** Through the API, the insight carries only the CTA *text*
   (`micro_call_to_action`, e.g. "Learn more"), and **we choose the destination** — for example a Moosii
   lesson. In MX's widgets, a CTA fires an event (a postMessage, or an `mx://…` URL inside a WebView)
   with fixed metadata (`beat_guid`, `beat_template`, `user_guid`, plus some template-specific fields),
   and our handler decides where to send the user. We can't configure a URL or add our own
   parameters to MX-provided CTAs. Custom insights (created by an MX rep) let us set CTA text and the
   postMessage string.
3. **Sandbox enablement is unknown.** The docs say to "reach out to your MX representative" to
   configure insights and notifications, and they're silent on sandbox defaults. It's decidable in one
   call once we have keys: `GET /users/{guid}/insights`.
4. **Firing an insight in sandbox is uncertain for our key fact.** `CreditUtilization` is a *weekly*
   scheduled insight (warning at ≥20% of the credit limit, alert at ≥30%), so a freshly aggregated
   `mxbank` member won't show it immediately. Event-driven templates (e.g. `SubscriptionDetected`,
   `PayrollDeposit`, `LowAccountBalance`) are likelier to appear right after aggregation. Test
   institution: `mxbank`, username `mxuser`, and any password without a special meaning gives
   `CONNECTED` (MX's published test values).
5. **Insights make a poor source for facts; core data is a good one.** Insights are *events* (they
   fire on a schedule or a transaction, become "zero state", and their absence doesn't mean "low"),
   while our facts are *current state* in bands. Core account and transaction data exposes every input
   the four bank-derived facts need (`credit_limit`, `balance`, and the transaction flags
   `is_direct_deposit` / `is_recurring` / `is_subscription`, plus `/repeating_transactions`). Whether
   those flags are populated for aggregated `mxbank` data is unverified until we have keys. Recommendation: derive facts from core data; use Insights, if we enable
   them at all, as a *trigger* and a *CTA surface* ("Learn more" → a Moosii lesson), never as the fact.

## 1. Is there a Platform API endpoint for a user's insights?

**Yes.** From the spec (`tags: insights`):

| Method + path | What | spec |
|---|---|---|
| `GET /users/{user_guid}/insights` | list a user's insights (paginated; `?includes=localization_payload` opt-in) | spec:1101 |
| `GET /users/{user_guid}/insights/{insight_guid}` | read one | spec:1244 |
| `PUT /users/{user_guid}/insights/{insight_guid}` | update `has_been_displayed`, `is_dismissed`, `cta_clicked_at` | spec:7592 |
| `GET /users/{user_guid}/accounts/{account_guid}/insights` | insights for one account | spec:786 |
| `GET /users/{user_guid}/transactions/{transaction_guid}/insights` | insights for one transaction | spec:3545 |
| `GET …/insights/{insight_guid}/{accounts,categories,merchants,transactions,scheduled_payments,repeating_transactions}` | the resources behind an insight | spec:1121–1223 |

**Insight fields** (`InsightResponse`, spec:6384): `guid` (e.g. `BET-…`), `template` (the type, e.g.
`SubscriptionPriceIncrease`), `title`, `description`, `micro_title` (≤60 chars), `micro_description`
(≤300), `micro_call_to_action` (e.g. "Learn more"), `active_at`, `created_at`, `updated_at`,
`has_been_displayed`, `is_dismissed`, `cta_clicked_at`, `has_associated_{accounts,categories,merchants,
repeating_transactions,scheduled_payments,transactions}`, `user_guid`, `user_id`, `client_guid`,
and an opt-in `localization_payload` (per-template structured values; only some templates support it).
There's **no CTA URL or deep-link field**.

Docs: [Build Your Own Insights UI](https://docs.mx.com/products/experience/insights/integration-guides/insights-api-guide)
says English only through the API; detect new insights with the
[Insights webhook](https://docs.mx.com/resources/webhooks/insights) (created, updated, deleted); then
PUT `has_been_displayed` / `is_dismissed`. Template names follow the library names in PascalCase, with
listed exceptions (e.g. "Introduce Insights" → `IntroducePulse`).

**Customer Analytics as a substitute: no.** It's dashboards (segments, deposit attrition,
spend-to-income, etc.) that MX enables after an integration kickoff. It requires Data Enhancement,
and the docs describe no per-user API
([Customer Analytics](https://docs.mx.com/products/data/customer-analytics),
[new clients](https://docs.mx.com/products/data/customer-analytics/integration-guides/new-clients)).
The nearest API there is Audiences (segment lists for campaigns), which also isn't per-user state.
It isn't needed anyway: core data covers the facts (§5).

## 2. Is the "Learn more" / CTA link configurable?

- **API (our own UI): fully ours.** The API gives the CTA label (`micro_call_to_action`); what it
  links to is our code. For a reader card, "Learn more" can open the mapped Moosii lesson. MX asks that
  we set `cta_clicked_at` via PUT so its analytics count the click.
  ([API guide — Actionable Insights](https://docs.mx.com/products/experience/insights/integration-guides/insights-api-guide))
- **Widgets: event, not URL.** In the Micro and Mini widgets, "Learn more" and "View all"/"View more"
  send an event: `{ "type": "mx/pulse/micro-carousel/cta", "metadata": { "beat_guid", "beat_template",
  "user_guid" } }`. In a mobile WebView (`is_mobile_webview: true`) the event comes as
  `window.location = "mx://pulse/micro-carousel/cta?metadata=…"`, and MX warns that not capturing it
  "can cause the app to break". MX's intended target is its own Insights Widget, requested with
  `insight_guid` so the tapped insight shows first. In the full Insights Widget, some templates' CTAs
  send an event with an `action` (`op_1`…`op_3`) plus template fields (e.g. `account_guid`,
  `goal_guid`), and we route it. The metadata is fixed by MX: we can't configure a URL or add parameters.
  ([Widget Events](https://docs.mx.com/products/experience/insights/integration-guides/widget-events),
  [Integrating Insights Widgets](https://docs.mx.com/products/experience/insights/integration-guides/integrate-insights-widget))
- **Copy is customisable, destination isn't a URL.** The library marks default copy, including the CTA
  text, as "all customizable" (through MX). **Custom insights** (via an MX rep) let us define the title,
  description, CTA button or link text, and "the string for the postMessage event that triggers when the
  user clicks the CTA" ([Create Custom Insights](https://docs.mx.com/products/experience/insights#create-custom-insights)).
  That's still an event string that we route, not a URL.

Implication: the "Learn more → Moosii lesson" idea works cleanly **only if we render insights
ourselves** (API) or handle the widget event and look up a lesson by `beat_template`. Either way the
lesson mapping is keyed on `template`, and it lives on our side.

## 3. Is Insights enabled in sandbox by default?

**Not stated in the docs.** Everything about turning insights on points to the MX rep: "Reach out to
your MX representative to create, configure, and deploy…" and, for notifications, "Reach out to your MX
representative to turn them on" ([Insights overview](https://docs.mx.com/products/experience/insights)).
Some templates depend on other products: emergency-fund insights need the Goals Widget, and spending-plan
ones need Spending Plan. The test-platform pages ([Testing the Platform API](https://docs.mx.com/resources/test-platform),
[MX Bank](https://docs.mx.com/resources/test-platform/mxbank)) don't mention insights.

**How to settle it (not done — no keys, and the dashboard needs a login):**
1. Call `GET /users/{guid}/insights` for a sandbox user. A 403 or a "not enabled" error means it's off.
   A 200 with an empty list means inconclusive until a member has aggregated and a trigger has had time
   to fire.
2. Mark, in [dashboard.mx.com](https://dashboard.mx.com): check the client's enabled products and
   webhooks (Client Dashboard). If Insights isn't listed, ask the MX rep to enable it in integration,
   and ask which templates are on by default.

## 4. Minimal steps to make an insight fire in sandbox

### 4.1 The path
1. **Create a user**: `POST /users` with `{ "user": { "id": "<our-id>" } }` (spec:505; `id` is
   partner-defined).
2. **Connect `mxbank`**: `POST /users/{user_guid}/members` with `institution_code: "mxbank"` and the
   credentials `mxuser` / any password not in MX's special list (→ `CONNECTED`, no MFA). `v20250224`
   requires a `data_request.products` array in this body
   ([Platform API overview — breaking changes](https://docs.mx.com/api-reference/platform-api/overview/)).
   `mxbank` exists only in the integration environment and has no aggregation throttle.
3. **Wait for aggregation**: poll the member's status, or subscribe to the Aggregation /
   Initial Data Ready webhooks.
4. **List accounts and transactions**: `GET /users/{user_guid}/accounts`, `…/transactions`.
5. **List insights**: `GET /users/{user_guid}/insights` (or listen for the Insights webhook).

### 4.2 What triggers the insights we care about (library, default rules)
| Template | Trigger | In sandbox |
|---|---|---|
| `CreditUtilization` | **weekly**; ≥1 credit card (max 15 accounts); warning when balance ≥20% of the total limit, alert at ≥30%; at most one per level per month. Copy includes `{threshold_amount}`; CTA "Learn more" ([Borrow](https://docs.mx.com/products/experience/insights/library/borrow)) | needs an `mxbank` card near its limit **and** a weekly run: probably not same-day |
| `CreditCardCloseToLimit` | on any account update, when a card reaches 75% (user-configurable) of its limit; copy has `{amount_remaining}` | likelier same-day, if an `mxbank` card is that full |
| `SubscriptionDetected` | posted DEBIT on a repeating transaction (`repeating_transaction_type = 1`) with a merchant, no match in the last 13 months ([Spend](https://docs.mx.com/products/experience/insights/library/spend)) | only if `mxbank` data contains recurring merchants |
| `PayrollDeposit` | a deposit classified as payroll (don't enable it together with `UnifiedDeposit`) | depends on test data |
| `LowAccountBalance` | balance under $100 (configurable), at most once per 15 days | depends on test data |
| `SaveEnoughToLiveOn` | **quarterly**; (savings + checking) ÷ 90-day average daily spend ([Save](https://docs.mx.com/products/experience/insights/library/save)) | not same-day |

We don't know what `mxbank` generates (card limits, recurring merchants, payroll), because the docs don't
describe the data. Step 4.1.4 shows it; that's the real answer to "what data triggers it".

### 4.3 Calls to run once `MX_CLIENT_ID` / `MX_API_KEY` exist (nothing prints the secrets)
```bash
set -a; . ./.env; set +a
MX=https://int-api.mx.com
H=(-u "$MX_CLIENT_ID:$MX_API_KEY" -H 'Accept: application/json' -H 'Accept-Version: v20250224' -H 'Content-Type: application/json')
curl -s "${H[@]}" "$MX/institutions?name=mx%20bank" | jq '.institutions[] | {code, name}'
curl -s "${H[@]}" -X POST "$MX/users" -d '{"user":{"id":"moosii-sandbox-probe-1"}}' | jq '.user.guid'
curl -s "${H[@]}" "$MX/users/$USER_GUID/accounts" | jq '.accounts | length'
curl -s "${H[@]}" "$MX/users/$USER_GUID/insights" -w '\nHTTP %{http_code}\n'   # the enablement probe
```
The brief authorised creating a user in MX sandbox (an MX-side write, sandbox only). Connecting an
`mxbank` member is the next step (§4.1.2). It wasn't in the brief's list of calls to run, so it needs a go.

## 5. Impact on the facts derivation assumption and the financial seed

**Where the assumption lives.** "v1 facts map to MX insight types" isn't in `FINDINGS-financial.md`.
`FINDINGS-facts-source.md` (2026-09-15) already recorded that this decision isn't written down anywhere
in this repo (§1, §4 there). Its §5 "Ask MX" questions 3, 4, 6 and 7 are now partly answered by the
docs, as below.

**Per fact:**
| Fact (075) | Nearest insight template | Why the insight is a poor source | Core-data source (spec) |
|---|---|---|---|
| `credit_utilization_band` low/moderate/high | `CreditUtilization` (warning ≥20%, alert ≥30%) | weekly, monthly de-dup, absence ≠ low (no cards / not run yet / below 20%), zero state when data changes; bands don't line up with ours unless we define low <20, moderate 20–30, high ≥30 | account `balance` + `credit_limit` (`AccountResponse`, spec:5788, 5818) → ratio → band, computed at derivation time |
| `has_direct_deposit` | `PayrollDeposit` / `SetUpDirectDeposit` (held accounts only) | events per deposit; `SetUpDirectDeposit` only for held (the client's own) accounts, not aggregated ones | transaction `is_direct_deposit` (`TransactionResponse`, spec:6795) |
| `new_subscription_recent` | `SubscriptionDetected` | the closest fit: it's literally "new subscription"; still an event with its own 13-month rule | transaction `is_subscription` / `is_recurring` (`TransactionResponse`, spec:6843, 6838) + `GET /users/{guid}/repeating_transactions` (spec:3508; `repeating_transaction_type` BILL | SUBSCRIPTION), windowed on our side |
| `has_emergency_buffer` | `SaveEnoughToLiveOn` (quarterly), emergency-fund ones (need the Goals Widget) | quarterly or needs Goals | checking + savings `balance` vs spend, as §4 of facts-source proposes |
| `wants_debt_payoff_plan`, `saving_for_home` | — | user-declared, no MX | unchanged |

**Recommendation.**
- **Facts come from core data, not insights.** Every bank-derived fact has a core source in the spec.
  It's current state, deterministic, and we can re-derive it on demand. Invariant 12 is untouched: only
  the band or boolean crosses into `user_facts`, never an amount. Insight copy contains dollar amounts
  (`{threshold_amount}`, "$36.71 more"), so **insight text must never be stored as a fact value or
  shown in a lesson prompt**.
- **Insights, if enabled, are a surface and a trigger.** Their `template` can (a) prompt a facts
  re-derivation (webhook → recompute), and (b) carry a "Learn more" that opens a Moosii lesson through
  a `template → lesson/track` map on our side. That map would be a new, small, authored table; not
  proposed here.
- **Still open, and needs keys or MX:** whether Insights is enabled for our client, which templates are
  on, what `mxbank` generates, and whether `is_direct_deposit` / `is_subscription` are populated for
  aggregated (not held) accounts in sandbox.

**`docs/drafts/financial-seed/financial-content-seed.md`.** No change is forced. Its tone block already
bans stating amounts ("Do not state dollar amounts or balances — you do not know them"), which fits
insights carrying amounts we must not echo. Two follow-ups for whoever owns that draft:
(1) §1's voice rule "Name the number the app already shows them" contradicts the tone block's
no-amounts rule. If lessons open from an insight's "Learn more", the insight on screen *will* show a
number, and the lesson should refer to it generically ("the number in that alert"). Worth one line in the
tone block. (2) If the template→lesson map happens, the seed's tracks should cover the templates we
enable. Credit utilization, subscriptions, direct deposit and emergency buffer already line up with
the four facts.

## 6. What I did not do
- No MX API call, no dashboard visit (no keys; the dashboard needs a login).
- No write to either Supabase project. No code.
- Didn't read the Nexus API docs; out of this brief's scope.
