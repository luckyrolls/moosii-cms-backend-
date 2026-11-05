# FINDINGS — one-page partner integration (2026-11-04)

Investigate-only. No code changed, nothing committed, no MX call made, nothing written to either
database. Sources: `docs/api-contract.md` §8/§9, `src/facts/**`, `FINDINGS-fact-derivation.md`,
`FINDINGS-mx-sandbox.md`, moosii-reader (read-only: `src/routes/PlanWidget.tsx`,
`src/config/insights.ts`, `src/lib/paths.ts`), and MX's public docs re-fetched today (v20260929).

**Verdict:** the three steps are the right shape and step 1 is nearly free, but **step 2 is the whole
project** — it needs a partner identity (per-partner key, member→user mapping, user provisioning) that
does not exist in any form today, and one decision (D2, "no `external_user_id`") has to be reversed.
Step 3 is mostly packaging work we control. Two things in "we absorb" don't fit as stated: the daily
push at scale, and who creates a user for a member who never opens the widget.

---

## 1. What exists vs. missing, per step

### Step 1 — iframe + route "Learn more" to our widget link · **SMALL**

| | |
|---|---|
| **Exists** | `/widget/plan` fills any frame 360–900px (`PlanWidget.tsx`); embed mode `?embed=1` carries through lesson→quiz (`paths.ts`); partner entry `/learn?insight=<key>` with a 5-key partner-facing vocabulary resolved to a lesson (`config/insights.ts`: `CreditUtilization`, `CreditCardCloseToLimit`, `SubscriptionDetected`, `GettingOriented`, `SaveEnoughToLiveOn`, plus the `app_visibility` alias). A mock partner page already frames it (`/demo/partner`). |
| **Missing** | **No framing allowlist of any kind.** No `Content-Security-Policy: frame-ancestors`, no `X-Frame-Options`, no header config at all in moosii-reader (no `render.yaml`, no `public/_headers`) — anyone can frame the reader today. Per-partner allowlist = reader-seat work (see §4.4). |
| **Missing** | 2 of the 5 insight keys still point at the demo lesson (`SubscriptionDetected`, `GettingOriented`) — fine for a pilot, but the partner's engineer will see the same lesson twice. |
| **Watch** | MX's own widgets give **no settable URL** for "Learn more": the CTA fires an event (`postMessage`, or an `mx://…` URL in a WebView) carrying `beat_template` / `beat_guid` / `user_guid` (`FINDINGS-mx-sandbox.md` §TL;DR 2 and §4). So the partner reads `beat_template` from that event and builds our link — which is exactly step 1, and it is work *they* must write, not configuration. If instead they read insights from the Platform API, the field is `template`. Same vocabulary either way. |

### Step 2 — one server call for a single-use widget link, keyed by THEIR member id · **LARGE**

Nothing of this exists. It is four pieces:

| Piece | State | Size |
|---|---|---|
| Per-partner key (replacing the single `FACTS_API_KEY`) | missing; today one shared secret, no partner table, no migration mentions partners | medium |
| `partner_member_id → our user_id` mapping | missing, and **currently forbidden**: `POST /facts` rejects `external_user_id` outright (`validate.ts`, decision D2) and requires a Supabase auth uid | medium |
| Provisioning a user for a member who has never opened the widget | missing, and blocking for the holdout — see §5 | medium |
| The link endpoint + the reader accepting it | missing; the mechanism exists as a precedent (`POST /demo/session` mints a real Supabase session with `auth.admin.generateLink` → `verifyOtp` on a throwaway client, §9) | medium |

The reader today shows **"Sign in to see your plan."** to an unauthenticated frame. A partner frame has
no session, so the link must carry one — that is the single-use token's whole job.

### Step 3 — the connector · **MEDIUM**

| | |
|---|---|
| **Exists** | The complete read path, already working against MX: `MxProvider` (members / accounts / transactions, paging, error taxonomy) and `rules.ts` (pure, 234 lines, zero imports). `deriveFactsForUser` orchestrates gates + write. Verified against MX's sandbox (`FINDINGS-fact-derivation.md`). |
| **Missing** | The rules as a shipped package (§2); the container itself; a push path that takes a partner member id (§4.2); `rule_version` in the payload. |
| **Does not transfer** | `deriveFactsForUser` resolves identity by assuming **the MX user id IS our Supabase uid** ("so no mapping table", `mxProvider.ts` header). On the partner's MX account that is false — their member ids are theirs. The connector keeps the fetch + derive and replaces identity and the write call. |

---

## 2. Extracting `facts-derive/2` into one package

**Yes — `rules.ts` is already the package.** It is pure by design and by its own header comment: no
network, no DB, no env, and **zero imports**. Nothing in it needs changing to publish it.

**What moves**
- `src/facts/derive/rules.ts` → the package's `index.ts`, unchanged: `deriveAll`, the four `derive*`
  functions, `isDirectDeposit`, `historyDays`, `RULE_VERSION`, every threshold constant, and the
  `MxAccount` / `MxTransaction` / `FactResult` types (which are also the package's input contract).
- Tests: `rules.test.ts` (fixtures, imports `../rules` only) and `rules.v2-identity.test.ts` +
  `rules.v1.frozen.ts` (the frozen `/1` copy).

**What stays in the backend:** `derive.ts` (gates, `observed_at`, the write), `mxProvider.ts` (HTTP),
`service.ts` / `validate.ts` / `db.ts` (DB + vocabulary). The backend then imports the package instead
of a local file — a one-line import change at `derive.ts:3`.

**The identity tests come along, with one snag.** `rules.v2-identity.test.ts` imports `rng` from
`../../../demo/sarahData` — the only outside dependency in the whole derive tree. Copy that
deterministic PRNG into the package's test helpers (a few lines); then the 200-seed × 3-shape identity
proof runs inside the package, which is where it belongs: it is the guarantee that the partner's copy
and ours rank identically. Both test files use `node:test` + `node:assert`, so the package needs no
test framework. The repo's `test` script lists files explicitly, so the moved files leave it and the
package gets its own `npm test`.

**Mechanics:** the repo is plain `tsc`, CommonJS, no workspaces. Options, cheapest first: (a) a
`packages/facts-rules` folder + npm workspace — one copy, both consumers build from source, no
registry; (b) a private npm package (needs a registry and a release step); (c) a git submodule
(worst: two checkouts drift). **Recommend (a)** with the connector built from the same repo, so
"ONE copy" is enforced by the filesystem rather than by discipline. Size: **small** for the move
itself, **small–medium** including the workspace plumbing.

**Keep `RULE_VERSION` in the package**, exported, and have the connector put it in every push: the
version and the rules then cannot disagree.

---

## 3. MX: exactly what the connector needs

Verified against the live client we already ship (`mxProvider.ts`) plus MX docs re-fetched today.

**Auth / base:** HTTP Basic, `Authorization: Basic base64(client_id:api_key)`; `https://api.mx.com`
(production) or `https://int-api.mx.com` (integration). Partner's own credentials, never ours.

**Version:** we send `Accept-Version: v20250224` with `Accept: application/json`. Current is
**`v20260929`**; `v20250224` is still supported (MX supports a version ≥18 months, plus 12 after
deprecation). Legacy `Accept: application/vnd.mx.api.v1+json` maps to `v20111101`. A missing or bad
version is **406**. → **The connector must pin its version explicitly** and we re-test before moving it.

**Endpoints (3 calls per member per run):**

| Call | Path | Params |
|---|---|---|
| members | `GET /users/{user_id}/members` | `page`, `records_per_page` (we use 100) |
| accounts | `GET /users/{user_id}/accounts` | same |
| transactions | `GET /users/{user_id}/transactions` | `from_date`, `page`, `records_per_page` |

**`from_date` trap (ours, measured):** the v20250224 spec documents `YYYY-MM-DD`, but the live API
rejected it with `400 "From date is not a valid integer"` and accepts **UNIX epoch seconds**
(`mxProvider.ts:getTransactions`, sandbox 2026-09-28). Without it MX returns only ~90 days. Re-verify
this per pinned version — it is the single most likely thing to break on a version bump.

**Fields the rules actually read** (nothing else is needed, so nothing else should be fetched):
- *members:* `guid`, `is_being_aggregated`, `successfully_aggregated_at` (also the idempotency key).
- *accounts:* `guid`, `type` (`CHECKING`/`SAVINGS`/`CREDIT_CARD`), `is_closed`, `balance`,
  `available_balance`, `credit_limit`, `available_credit`, `is_manual`.
- *transactions:* `guid`, `account_guid`, `type` (`CREDIT`/`DEBIT`), `status`, `amount`,
  `transacted_at` ‖ `posted_at` ‖ `date`, `is_direct_deposit`, `is_subscription`, `merchant_guid`,
  `description`, `top_level_category`, `category`, `is_manual`.

**Per fact:** `has_direct_deposit` → deposit accounts + `is_direct_deposit` CREDITs, ≥60 days history;
`has_emergency_buffer` → balances + non-Transfer DEBITs over 90 days, ≥60 days history;
`new_subscription_recent` → `is_subscription` DEBITs + merchant, **≥90 days history**;
`credit_utilization_band` → card `balance` + `credit_limit` (or `balance + available_credit`,
flagged estimated). History below the gate yields "unknown" and writes no row — correct, but it means
a thin-history member produces nothing, which the partner should expect rather than report as a bug.

**Rate limits** are per MX client: GET 2,000/s production, 300/s integration — the partner's quota,
not ours, and nowhere near binding at 3 calls per member. Integration caps at 100 users and 25
members per user, so a pilot in integration can't cover a real population.

**What breaks on a different MX setup**
- **Platform API (what we assume):** everything above works.
- **Nexus API / SSO API:** MX's own glossary says each **"isn't available for new integrations"** —
  legacy. Whether an SSO-only client can reach the data endpoints is **not documented publicly**;
  treat as unknown and confirm with MX or the partner. If they genuinely have no Platform API access,
  the connector cannot read anything and the model collapses to "partner computes facts themselves
  from their own warehouse" — a different integration.
- **Data Exchange:** different paths (`/data_exchange/users/{id}/transactions`) and a required
  `MX-3DX-TOKEN`, and its transactions default to **90 days**. A 90-day cap starves
  `new_subscription_recent` (it needs ≥90 days *of history* to judge "new"), so that fact would be
  permanently unknown. Our fetch window is 120 days (`HISTORY_FETCH_DAYS`).
- **Connect Widget only** (no API): no data access at all.
- **Insights entitlement is separate and our own key does NOT have it** — `GET /users/{guid}/insights`
  returned 403 "Client does not have access to Pulse features" (`FINDINGS-mx-sandbox.md` §4.4). Step 1
  depends on the **partner's** insights being live, not ours. Worth confirming before the pilot, since
  step 1 is their half of the value.

---

## 4. Partner auth, mapping, the link endpoint, framing

### 4.1 Per-partner key — **medium**
Today: one `FACTS_API_KEY`, required at boot on financial, ≥32 chars, distinct from
`INTERNAL_API_KEY`, constant-time compared, logged as a 6-char fingerprint (`auth.ts`, `config.ts`).
Minimum change: a `partners` table (`id`, `name`, `key_sha256`, `is_active`, `created_at`) and look the
key up by hash, keeping constant-time compare and the fingerprint log. Then `POST /facts` knows WHICH
partner is calling — required for mapping (§4.2) and for scoping a link to one partner's members.
Keep `FACTS_API_KEY` working as "partner 0" so the pilot doesn't need a flag day.

### 4.2 Member mapping — **medium, and it reverses decision D2**
`POST /facts` today **refuses** `external_user_id` with an explicit error, by decision D2, and requires
our Supabase uid. The whole point of step 2 is that the partner uses **their** member id, so:
- new table `partner_members (partner_id, partner_member_id, user_id, created_at)`, unique on
  `(partner_id, partner_member_id)`, `user_id` FK `auth.users`;
- `POST /facts` accepts **either** `user_id` (unchanged) **or** `{ partner_member_id }`, resolved
  through the calling partner's rows — never a raw id from the body trusted as ours;
- the same resolution serves the link endpoint, so one mapping covers both steps.

Note the partner member id is **their identifier for a person**: it belongs in the mapping table only,
never in a log line or an error message, same discipline as the keys.

### 4.3 The widget-link endpoint — **medium**
Shape, mirroring MX's `widget_urls` so it reads as something they've done before:

```
POST /partner/widget-url            Authorization: Bearer <partner key>
Body: { partner_member_id: string, insight?: string }
→ 200 { url, single_use: true, expires_in_seconds: 600 }
```
- **Lifetime / single use:** copy MX exactly — **ten minutes or first use**, whichever comes first.
  That needs a token table (`token_sha256`, `user_id`, `expires_at`, `used_at`) and a redeem step; a
  stateless signed token cannot be single-use.
- **Redeem:** the reader opens `url`, posts the token once, gets a real Supabase session — the
  `POST /demo/session` mechanism (`generateLink` → `verifyOtp` on a throwaway client) with the access
  code replaced by the token. That route is the proof this works; reuse it rather than invent.
- `insight` passes straight through to `/learn?insight=…`, so step 1 and step 2 compose.
- Never log the URL or the token (the demo widget-url route already sets that precedent).
- **Cross-origin session survival — TESTED 2026-11-04, and it holds.** This was written as the open
  risk: a session stored in a third-party frame lives in partitioned storage, and Safari was expected
  to refuse it outright. The moosii-reader seat tested it on 2026-11-04 (iPhone Safari, our reader
  framed from a cross-site LAN host) and **the session survived a reload of the host page**. So
  **step 2 does NOT need a fresh link on every page load**, and "one server call per member" stands as
  written. (A link is still single-use and ten minutes, so a page that has no session yet must fetch
  one; the point is that a page that already has one does not.) Remaining unknown: the other
  browser/OS combinations in that brief, and whether a partitioned session survives longer than a
  reload (ITP eviction over days). Neither changes the guide.

### 4.4 Framing allowlist (F54) — **small, reader seat**
I could not find **F54** anywhere in this repo or in moosii-reader, so I'm treating it as your own
follow-up number for "serve a per-partner `frame-ancestors`". State today: **no CSP and no
`X-Frame-Options` anywhere** — the reader is framable by anyone. What it needs: a
`Content-Security-Policy: frame-ancestors https://partner.example …` served on the reader's responses,
from one list; `ALLOWED_ORIGINS` on the financial service already covers the CORS half for the
partner's server→our-API calls. Per-partner means the list is data, not a build constant, if more than
one partner is ever live at once.

---

## 5. Holdout without partner work

They enroll everyone and the connector pushes facts for every member daily, so **we hold the facts for
the holdout and simply never show them a plan**. Nothing is asked of the partner.

Mechanics that work with what exists: add `holdout boolean` to `partner_members`, assigned once at
first sight by a deterministic hash of `(partner_id, partner_member_id)` so it is stable, reproducible
and needs no stored randomness. Facts still land (so fact movement is measurable — which is the thing
being compared); the link endpoint refuses a holdout member, or returns a link that shows the
not-available page. Size: **small**, once §4.2 exists.

**But holdout forces the provisioning question.** Facts cannot be written for a member who has no auth
user: `user_facts.user_id` is an FK to `auth.users` (076) and `POST /facts` answers **404
`unknown_user`**. A holdout member never opens the widget, so nothing would ever create their user.
So either:
- **we create an auth user on first push** for every enrolled member (the mapping row's `user_id`),
  meaning we hold a row per partner member who may never use us — with no email, since we won't have
  one; or
- **we don't store facts for the holdout** and compare something else, which weakens the measurement.

The first is the one that matches "they enroll everyone"; it needs your call, because it means
creating accounts for people who have not signed up for anything. `user.email` is unique but nullable
(079), so emailless users are structurally fine. **Decision for Mark (§7, D4).**

---

## 6. What does not fit the three steps — plainly

1. **The daily batch does not fit `POST /facts` as it stands.** It is **one user per call**
   (max 100 facts, scope stated explicitly in §8b), and **every call enqueues a `rebuild_mlp` job —
   even when `written = 0`**, by deliberate design. A daily push for N enrolled members is therefore N
   HTTP calls and **N rebuild jobs per day**, in-process on one warm Render instance, mostly for
   members whose facts did not change. At pilot scale (hundreds) it is merely wasteful; at thousands it
   is the bottleneck of the whole integration. Fixes, cheapest first: have the connector **push only
   changed facts** (it can, since `observed_at` makes redelivery detectable on its side); **skip the
   rebuild enqueue when `written = 0`**; or add a multi-member batch endpoint. The first two are small
   and together probably enough. **This is the one thing I'd fix before a pilot.**
2. **"MX creds stay on their side" is true only if the connector runs on their infrastructure.** Then
   *they* deploy, monitor and restart a container of ours — which is more than "three settings" in
   practice (logs, alerting, a runbook, and a version bump when rules change). If instead we run it,
   we hold their MX credentials, which contradicts the premise. Worth saying out loud in the pitch.
3. **Rule version acceptance** ("pushes carry the version; we accept recent ones") needs a field that
   does not exist: `POST /facts` has no `rule_version` anywhere. Additive and **small** — but it also
   needs a **source value** decision: the route accepts only `platform_api | cms | manual`, and
   `derived` / `estimated` are internal-only *precisely so a partner cannot claim a fact is ours*
   (§8c). A partner running our rules on real MX data is neither. **Recommend a new value
   `partner_derived`** (migration + allow it on the route), so the provenance stays honest and
   `GET /facts` can tell the three apart.
4. **Step 1 depends on the partner's MX insights being enabled** — a Pulse entitlement our own key
   lacks. If theirs is off, step 1 has nothing to route and the pilot is plan-widget-only.
5. **MX gives no "Learn more" URL**, so step 1 is a small piece of code they write against a widget
   event, not a setting. The guide must show that code or the step will look mis-described.

---

## 7. Decisions for Mark

**Decided by Mark 2026-11-05. Still nothing built — no migration, no route, no package, no
connector; each accepted call lands when the step it belongs to is built.**

| # | Decision | Recommendation | Mark's call (2026-11-05) |
|---|---|---|---|
| D1 | Reverse D2: accept `partner_member_id` on `POST /facts` (resolved per partner), keep `user_id` working | yes — step 2 is impossible otherwise | **accepted**, for step 2 |
| D2 | Per-partner keys: `partners` table + hash lookup, `FACTS_API_KEY` grandfathered as partner 0 | yes | **accepted**, for step 2 |
| D3 | New fact source `partner_derived` + a `rule_version` field on the push | yes; keeps `derived` ours | **accepted**, for step 3 |
| D4 | **Do we create an auth user for every enrolled member, including holdouts who never visit?** | needed for the holdout as described; your call | **No.** No accounts for members who never open the widget: facts live on a partner-member record, and an account is created on first link. This needs a store that is not `user_facts` (its `user_id` FKs `auth.users`, §5) — **investigate when step 2 is built**. |
| D5 | Package layout: npm workspace in this repo (one copy on disk) vs private registry | workspace | **accepted** (workspace), for step 3 |
| D6 | Daily push: connector pushes only changes, and/or stop enqueueing a rebuild when `written = 0` | both, before any pilot | **Server-side no-op only** — skip the rebuild enqueue when `written = 0`. The connector stays **stateless**: it does not track what it pushed, so "push only changes" is out. |
| D7 | Connector language and license | TypeScript + container; license is yours to pick | **TypeScript**; license still open |
| D8 | Forms offered: container image only, or also a plain `npm start` job? | image for the pilot | **accepted** (image only for the pilot) |
| D9 | Pin `Accept-Version` (`v20250224` today, `v20260929` current) and re-verify the `from_date` epoch quirk per version | pin and re-verify | **accepted**, for step 3 |
| D10 | Confirm with the partner: Platform API credentials, insights/Pulse entitlement, and that they are not SSO/Nexus/Data-Exchange-only | before sizing the pilot | **accepted** — ask before sizing the pilot |

**Consequence of D6 worth noting:** with a stateless connector, the daily push is still N calls for N
enrolled members every day; the saving is N rebuild jobs, not N requests. §6.1's remaining lever, if
request volume ever bites, is a multi-member endpoint — not the connector.

---

## 8. DRAFT — the one-page partner guide

> Written for their engineer. It fits a page as long as the three steps stay as below; what would push
> it over is listed after. **This describes endpoints that do not exist yet** — it is the target.
> Note the guide's order is link → frame → connector, so its "step 1" is §1's step 2 and vice versa;
> the guide is ordered the way their engineer builds it.

---

### Add Moosii to your app — three steps

Moosii turns an MX insight into a short lesson, and shows each member a small plan of what to do
next. It runs in an iframe. You keep your MX credentials and your member data.

**You will need:** your Moosii partner key (we send it), your MX Platform API credentials (they stay
with you).

#### 1. Get a link for the member — one server call

Single-use, valid ten minutes — the same contract as MX's `widget_urls`. Call it from your server,
with your own member id. Never from the browser: it needs your partner key.

```bash
curl -X POST https://api.moosii.example/partner/widget-url \
  -H "Authorization: Bearer $MOOSII_PARTNER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"partner_member_id":"your-member-id","insight":"CreditCardCloseToLimit"}'
# → {"url":"https://read.moosii.example/...","single_use":true,"expires_in_seconds":600}
```

`insight` is optional: without it the link opens the member's plan. Don't cache or log the url.

#### 2. Show it, and route "Learn more" to it

Frame the url from step 1. Any width from 360px works.

```html
<iframe id="moosii" src="<url from step 1>" title="Your plan" width="100%" height="640" style="border:0"></iframe>
```

MX delivers a **Learn more** tap as an event, not a URL, so pass the insight's template name to your
server, ask for a link with it, and point the frame at the result:

```js
window.addEventListener('message', async (e) => {
  if (e.origin !== MX_WIDGET_ORIGIN) return;
  const { type, metadata } = e.data ?? {};
  if (type !== 'mx/insights/beat/callToActionClicked') return;  // confirm the name against your MX version
  // your endpoint calls POST /partner/widget-url with the insight and returns { url }
  const { url } = await (await fetch('/moosii/link?insight=' + encodeURIComponent(metadata.beat_template))).json();
  document.getElementById('moosii').src = url;
});
```

Insight names that open a lesson of their own today: `CreditUtilization`, `CreditCardCloseToLimit`,
`SaveEnoughToLiveOn`. Anything else opens the plan. Tell us the origins you'll frame us from and we'll
allow them.

#### 3. Run the connector

One container, on your side, on a schedule (daily is the default). It reads your MX data, computes
Moosii's facts, and sends us only your member id and up to four yes/no or banded facts — never
amounts or transactions. Nothing is written to your MX account.

```
MX_CLIENT_ID / MX_API_KEY     your MX Platform API credentials (stay here)
MOOSII_PARTNER_KEY            the key we sent you
MOOSII_SCHEDULE               optional cron; default: daily 03:00 local
```

```bash
docker run --env-file moosii.env ghcr.io/moosii/connector:1
```

Per member it makes three MX GETs (`/users/{id}/members`, `/accounts`, `/transactions`). Enroll
everyone — we select the comparison group on our side, so you don't maintain one. Run it against MX
integration first; it logs a per-member summary with no amounts and no member identifiers.

During a pilot, a randomly chosen comparison group of members sees a "not available yet" page instead
of the plan — agreed with you up front, and nothing for you to configure.

**That's it.** Questions: <contact>.

---

**What would make this longer than a page** (keep it out of the guide, put it in an appendix or a call):
the MX event name differs across widget types and versions — they must check theirs; the fact
definitions and their history requirements (a member with under 90 days of data yields fewer facts);
retries and what a 409 means; and a version bump when our rules change.

**Insight vocabulary, as at 2026-11-05 (ours, not for the guide):** `SubscriptionDetected` and
`GettingOriented` still resolve to the demo lesson "What the App Can See Now"
(`moosii-reader/src/config/insights.ts`), so neither is listed above — **F63** covers repointing them
as their real lessons publish. `GettingOriented` is additionally **not an MX template** (it is ours),
so it does not belong in a list of MX insight names at all; it stays a valid `/learn?insight=` key.
