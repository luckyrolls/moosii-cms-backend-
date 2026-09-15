# Child health in classify — PROPOSAL (migrations, prompt rewrite, code plan)

**Status: PROPOSAL. Nothing built, nothing applied.** Build order: **after the facts intake route**
(`POST /facts`, `GET /facts/:user_id`). Migration numbers below are tentative: facts intake may take
080, so this set is written as **H1–H4** and numbered at build.

Decisions taken by Mark (2026-09-15) that this proposal implements:
- The mechanism as proposed: a sibling of distress, never routed through tracks or milestones.
  The model EXTRACTS findings; urgency is decided in CODE from the child's age + DB rules.
- Red flags and thresholds seeded provisionally from AAP when-to-call guidance into
  `health_urgency_rules`.
- Precedence: **safety distress > emergency > same_day > overwhelm/strain > routine > acks.** When
  an update is mixed, BOTH the distress and the health responses are shown.
- Distress narrowing at BOTH layers (prompt + code backstop). Safety is never downgraded. Recorded
  as proposed changes to D2/D4.
- Provisional copy per band.
- Everything clinical is `is_provisional` and listed in `docs/provisional-clinical-decisions.md` for
  Michelle.

The launch gate is unchanged: no real parents on free-text input until the clinical owner confirms.

---

## 1. Data model — migrations

### H1 `health_red_flags` + `health_urgency_rules` (schema; both projects)

```sql
CREATE TABLE health_red_flags (
  key            text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  label          text NOT NULL,          -- CMS display
  description    text NOT NULL,          -- rendered into the classifier prompt: what counts
  uses_temperature boolean NOT NULL DEFAULT false,
  uses_duration    boolean NOT NULL DEFAULT false,
  is_active      boolean NOT NULL DEFAULT true,
  is_provisional boolean NOT NULL DEFAULT true,
  source_ref     text,                   -- the AAP page the flag came from
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE health_urgency_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  red_flag_key       text NOT NULL REFERENCES health_red_flags(key) ON UPDATE CASCADE ON DELETE RESTRICT,
  min_age_months     integer NOT NULL DEFAULT 0 CHECK (min_age_months >= 0),   -- inclusive
  max_age_months     integer CHECK (max_age_months IS NULL OR max_age_months > min_age_months), -- exclusive; NULL = no upper bound
  min_temperature_c  numeric(4,1) CHECK (min_temperature_c IS NULL OR min_temperature_c BETWEEN 35 AND 43),
  min_duration_hours integer CHECK (min_duration_hours IS NULL OR min_duration_hours > 0),
  band               text NOT NULL CHECK (band IN ('emergency','same_day','routine')),
  is_active          boolean NOT NULL DEFAULT true,
  is_provisional     boolean NOT NULL DEFAULT true,
  source_ref         text NOT NULL,      -- AAP page + the exact phrase the rule encodes
  notes              text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON health_urgency_rules (red_flag_key) WHERE is_active;
```
RLS: authenticated SELECT (reference content, like `distress_responses`), `is_admin()` write, so
the CMS can edit rules and copy without a migration.

### H2 seed flags + rules (data; **Moosii only**)
Financial has no children and no classify traffic; the schema still exists there for parity (the
same rule as D6 for 075). Everything is `is_provisional = true` with `source_ref`. The seed table is
§4. The file is idempotent (`ON CONFLICT DO NOTHING`).

### H3 responses, audit, event column, distress downgrade marker (schema + provisional copy; both / copy Moosii only)
```sql
CREATE TABLE health_responses (            -- ONE fixed row per band, never a random variant
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  band text UNIQUE NOT NULL CHECK (band IN ('emergency','same_day','routine')),
  message text NOT NULL,
  resources jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{label, value, kind: phone|text|url}]
  is_provisional boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE health_detections (           -- audit, backend-only (RLS on, no policy)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES user_update_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL, child_id uuid,
  band text CHECK (band IN ('emergency','same_day','routine')),
  child_age_months integer,                -- NULL = unknown age → most conservative band used (H-D3)
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  matched_rule_ids uuid[] NOT NULL DEFAULT '{}',
  unmatched_flags text[] NOT NULL DEFAULT '{}',   -- recognised flag, no rule for this age (a seed gap)
  unknown_flags   text[] NOT NULL DEFAULT '{}',   -- model emitted a key not in the vocabulary (dropped)
  rules_version text,                      -- content hash of the active rules at decision time
  parse_failed boolean NOT NULL DEFAULT false,
  correlation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parse_failed OR band IS NOT NULL)  -- a row is a real band OR an unreadable assessment
);

ALTER TABLE user_update_events ADD COLUMN health_band text
  CHECK (health_band IS NULL OR health_band IN ('emergency','same_day','routine'));

-- Distress narrowing (code layer) must be audited, never silent:
ALTER TABLE distress_detections ADD COLUMN downgraded_from text
  CHECK (downgraded_from IS NULL OR downgraded_from IN ('strain','overwhelm'));  -- never 'safety'
ALTER TABLE distress_detections DROP CONSTRAINT <025 check>;   -- name read in the pre-check
ALTER TABLE distress_detections ADD CONSTRAINT distress_detections_row_is_notable
  CHECK (parse_failed OR tier <> 'none' OR downgraded_from IS NOT NULL);
```
The provisional `health_responses` copy is §5; it is seeded on Moosii only.

### H4 `classify_update` prompt rewrite (data; **Moosii only** — financial has no prompt rows)
It replaces `system_message` and `output_schema` whole, like 024. The pre-check pins the live text:
it must equal migration 024's body (verified identical 2026-09-15; 6,138 chars). §2 is the exact
diff.

Each file gets the standard PRE-CHECK / VERIFICATION blocks and the psql apply process: financial
first, then Moosii, a go per batch.

---

## 2. Prompt rewrite (H4)

024's text stays byte-for-byte except for two insertions.

**(a) In DISTRESS → HOW TO ASSESS, a new rule 6** (layer 1 of the narrowing):
> 6. PARENT STATE, NOT CHILD SYMPTOMS. Distress measures the PARENT's emotional state. A
> description of the child's symptoms or illness — even an alarming one ("fever of 104", "won't
> stop vomiting", "she's limp") — with NO words about how the parent is feeling or coping is tier
> none for distress; it belongs in child_health. For strain or overwhelm, evidence_span must quote
> the parent's own feeling or coping words, never the symptom words. THIS RULE NEVER APPLIES TO
> SAFETY: any language about harming the child or oneself stays tier safety even when it is phrased
> as, or mixed with, a description of symptoms.

**(b) A new CHILD HEALTH block**, after DISTRESS and before "Return ONLY":
> CHILD HEALTH — a THIRD, MANDATORY, SEPARATE extraction on EVERY update, independent of signals,
> tracks and distress. Output `child_health` { concern, symptom_span, findings }.
> Your job is to EXTRACT what the parent states about the child's physical health — NOT to judge
> urgency. Urgency is decided elsewhere, from the child's age. Never add advice.
> - concern: true when the update describes any physical symptom, illness or injury of the child.
> - symptom_span: the EXACT substring describing it ("" when concern is false).
> - findings: one entry per HEALTH FLAG (the list in the message) the words plausibly describe. Use
>   ONLY keys from that list; never invent one. EXTRACTION IS LENIENT: if a flag is plausibly
>   described, include it — a missed red flag is the failure; an extra one only costs a message.
>   - temperature: the number EXACTLY as written ("102", "38.5"), or "" when none is stated. Never
>     convert, never guess.
>   - temperature_unit: "F", "C", or "" when not stated.
>   - duration_hours: a whole number of hours ONLY when the parent states a duration ("for 3 days"
>     -> "72"); "" when not stated. Do not estimate from vague time words.
>   - evidence_span: the EXACT substring for this finding.
> - NEGATION: "no fever", "not vomiting anymore" are NOT findings.
> - COEXISTENCE: a health concern can sit alongside a milestone signal and any distress tier.
>   Assess all three fully.
> - Child health NEVER routes through tracks and never records a milestone.

**Output schema** gains a required `child_health` object:
```json
"child_health": {
  "type": "object", "required": ["concern", "symptom_span", "findings"], "additionalProperties": false,
  "properties": {
    "concern": { "type": "boolean" },
    "symptom_span": { "type": "string" },
    "findings": { "type": "array", "items": {
      "type": "object",
      "required": ["flag", "temperature", "temperature_unit", "duration_hours", "evidence_span"],
      "additionalProperties": false,
      "properties": {
        "flag": { "type": "string" },
        "temperature": { "type": "string" },
        "temperature_unit": { "type": "string", "enum": ["F", "C", ""] },
        "duration_hours": { "type": "string" },
        "evidence_span": { "type": "string" } } } }
  }
}
```
Numbers are carried as strings so no nullable unions are needed. The same schema feeds OpenAI
strict mode (`toStrictSchema`) and Gemini, whose dialect is narrower. Code parses, validates and
converts °F→°C. `flag` stays a free string rather than an enum: the vocabulary lives in the DB, so
Michelle can add a flag without a prompt migration. Code drops unknown keys and audits them.

**User message** gains a rendered `HEALTH FLAGS` list (key, label, description) from active
`health_red_flags`, the same pattern as the track catalog. The child's age is deliberately NOT sent:
the model must not triage.

---

## 3. Code plan

New pure, unit-tested modules (per the "standalone, independently testable" convention):
- **`src/lib/childAge.ts`** — `ageMonths(birthYear, birthMonth0to11, now)`, the same formula as
  the `user_mlp_data` view (`age(current_date, make_date(y, m+1, 1))`). Returns null when birth data
  is missing or out of range.
- **`src/lib/healthUrgency.ts`**
  - `loadHealthVocabulary()` loads active flags + rules and returns a `rules_version` hash.
  - `renderHealthFlagsForPrompt()`.
  - `parseFindings(raw, flagKeys)` validates keys, parses the temperature string → °C (F converted,
    1 dp) and parses `duration_hours`. It separates `unknown_flags`.
  - `resolveHealthBand(findings, ageMonths | null, rules)` returns
    `{ band, matched_rule_ids, unmatched_flags }`. For each finding, a rule matches when the age
    fits `[min, max)` (or, at an unknown age, any rule for that flag — H-D3), the temperature is ≥
    `min_temperature_c` or unknown (H-D2), and the duration is ≥ `min_duration_hours` (unknown
    duration does NOT match — H-D2). The highest band across all matches wins. A recognised flag
    with no matching rule → `routine` + `unmatched_flags` (H-D4). `concern=true` with no valid
    findings → `routine`.
- **`src/lib/distressNarrowing.ts`** — `narrowDistress(tier, evidenceSpan, healthSpans)`. It
  downgrades ONLY `strain | overwhelm` → `none`, and only when `evidenceSpan` is non-empty and every
  clause of it lies inside the health `symptom_span` or a finding's `evidence_span` (normalized
  case and whitespace). Returns `{ tier, downgraded_from }`. **`safety` passes through untouched,
  by construction and by test.**
- **`src/lib/responsePrecedence.ts`** — `orderResponses({ distress, health })` builds an ordered
  `responses[]`: safety → emergency → same_day → overwhelm/strain → routine. `ack_message` is
  suppressed when distress is strain+ (today's rule) or the health band is emergency/same_day; it is
  still shown after a routine health response (reading "routine > acks" as order, not suppression).

`src/routes/classifyUpdate.ts` changes:
1. In parallel with the prompt row and the catalog, load the health vocabulary and the classified
   child's birth year/month (the input's `child_id`, not the youngest child).
2. The user prompt adds the `HEALTH FLAGS` block.
3. `resolveClassification` treats an unreadable `child_health` object like an unreadable distress
   tier: re-ask (same 3 attempts), then a marked default (`health.parse_failed = true`, `band =
   null`), never a silent "no concern". Existing tests stay; new injected-generator tests cover it.
4. After gating: parse findings → age → `resolveHealthBand`; then `narrowDistress` on the model's
   tier using the health spans; then load `health_responses[band]`.
5. Persist, when `persist`: `user_update_events.health_band`. A `health_detections` row on any band
   or `parse_failed`. A `distress_detections` row also when `downgraded_from` is set. Audit write
   failures are logged loudly and never throw (the same posture as today's safety audit).
6. Response, additive and backward compatible:
   - `distress` gains `downgraded_from`;
   - new `child_health { concern, band, age_months_used, findings, matched_rule_ids,
     unmatched_flags, response, parse_failed }`;
   - new ordered `responses[]`;
   - `ack_message` follows the rule above;
   - `provenance` gains `health_rules_version`.
7. `apply_classification`, tracks, milestones and the MLP are untouched: health never enriches.

Docs in the same commits:
- `api-contract.md` §2j — the response shape and precedence;
- `provisional-clinical-decisions.md` — the H-entries below plus proposed D2/D4 changes;
- `docs/rls-sweep.md`;
- the `migrations/README.md` entries;
- a types regen after the Moosii apply.

Verification:
- **Unit tests** for all four pure modules: age boundaries at 0/3/24 months, F→C, unknown age,
  unknown temperature/duration, unknown flags, safety never downgraded, precedence ordering.
- **Migrations** on the restored Moosii schema dump, as for 078: RLS on the new tables, and
  `distress_detections`' new check still refusing a silent none row.
- **Live console dry run** (`persist=false`, no writes) on Moosii, with about 10 fixture updates:
  a febrile 6-week-old, a febrile 14-month-old for 2 days, "exhausted and the baby keeps
  vomiting", symptoms only, safety mixed with symptoms, no-fever negation. These are billed LLM
  calls, all logged to `ai_generation_log`.

Second surfaces (flag to their seats, not built here):
- **moosii-cms** — editors for `health_red_flags` / `health_urgency_rules` / `health_responses`,
  and the child_health block in the classify console and inspector.
- **moosii-rn** — render `responses[]` in order. An emergency response needs its own UI
  treatment (call-911 action), not an ack toast.

---

## 4. Provisional seed — flags and rules (H2)

Sources, fetched 2026-09-15:
[AAP Fever: When to Call the Pediatrician](https://www.healthychildren.org/English/health-issues/conditions/fever/Pages/When-to-Call-the-Pediatrician.aspx) ·
[AAP Urgent Care, ER or Pediatrician?](https://www.healthychildren.org/English/family-life/health-management/Pages/urgent-care-ER-or-pediatrician-a-parent-guide.aspx) ·
[AAP When to Call EMS](https://www.healthychildren.org/English/health-issues/injuries-emergencies/Pages/When-to-Call-Emergency-Medical-Services-EMS.aspx) ·
[AAP Signs of Dehydration](https://www.healthychildren.org/English/health-issues/injuries-emergencies/Pages/dehydration.aspx).

Band mapping (H-D1): AAP "ER / call 911" → **emergency**; "call your doctor right away" and
"urgent care" → **same_day**; "call pediatrician same/next day" and "manage at home" → **routine**.
Where two AAP pages disagree, the higher band is used (conservative-upward, as D2).

| flag | ages (months) | threshold | band | AAP basis |
|---|---|---|---|---|
| `fever` | 0–3 | ≥ 38.0 °C (or unstated) | emergency | "baby under 3 months with 100.4°F (38°C) or higher" (ER guide); fever page says call right away — higher used |
| `fever` | any | ≥ 40.0 °C | same_day | "rises above 104°F (40°C) repeatedly" — a single report is treated as meeting it (H-D2) |
| `fever` | 0–24 | lasting ≥ 24 h | same_day | "persists for more than 24 hours in a child younger than 2" |
| `fever` | ≥ 24 | lasting ≥ 72 h | same_day | "more than 3 days (72 hours) in a child 2 years or older" |
| `fever` | ≥ 3 | any | routine | "fever with mild cold symptoms and good energy" — home |
| `breathing_severe` | any | — | emergency | blue/gray lips, retractions, can't speak in full sentences |
| `breathing_fast_alert` | any | — | same_day | "fast or labored breathing but still alert and interacting" |
| `unresponsive_or_extreme_sleepiness` | any | — | emergency | fever with "unresponsiveness or extreme sleepiness"; EMS page |
| `seizure_new` | any | — | emergency | abnormal movements/stiffening with loss of consciousness, no known seizure disorder |
| `purple_rash` | any | — | emergency | "purple or bruise-like rash that appears suddenly" |
| `stiff_neck` | any | — | emergency | fever with "stiff neck and sensitivity to light" |
| `head_injury_serious` | any | — | emergency | "head injury with vomiting, confusion, seizure or loss of consciousness" |
| `dehydration_severe` | any | — | emergency | "prolonged vomiting and/or diarrhea; too weak or drowsy to drink" |
| `dehydration_signs` | any | — | same_day | fewer than six wet diapers/day, dry mouth, few tears, sunken soft spot |
| `repeated_vomiting_diarrhea` | any | — | same_day | fever page "repeated vomiting or diarrhea" → call right away |
| `looks_very_ill` | any | — | same_day | "looks very ill, is unusually drowsy, or is very fussy" |
| `severe_abdominal_pain` | any | — | emergency | ER guide "severe abdominal pain" |
| `severe_head_throat_ear_pain` | any | — | same_day | fever page "severe headache, severe sore throat, severe ear pain" |
| `allergic_reaction_mild` | any | — | same_day | urgent care: "suspected allergic reaction with swelling, rash, or hives" (breathing → `breathing_severe`) |
| `injury_deformity_or_heavy_bleeding` | any | — | emergency | bone "visibly bent or sticking out" |
| `injury_needs_care` | any | — | same_day | cut needing stitches; suspected fracture without deformity |
| `overheated` | any | — | same_day | "has been in a very hot place, such as an overheated car" |
| `poisoning_ingestion` | any | — | emergency | ⚠ NOT on the fetched pages — Poison Control 1-800-222-1222 guidance; **verify before seeding** |
| `mild_illness` | any | — | routine | mild cold symptoms, mild rash, bug bites, mild diaper rash — home |

Deliberately left out of v1: combination rules (e.g. fever + chronic condition, fever + a specific
symptom) — each finding is resolved on its own and the highest band wins (H-D5).

## 5. Provisional response copy (H3) — neutral voice, no "I" (D12)

- **emergency** — "What you're describing can be a sign your child needs care right away. Please
  call 911 or go to the nearest emergency room now. If you're not sure, it's always okay to call."
  Resources: 911 (phone) · Poison Control 1-800-222-1222 (phone, 24/7).
- **same_day** — "This is worth a call to your child's doctor today. If it's after hours, most
  offices have a nurse line. If things get worse — trouble breathing, very hard to wake, or can't
  keep fluids down — go to the emergency room." Resources: 911 (phone).
- **routine** — "Thanks for letting us know. This sounds like something to watch at home and
  mention to your child's doctor if it continues. When in doubt, call your pediatrician's office."
  Resources: none.

## 6. Entries for `provisional-clinical-decisions.md` (all AWAITING CLINICAL REVIEW)

- **H-D1** — The three bands and the AAP → band mapping; the higher band where AAP pages disagree.
- **H-D2** — An unknown temperature matches a temperature threshold (a reported "fever" in an infant
  under 3 months → emergency); an unknown duration does NOT match a duration threshold; a single
  ≥ 40 °C report counts as "repeatedly".
- **H-D3** — Unknown child age → evaluate every rule for the flag and take the highest band.
- **H-D4** — A recognised flag with no rule at the child's age → routine, recorded as a seed gap.
- **H-D5** — No combination rules in v1; highest single-finding band wins.
- **H-D6** — Extraction-only model with code triage; age never sent to the model.
- **H-D7** — Precedence: safety > emergency > same_day > overwhelm/strain > routine > acks; mixed →
  both shown; acks suppressed under strain+ or emergency/same_day.
- **H-D8** — The provisional copy and resources per band (§5); the poisoning flag's source to verify.
- **H-D9** — Unreadable child_health → retry ×3, then marked `parse_failed`, audited, never silent.
- **D2 (proposed change)** — Conservative-upward no longer applies when the only evidence is child
  symptom wording: the prompt rule 6 plus the code backstop may take strain/overwhelm → none, marked
  `downgraded_from` and audited. **Safety is never downgraded.**
- **D4 (proposed change)** — "No confidence floor" is narrowed: symptom-only text is not
  "plausibly present distress". The narrowing is audited per event, so review can measure what it
  removes.

## 7. Open before the go

1. The poisoning flag: seed it with the Poison Control line (source not fetched) or leave it out
   until verified.
2. "routine > acks": confirm routine health is shown WITH an ack (the reading in §3), or instead of one.
3. Migration numbers are assigned when the facts intake route's migrations are known.
