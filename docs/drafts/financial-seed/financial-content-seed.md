# Financial content seed — draft for review

Data only. Applies to the **financial project only** (like migration 075). Not a schema
migration; the backend seat writes the SQL against the real `prompts` / `prompt_blocks` /
`topics` / `tracks` / `screen_help` columns.

---

## 1. Register and voice

The reader is an adult consumer who linked their bank accounts to a budgeting app and
has not come back in three weeks. They are not a student, not an employee in a benefits
program, and not in crisis. They are mildly embarrassed about money and allergic to
being lectured.

**Voice rules**
- Second person, present tense. "You have three cards" not "consumers often hold".
- Concrete over abstract, but never name an amount: point at the number generically ("your balance", "the figure in that alert"). The tone block (§2) wins.
- No moralising. Never "you should have", "unfortunately", "sadly".
- No jargon without a plain-English gloss on first use (APR, utilization, avalanche).
- No product recommendations, no specific institutions, no rates, no returns.
- One idea per card. Two minutes total per lesson.
- End on a single concrete action the reader can take today.

**Anti-patterns to name explicitly in the tone block**
- Cheerleading ("You've got this!")
- Scolding or implied failure
- Hypotheticals about people who aren't the reader ("imagine a couple who…")
- Numbers the system can't know ("your $4,200 balance")

---

## 2. Tone block (`prompt_blocks`, `block_type = 'tone'`)

Suggested name: **Plain Money**

> Write as a calm, competent friend who happens to know money well. Address the reader
> directly as "you". Use short sentences and ordinary words. Explain any financial term
> the first time it appears, in a half-sentence, without breaking stride.
>
> Assume the reader is an adult managing real money, not a beginner to be protected and
> not an expert to be impressed. Never imply they have made a mistake, and never praise
> them for reading. State what is true, why it matters to them, and what they can do.
>
> Do not name financial products, institutions, interest rates, or investment returns.
> Do not state dollar amounts or balances — you do not know them. Refer to the reader's
> own numbers generically ("your balance", "the card with the highest rate").
>
> Each card makes one point and can be read in twenty seconds. The final card is a
> single concrete action, phrased as something to do, not something to consider.

---

## 3. Lesson-generation prompt (`prompts`, `prompt_type = 'lesson'`)

The Moosii row is parenting-shaped: developmental window, child age bands,
`band_rationale` as a developmental justification. The financial row keeps the same
output contract (the code depends on it) with the domain swapped.

**Changes from the Moosii row**
- TRACK section: no developmental window. Track name and description only.
- `min_child_age` / `max_child_age`: emit `null`. (See decision D-C1 below.)
- `band_rationale` becomes a **relevance rationale**: one sentence on which reader this
  lesson is for — the fact or intent that makes it land.
- `safety_sensitive = true` when the lesson touches: debt consolidation, credit repair
  or credit-building services, bankruptcy, tax treatment, retirement withdrawal rules,
  anything that could read as individualised advice, or anything naming a product
  category the reader could buy. This is the compliance-review trigger.
- `coverage_rationale` unchanged in spirit: why this topic is distinct from the others.
- AVAILABLE TOPICS injected verbatim, as today.

**Add to the system message**
> You are writing consumer financial education for a personal-finance app. Content is
> general education, never individualised advice. Never recommend a specific product,
> institution, or course of action that depends on facts you do not have. Where a
> decision depends on the reader's circumstances, say what the trade-off is and who to
> ask, rather than choosing for them.

---

## 4. Topics (`topics`)

Injected verbatim into the lesson prompt; the model must resolve to these names.

| Topic |
|---|
| credit |
| debt |
| spending |
| saving |
| income |
| accounts |
| planning |
| money mindset |

---

## 5. Tracks (`tracks`)

Six tracks. `track_type` values from the domain registry: `core`, `credit`, `spending`,
`saving`, `debt`, `income`.

| Track | type | weight | Description (for the generator) |
|---|---|---|---|
| **Getting Oriented** | core | 100 | For someone who has just linked their accounts. What the app can now see, how to read a spending summary, and how to pick one thing to work on first. Assumes no prior financial education. |
| **Credit Health** | credit | 90 | How credit utilization works, why the 30% guideline exists, what moves a score and what doesn't, and the difference between a limit and a balance. Practical, not aspirational. |
| **Subscription Audit** | spending | 80 | Finding recurring charges the reader has forgotten, deciding what to keep, cancelling without friction, and the annual-vs-monthly trap. Short and immediately actionable. |
| **Building a Buffer** | saving | 90 | Why one month of expenses comes before anything else, how to automate a transfer, where to keep it so it stays available, and what counts as an emergency. |
| **Paycheck Setup** | income | 70 | What direct deposit changes about timing and fees, and how splitting a deposit across accounts makes saving automatic. Two lessons only. |
| **Debt Payoff Plan** | debt | 95 | Choosing between highest-rate-first and smallest-balance-first, why minimums alone stall, what consolidation does and doesn't change, and making the first extra payment. |

Suggested `max_lessons` cap per track when generating: 4 for Credit/Buffer/Debt,
3 for Oriented/Subscriptions, 2 for Paycheck. Coverage-driven, so these are caps.

---

## 6. Fact → track rules (`fact_track_rules`)

Vocabulary already seeded by 075.

| fact_key | value | grants track |
|---|---|---|
| `credit_utilization_band` | high | Credit Health |
| `credit_utilization_band` | moderate | Credit Health |
| `new_subscription_recent` | true | Subscription Audit |
| `has_emergency_buffer` | false | Building a Buffer |
| `has_direct_deposit` | false | Paycheck Setup |
| `wants_debt_payoff_plan` | true | Debt Payoff Plan |
| `saving_for_home` | true | Building a Buffer |

Getting Oriented is a default track (`new_user_tracks`), not fact-granted.

---

## 7. Fact → entry map (`fact_entry_map`)

Set after lessons exist — each row points at one lesson or segment. Planned targets:

| fact_key | value | opens |
|---|---|---|
| `credit_utilization_band` | high | the "why 30%" lesson in Credit Health |
| `new_subscription_recent` | true | the "finding forgotten subscriptions" lesson |
| `has_emergency_buffer` | false | the "why one month first" lesson |
| `has_direct_deposit` | false | the "why direct deposit matters" lesson |

---

## 8. Onboarding questionnaire (Q-Onboard)

Four questions. Each answer writes an intent fact the platform can't observe.

1. **What would you most like to get on top of?** — paying down debt / building savings /
   understanding my credit / getting a clearer picture of spending
   → `wants_debt_payoff_plan = true` when the first is chosen
2. **Are you saving toward something specific in the next couple of years?** — a home /
   something else / not right now → `saving_for_home = true` on the first
3. **How would you describe your comfort with money topics?** — confident / okay /
   I'd rather not think about it → tone/pacing signal, no track
4. **How often do you want to hear from us?** — weekly / occasionally / only when
   something changes → cadence preference for the email job

---

## 9. Screen help (`screen_help`)

Per-deployment already. The financial rows differ from Moosii wherever the Moosii text
says child, parent, clinical, or milestone. Lowest priority — write these once the CMS
screens are being used.

---

## Decisions for Mark

- **D-C1 — age fields.** `generate_lessons` requires `min_child_age` / `max_child_age`.
  Proposal: pass `0` and `1200` for financial tracks so the gate is always open, and have
  the generated lessons carry `null`. Alternative: make the fields optional in the
  contract (a backend change touching the Moosii path too). Recommend the former for now.
- **D-C2 — safety-sensitive list.** Confirm the trigger list in §3. Anything on it routes
  to compliance review, which is the governance beat in the demo.
- **D-C3 — second reviewer.** Until the partner's compliance person exists, you hold both
  capability flags on the financial project. Fine for a demo; must be stated in the pitch.
- **D-C4 — tone name.** "Plain Money", or your preference. It becomes the tone display
  name in the CMS.
