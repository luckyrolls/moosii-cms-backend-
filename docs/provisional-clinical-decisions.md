# Provisional Clinical Decisions — Distress Path (Slice B)

**Status: PROVISIONAL. Awaiting clinical review.** The clinical owner (Michelle)
was unavailable when this slice was built (~2 week gap). To avoid blocking, the
distress detection + response path was built NOW with provisional clinical calls,
structured so her review is **config/content edits, not rebuilds**: tier
boundaries live in the DB prompt (`prompt_type='classify_update'`), response copy
lives in `distress_responses` (`is_provisional=true`), and both are editable
without code changes.

This document IS the clinical review agenda. Every clinical judgment this slice
made is an entry below: decision, date, rationale, review status. Keep it current
as tuning changes anything.

**The launch gate did not vanish — it moved.** App-facing free-text input remains
gated: no REAL PARENTS until the tiers + response content here are clinically
confirmed. Detection and provisional content being live does NOT open the gate
(§2j).

---

## ⚠️ TOP PRIORITY FOR REVIEW — safety-tier message wording (intrusive thoughts)

**Decision (2026-07-03):** The `safety` tier message reads:
> "What you wrote matters, and you deserve support right now. If you're having
> thoughts of harming yourself or your baby, or feeling that you might not want
> to be here, please reach out this moment — you can call or text someone trained
> to help, any time, for free. You are not alone, and reaching out is a strong
> thing to do."

**Why this is flagged first:** intrusive-thoughts / harm-to-baby messaging is the
**deepest clinical judgment in this slice**. The `safety` tier definition
correctly covers harm-to-the-child language (not only self-harm), so the message
must speak to both — but the exact phrasing of how you address a parent having
thoughts of harming their baby (validating vs. alarming, how it interacts with
intrusive-thoughts-of-OCD vs. genuine risk) is a clinical call, not a copywriting
one. **The current wording is a placeholder.** Michelle rules on it.

**Status:** AWAITING CLINICAL REVIEW (highest priority).

---

## Tier taxonomy

### D1 — Four tiers and their boundaries
**Decision (2026-07-03):** distress is graded into exactly `none | strain |
overwhelm | safety`.
- **none** — no distress (the overwhelming majority: milestones, weather, logistics).
- **strain** — hard-but-coping; venting, tiredness, a rough patch ("so exhausted",
  "rough week").
- **overwhelm** — not-coping, hopelessness, self-blame beyond ordinary venting
  ("I can't do this anymore", "nothing helps", "I'm failing her").
- **safety** — ANY self-harm, harm-to-child, or not-wanting-to-be-here language,
  however oblique/hedged/passive. The EPDS item-10 analog.
**Rationale:** three graded non-none tiers map to escalating response intensity;
the boundaries are the tuning surface. **Status:** AWAITING CLINICAL REVIEW.

### D2 — Conservative-upward tier assignment
**Decision (2026-07-03):** when two tiers are both plausible, the classifier picks
the HIGHER one. **Rationale:** under-tiering a distressed parent is the failure
mode; over-tiering costs only an unnecessary supportive message. **Status:**
AWAITING CLINICAL REVIEW.

### D3 — Safety-tier determinism (no weighing against positive content)
**Decision (2026-07-03):** any safety-language endorsement → tier `safety`, full
stop — NOT weighed against upbeat content elsewhere in the update (a happy
milestone in the same sentence does not lower the tier). **Rationale:** the
item-10 principle — a single safety signal governs regardless of total. **Status:**
AWAITING CLINICAL REVIEW.

### D4 — Lenient detection, no confidence floor
**Decision (2026-07-03):** distress detection runs OPPOSITE to track matching.
Track matching is strict (0.6 floor drops weak matches); distress has NO floor —
ambiguity resolves TOWARD concern, and no borderline detection is silently dropped
to none. False positives acceptable; false negatives are the failure. **Rationale:**
a missed distress is the only unacceptable error here. **Status:** AWAITING
CLINICAL REVIEW.

## Response model

### D5 — Content-only response, no human-in-the-loop
**Decision (2026-07-03):** a detected tier returns supportive copy + resources; it
does NOT notify or route to a human, and does not itself constitute an
intervention protocol. **Rationale:** the intervention/response protocol (esp. the
safety path) is genuinely safety-critical and is the clinical owner's design, not
a routing rule — parked until she designs it. This slice delivers detection +
provisional content only. **Status:** AWAITING CLINICAL REVIEW — the response
protocol is the biggest parked piece.

### D6 — Seed copy and resource choices
**Decision (2026-07-03):** provisional supportive copy for all three tiers, with:
- **strain** → Postpartum Support International (PSI) HelpLine.
- **overwhelm** → National Maternal Mental Health Hotline (NMMH) + PSI HelpLine.
- **safety** → 988 Suicide & Crisis Lifeline (call + text) + NMMH.

**Resource numbers — verified current 2026-07-03** (re-verify for staleness):
- 988 Suicide & Crisis Lifeline — call or text **988** (24/7).
- PSI HelpLine — **1-800-944-4773** (call/text; NOT a crisis line, business-hours
  callback).
- National Maternal Mental Health Hotline — **1-833-852-6262** (call/text, 24/7).

**Rationale:** best-effort supportive copy; numbers chosen for the perinatal
audience. All copy `is_provisional=true`. **Status:** AWAITING CLINICAL REVIEW
(copy tone + resource fit).

### D7 — NMMH placement on the safety tier
**Decision (2026-07-03):** NMMH is listed as the THIRD safety resource, behind 988
call + text. **Rationale:** NMMH self-describes as NOT a crisis line and redirects
suicidal crisis to 988, so 988 leads on the safety tier; NMMH is kept as a
perinatal-specific 24/7 backup. Placement is provisional. **Status:** AWAITING
CLINICAL REVIEW — Michelle rules on ordering/inclusion.

## Architecture decisions (clinically relevant)

### D8 — Distress never routes through track machinery
**Decision (2026-07-03):** distress does NOT auto-activate any track (no
"stress-track" as a distress response). Support response and content enrichment
are separate channels; a clinical response never sits behind the 0.6 track
confidence gate. `proposed_enrichments` is computed identically regardless of tier.
**Rationale:** conflating a clinical response with content routing would gate
safety behind a confidence threshold and pollute the learning plan. **Status:**
AWAITING CLINICAL REVIEW (informational; unlikely to change).

### D9 — Distress and signals coexist
**Decision (2026-07-03):** distress and signal extraction are two independent
outputs from one classification. An update can be a milestone signal AND tier
safety at once; distress never suppresses a signal, a signal never dilutes
distress. **Rationale:** "she's finally crawling! some days I don't want to be
here" must yield BOTH the milestone and the safety detection. **Status:** AWAITING
CLINICAL REVIEW (informational).

### D11 — Unreadable distress assessment: normalize → retry → marked none (never silent)
**Decision (2026-07-03):** the classifier's distress tier is handled in three steps,
in order: (1) NORMALIZE near-misses ("Safety", "SAFETY ", trailing punctuation) to
canonical values — recoverable LLM output, not a failure; (2) RETRY up to 3× on a
genuinely unreadable distress object (same discipline as the questionnaire
generator) — an unreadable assessment is a failed generation, re-asked; (3) only
after exhausting retries, default to `tier='none'` **marked distinctly** —
`parse_failed=true` in the response AND a `distress_detections` audit row
(`parse_failed=true`), never a silent none. **Rationale:** the fallback must not
fail in the wrong direction — a garbled SAFETY read silently becoming no-distress,
at the one layer the prompt can't reach, is exactly the false-negative the slice
forbids. Marking preserves the distinction between "assessed none" and "couldn't
read the assessment" — which is the whole point of a safety audit. **Status:**
AWAITING CLINICAL REVIEW (informational; the marking policy is unlikely to change,
but the review should know the failure mode is surfaced, not swallowed).

### D10 — Preview (persist=false) writes nothing
**Decision (2026-07-03):** a `persist=false` classification returns the full
distress payload in the response but writes NO event and NO audit row. **Rationale:**
console preview input is TEST data; auditing test detections would pollute the
safety log. Slice-4 app submissions always persist (`apply=true` forces persist),
so every REAL detection is always audited. **Status:** AWAITING CLINICAL REVIEW
(informational; revisit if the app ever previews real parent input un-persisted).
