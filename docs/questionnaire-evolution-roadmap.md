# Questionnaire System — Evolution Roadmap

Status: planning only. Nothing here is built. Captured from a design
conversation so it isn't reconstructed from chat history later. Written while
the immediate priority is **populating lessons and questionnaires with real
content** — every layer below is best designed against a real catalog and real
usage data, so content-first is correct.

---

## Where the questionnaire system is today

- A questionnaire = a set of scored questions. Each answer has a value; values
  sum to a total score.
- The only output is **track routing**: score-in-range → add/remove track
  (via `questionnaire_response` rules, read through
  `questionnaire_response_with_track_tag`).
- A questionnaire is taken **once** per user (latest-only; one response set).
- An `age` gate column exists (being standardized to **months**, matching
  lessons — not weeks; child age is only month-granular because `children`
  stores `birth_year`/`birth_month`, no day, a deliberate privacy choice).
- Optional CMS organization: a `category` tag (Sleep / Feeding / Development /
  Mood) for authoring a large flat list. Cosmetic only; feeds later pacing.
- No `type` field (check-in vs assessment): scoring is uniform, so a one-question
  check-in and a multi-question assessment are the SAME object at different
  sizes. Question count is the only difference and it's self-evident.

---

## The guiding principle

Build the **general mechanism** when it's about the same cost as the specific
one and cleaner; refuse speculative scaffolding. Every layer below is a general
questionnaire capability that is useful for ordinary content on its own — the
clinical/screening case is then just a *configuration* of proven general parts,
not a bespoke build. This keeps the highest-stakes work (clinical screening)
assembled from mechanisms already trusted on low-stakes content.

A second axis runs through the whole roadmap and dictates the order:

> **Determinism decreases and stakes increase as you go up the layers.**
> Build the deterministic, low-stakes layers first. Prove each before the next.

---

## Layer 1 — Recurrence (questionnaires can repeat)

**What:** a questionnaire can be configured to repeat on a child-age cadence
(e.g. at 1, 2, 4, 6 months) rather than firing once. The system tracks how many
times a user has taken it and when it's next due, and re-surfaces it in the MLP
even though the user already completed it.

**Why it's first:** it's fully deterministic, and it's the foundation the
clinical cadence question is actually blocked on — there's no point deciding
"how often should the EPDS run" until the system can run anything more than
once. Also useful immediately for ordinary content (a recurring "how's sleep?"
check-in).

**The load-bearing design decision — make it FIRST, before building on it:**
recurrence changes the data model from *one answer per user per questionnaire*
to *a time series of answers over time*. You stop having "their answer" and
start having "their answers, with history." This matters because:
- trajectory is the point (a series of EPDS scores over months tells you more
  than the latest one);
- the rebuild's "have they done this?" logic must become "are they due?";
- the inspector should show history, not just current.
Retrofitting time-series onto a latest-only model after building on it is
painful. Decide the storage shape up front.

**Status:** general feature, build first, prove on non-clinical content.

---

## Layer 2 — Chaining (a questionnaire triggers another questionnaire)

**What:** add a new result/output type. Today: score → track. Add: score →
trigger another questionnaire. A short screen flags concern → a fuller
follow-up instrument is surfaced.

**Why second:** still deterministic (it's a rule: this result triggers that
questionnaire). Useful for ordinary content — e.g. a "how's sleep going?"
check-in whose rough result triggers a fuller sleep-assessment questionnaire,
pure content, no stakes.

**Build note:** this is a `score → questionnaire` edge alongside the existing
`score → track` edge in the response-rule system. Prove on a low-stakes content
chain before the clinical case uses it.

**Status:** general feature, build second, prove on content.

---

## Layer 3 — Free-form intake → classification → enrich / suppress

**What:** a general "how's it going?" prose intake. The parent types free text;
an LLM classifies it; the classification can (a) ENRICH routing (surface
relevant content/tracks) and (b) SUPPRESS a scheduled questionnaire when the
prose already answered what it would have asked.

**Connection to existing design:** this is the user-update-system idea
resurfacing — the append-only `user_update_events` log with free-form prose
intake and constrained LLM classification — now connected to the questionnaire
system. Some prior thinking exists.

**Why last:** this is the only **probabilistic** layer. "Repeat on a cadence"
and "score X triggers Y" do exactly what they say every time; "interpret prose
and decide it satisfies a questionnaire" is an inference, and inference can be
wrong. It's the most complex and least deterministic capability here, so it
comes after the deterministic layers are proven.

### The hard safety rule for this layer

**Inference may ADD signal but must NEVER SUPPRESS a clinical/safety screen.**

- Enriching from prose is fine ("sleep seems to be a theme → surface sleep
  content").
- Suppressing **low-stakes** content is fine ("they said sleep's fine → skip the
  optional sleep check-in").
- Suppressing a **safety screen** is NOT fine. Example failure: parent writes
  something the LLM reads as "fine" but a human would catch as concerning, and
  the system suppresses the EPDS on that basis — an inference error turning off
  the exact screen that matters most, silently (suppression means nothing
  surfaces).

**Therefore:** the model needs a structural property distinguishing
**suppressible** questionnaires from **never-suppressible** ones. Clinical
screens are never-suppressible. This must be a HARD STRUCTURAL RULE, not a
per-instance config toggle someone could set wrong — a misconfiguration must not
be able to let prose turn off a safety screen. Build this distinction in from
the start of Layer 3.

**Status:** general feature, build last, prove hard on content, never let it
near clinical suppression.

---

## Layer 4 — Clinical screening configuration (PARKED — owned by experts)

**Boundary:** the software owner ("the software guy") builds Layers 1–3 (the
general mechanisms). The clinical *configuration* of them — and the safety
design — is owned by Michelle + the clinical experts. This boundary is
deliberate and should hold.

Once Layers 1–3 exist and are trusted, a clinical screen like the **EPDS**
becomes an assembly of proven parts:
- a **recurring** questionnaire (Layer 1) on a clinically-decided cadence;
- whose concerning result **chains** (Layer 2) to a fuller assessment;
- which is **never inference-suppressible** (Layer 3 hard rule);
- plus the **response/intervention protocol** — what the app does when a screen
  is positive — which is the genuinely safety-critical piece and is entirely
  the experts' design, not a routing rule.

### EPDS reference facts (for the eventual handoff to the experts)

- **Standard instrument:** Edinburgh Postnatal Depression Scale (EPDS), 10
  items, each scored 0–3, summed to 0–30. Self-report over the past 7 days.
  Screening tool, **not diagnostic**.
- **Reproducible with attribution:** may be reproduced without further
  permission provided authors/title/source are cited. Cite: Cox, J.L., Holden,
  J.M., & Sagovsky, R. (1987), "Detection of postnatal depression: Development
  of the 10-item Edinburgh Postnatal Depression Scale," British Journal of
  Psychiatry 150:782–786. Do NOT reword items (rewording breaks validation).
- **Scoring wrinkle:** some items are **reverse-scored** (top response = 3,
  bottom = 0). The per-answer-value model handles this if whoever enters values
  knows which items invert.
- **Thresholds vary (a clinical decision, not a software pick):** original
  literature uses ≥10 as a positive screen; some use ≥12 or ≥13. "Know your
  local best practices."
- **Item 10 is special (safety-critical):** it asks about self-harm directly.
  Any endorsement requires immediate attention **regardless of total score** —
  i.e. the intervention output is NOT purely "total ≥ threshold"; it is
  "total ≥ threshold OR item-10 positive → immediate path." Build the output to
  support an item-level trigger, not just a total.
- **Score must not override clinical judgment;** a positive screen requires
  clinical assessment / referral.

### Cadence (reference for the experts; NOT a software default)

Published recommendations differ and all assume a **clinician** administers and
follows up — which an app does not have, so the app cadence is a deliberate
clinical+ethical decision, NOT "as often as the software can," and NOT a blind
copy of the clinical schedule:
- **ACOG:** at least twice in pregnancy + at a postpartum visit.
- **AAP:** at the infant's 1-, 2-, 4-, and 6-month well-child visits (the most
  concrete postpartum cadence; natural reference point).
- **APA:** ~six screens across the perinatal period, two in pregnancy.
- Many experts: screen around 4–6 weeks postpartum (symptom onset + typical
  6-week visit).

**Coupling rule:** cadence and response pathway are designed TOGETHER. Screening
frequently with a weak/absent response path is arguably worse than screening
rarely. The "what happens at each positive screen, with no clinician in the
loop" question gates the "how often" question — design the response first.

**What the software can do now to be ready:** make screen timing
**configurable** (driven by child age in months, which already exists) so
whatever cadence the experts choose can be set without code changes.

**Status:** parked. Do not build until Layers 1–3 exist AND the experts deliver
the cadence + thresholds + response/intervention protocol (esp. the item-10
path).

---

## Build order summary

1. **Recurrence** (deterministic; decide time-series storage shape first).
2. **Chaining** — score → questionnaire (deterministic).
3. **Free-form intake → classify → enrich/suppress** (probabilistic; build the
   suppressible vs never-suppressible structural distinction from the start).
4. **Clinical config** (parked; experts own cadence, thresholds, and the
   response protocol; clinical screens are structurally never-suppressible).

Determinism decreases ↓, stakes increase ↑ as the list goes down. Build bottom-up.

## Hard rules to carry forward

- Clinical screens are **structurally never inference-suppressible** (not a
  toggle).
- Intervention output supports an **item-level trigger** (EPDS item 10), not
  only a total-score threshold.
- Cadence is designed **with** the response protocol, never before it.
- The software/clinical **boundary** holds: general mechanisms = software owner;
  clinical configuration + safety/response design = clinical experts.
- Do not reword validated instruments.

## Adjacent, already-tracked

- `birth_month = 0` bug in `user_mlp_data` (0-indexed months vs Postgres
  1-indexed; ~30% of children) — live, breaks age computation, fix before
  leaning on age gates for testing. Independent of all the above.
- Questionnaire pacing/spacing (throttle the eligible set: cap-concurrent /
  min-gap / drip-by-enrollment) — deferred until real content volume exists to
  design against. Layer 1 (recurrence) and the `category` tag both feed it.
