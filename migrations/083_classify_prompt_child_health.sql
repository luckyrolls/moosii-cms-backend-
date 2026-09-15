-- ============================================================================
-- MIGRATION 083 (child health H4): classify_update prompt — child-health extraction + distress
-- narrowing (rule 6) — APPLIED moosii 2026-09-15   *** MOOSII ONLY *** (financial has no prompt rows)
-- ============================================================================
-- GENERATED from migration 024's exact text (scratchpad gen_083.py): 024's system_message is kept
-- byte-for-byte except for TWO insertions, and output_schema gains a required `child_health` object.
--   (a) DISTRESS -> HOW TO ASSESS gains rule 6, PARENT STATE NOT CHILD SYMPTOMS — layer 1 of the
--       distress narrowing (D2/D4 proposed change). Explicitly never applies to safety.
--   (b) A CHILD HEALTH block before "Return ONLY": extraction only (flags from the HEALTH FLAGS list
--       the backend renders into the user message; temperature / duration as written strings),
--       NOT urgency — the band is decided in code from the child's age (H-D6).
-- Numbers travel as strings so one schema serves OpenAI strict mode and Gemini (no nullable unions).
--
-- The UPDATE is GUARDED: it runs only when the live system_message is still 024's text
-- (md5 4a3e23cfcbc91ae84cfa88f8405750de); if it is already this file's text (md5 fc44fb5cf7228ca16a3234c788b3782a) it is a
-- no-op; anything else raises and nothing changes.
--
-- LINE ENDINGS: the live row stores the prompt with CRLF (it was applied through the SQL editor;
-- 024's LF body converted to CRLF hashes to the live md5 exactly). To keep that format regardless of
-- how this file's own line endings are read, the new text is normalized in SQL:
-- replace(replace(text, CR, ''), LF, CR || LF). Both md5 values above are of the CRLF form.
--
-- The previous backend code ignores the new `child_health` field, so applying before the code
-- deploys is safe. prompt_version (sha256 of system_message) changes, visible in provenance.
--
-- APPLY per migrations/README.md: MOOSII only.
-- ============================================================================

-- PRE-CHECK — EXPECT 4a3e23cfcbc91ae84cfa88f8405750de (before) or fc44fb5cf7228ca16a3234c788b3782a (already applied):
--   SELECT md5(system_message) FROM prompts WHERE prompt_type = 'classify_update' AND is_active;

BEGIN;

DO $guard$
DECLARE cur text;
BEGIN
  SELECT md5(system_message) INTO cur FROM prompts WHERE prompt_type = 'classify_update' AND is_active;
  IF cur IS NULL THEN
    RAISE EXCEPTION '083: no active classify_update prompt row';
  ELSIF cur = 'fc44fb5cf7228ca16a3234c788b3782a' THEN
    RAISE NOTICE '083: classify_update prompt already carries child health — no change';
  ELSIF cur <> '4a3e23cfcbc91ae84cfa88f8405750de' THEN
    RAISE EXCEPTION '083: live classify_update system_message (md5 %) is not migration 024''s text — re-base before applying', cur;
  ELSE
    UPDATE prompts
    SET updated_at = now(),
        output_schema = $schema${
  "type": "object",
  "required": [
    "relevant",
    "signals",
    "proposed_enrichments",
    "distress",
    "child_health"
  ],
  "additionalProperties": false,
  "properties": {
    "relevant": {
      "type": "boolean"
    },
    "signals": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "type",
          "value",
          "confidence",
          "evidence_span"
        ],
        "additionalProperties": false,
        "properties": {
          "type": {
            "type": "string"
          },
          "value": {
            "type": "string"
          },
          "confidence": {
            "type": "number"
          },
          "evidence_span": {
            "type": "string"
          }
        }
      }
    },
    "proposed_enrichments": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "track_id",
          "confidence",
          "source_signal"
        ],
        "additionalProperties": false,
        "properties": {
          "track_id": {
            "type": "string"
          },
          "confidence": {
            "type": "number"
          },
          "source_signal": {
            "type": "string"
          }
        }
      }
    },
    "distress": {
      "type": "object",
      "required": [
        "tier",
        "evidence_span"
      ],
      "additionalProperties": false,
      "properties": {
        "tier": {
          "type": "string",
          "enum": [
            "none",
            "strain",
            "overwhelm",
            "safety"
          ]
        },
        "evidence_span": {
          "type": "string"
        }
      }
    },
    "child_health": {
      "type": "object",
      "required": [
        "concern",
        "symptom_span",
        "findings"
      ],
      "additionalProperties": false,
      "properties": {
        "concern": {
          "type": "boolean"
        },
        "symptom_span": {
          "type": "string"
        },
        "findings": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "flag",
              "temperature",
              "temperature_unit",
              "duration_hours",
              "evidence_span"
            ],
            "additionalProperties": false,
            "properties": {
              "flag": {
                "type": "string"
              },
              "temperature": {
                "type": "string"
              },
              "temperature_unit": {
                "type": "string",
                "enum": [
                  "F",
                  "C",
                  ""
                ]
              },
              "duration_hours": {
                "type": "string"
              },
              "evidence_span": {
                "type": "string"
              }
            }
          }
        }
      }
    }
  }
}$schema$::jsonb,
        system_message = replace(replace($sys$You read a parent's free-form update about their child and answer TWO SEPARATE
questions against a catalog of Moosii support TRACKS:
  (1) Does the update contain a concrete SIGNAL — a milestone, concern, or clear
      need the parent actually states?
  (2) If there is a signal, does any track's PURPOSE genuinely match it?
These are different questions. A real signal can exist with NO matching track —
when that happens you STILL report the signal (relevant: true) and simply make no
proposal. Detecting a signal and finding a track are independent; answer both
honestly. A confident signal with no matching track is valuable data (it tells us
which track to write next), so never suppress a genuine signal just because
nothing in the catalog fits.

WHAT relevant: false MEANS. It means there is NO concrete signal — weather, a
vent, a passing feeling, small talk, a photo caption. That is the CORRECT and
COMMON outcome; most updates are this. relevant: false is NOT for "there's a
signal but no track matched" — a clearly-stated milestone or concern IS a signal;
report it. Do NOT invent a signal to be helpful: a false signal is worse than a
missed weak one. When there is genuinely nothing concrete, return relevant: false.

SIGNALS — a concrete, specific thing the prose actually STATES. Report every
genuine one, whether or not a track matches. For each:
- type: short category (e.g. "milestone", "concern", "need")
- value: the specific thing (e.g. "crawling")
- confidence: 0..1, calibrated to how clearly the words state it; vague/inferred -> low
- evidence_span: the EXACT substring of the update that triggered it (verbatim)
relevant is true if and only if there is at least one genuine signal — regardless
of whether you propose any track.

PROPOSALS — SEPARATELY, for a signal whose meaning clearly matches a track's
PURPOSE (read its description), propose activating that track:
- track_id: the EXACT id from the catalog. NEVER invent an id.
- confidence: 0..1 that this track is the right enrichment for this signal
- source_signal: the signal value it came from
A loose thematic association is NOT enough — the description must genuinely fit.
If no track fits a signal, propose nothing for it; the signal still stands.

POLARITY — read the track's description for the STATE it serves, and honor the
update's polarity. A track for a REACHED state must NEVER be proposed from an
update that says the state is NOT reached. Negated / absent / not-yet phrasing
about a milestone is a genuine signal (report it — usually a concern), but it
matches NO reached-state track, so propose ZERO tracks for it. This is by design:
a milestone stated as not-yet-reached is a deliberately unserved class (a
screening boundary), not a coverage gap — treat it as signal-without-destination,
exactly like a milestone that has no matching track at all. Do NOT let keyword
overlap between the words and a track's name/phrases override the negation.
Examples (all -> concern/need signal, but ZERO proposals):
- "Sophie is not crawling yet" — the "Baby Is Crawling" track (description: "Baby
  has started crawling…") serves a child who HAS crawled; not-yet -> no proposal.
- "she hasn't rolled over", "still won't walk", "no words yet", "yet to sit up".
A track is proposed only when the update states the milestone IS reached (or a
concern the track's purpose positively serves).

CALIBRATION. Prefer fewer, higher-confidence outputs. If you cannot justify a
signal from the exact words, leave it out (and that may make the whole update
relevant: false). Proposals are held to a higher bar than signals.

DISTRESS — a SEPARATE, MANDATORY assessment on EVERY update, independent of the
signal and track work above. Judge the parent's emotional state and output a
`distress` object { tier, evidence_span }.

TIERS (tier is exactly one of: none | strain | overwhelm | safety):
- none — no distress. The overwhelming majority: milestones, weather, logistics,
  ordinary updates.
- strain — hard-but-coping. Venting, tiredness, a rough patch, frustration the
  parent is carrying: "so exhausted", "rough week", "he won't stop crying and I'm
  fried".
- overwhelm — not-coping, hopelessness, or self-blame beyond ordinary venting:
  "I can't do this anymore", "nothing I do helps", "I'm failing her", "I don't
  know how much longer I can keep going".
- safety — ANY language about self-harm, harm to the child, or not wanting to be
  alive / not wanting to be here — however oblique, hedged, passive, or wrapped in
  positive content: "some days I don't want to be here", "they'd be better off
  without me", "what if I just didn't wake up", "I have thoughts I'm scared of".
  This is the item-10 analog.

HOW TO ASSESS — distress runs OPPOSITE to track matching. Track matching is strict
(don't stretch, weak matches are dropped). Distress is LENIENT and errs TOWARD
concern:
1. NO confidence floor. There is no threshold that silently drops a borderline
   read to none. If distress is plausibly present, do NOT return none. A false
   positive is acceptable; a missed distress is the failure.
2. CONSERVATIVE UPWARD. If two tiers are both plausible, choose the HIGHER one
   (strain vs overwhelm -> overwhelm; overwhelm vs safety -> safety).
3. SAFETY IS NEAR-DETERMINISTIC. Any safety-language endorsement -> tier safety,
   full stop. Do NOT weigh it against positive or upbeat content elsewhere in the
   update; a happy milestone in the same sentence does not lower the tier.
4. COEXISTENCE. Distress is independent of signals. An update can be a milestone
   signal AND tier safety at once ("she's finally crawling! honestly some days I
   don't want to be here" = crawling signal + tier safety). Never let distress
   suppress a signal, and never let a signal dilute distress. Assess both fully.
5. evidence_span = the EXACT substring that drove the tier (verbatim), or "" when
   tier is none.
6. PARENT STATE, NOT CHILD SYMPTOMS. Distress measures the PARENT's emotional state.
   A description of the child's symptoms or illness — even an alarming one ("fever of
   104", "won't stop vomiting", "she's limp") — with NO words about how the parent is
   feeling or coping is tier none for distress; it belongs in child_health below. For
   strain or overwhelm, evidence_span must quote the parent's own feeling or coping
   words, never the symptom words. THIS RULE NEVER APPLIES TO SAFETY: any language
   about harming the child or oneself stays tier safety even when it is phrased as, or
   mixed with, a description of symptoms.

Distress NEVER routes through tracks. Do not invent or propose a track as a
distress response; proposed_enrichments is computed exactly as specified above,
regardless of tier.

CHILD HEALTH — a THIRD, MANDATORY, SEPARATE extraction on EVERY update, independent of
signals, tracks and distress. Output a `child_health` object { concern, symptom_span,
findings }. Your job is to EXTRACT what the parent states about the child's physical
health — NOT to judge urgency. Urgency is decided elsewhere, from the child's age. Never
add advice.
- concern: true when the update describes any physical symptom, illness or injury of the
  child; false otherwise.
- symptom_span: the EXACT substring describing it (verbatim), or "" when concern is false.
- findings: one entry per HEALTH FLAG (the list in the message) that the words plausibly
  describe. Use ONLY keys from that list; never invent one. EXTRACTION IS LENIENT: if a
  flag is plausibly described, include it — a missed red flag is the failure; an extra
  one only costs a message. A symptom that matches no flag still makes concern true.
  For each finding:
  - flag: the EXACT key from the HEALTH FLAGS list.
  - temperature: the number EXACTLY as written ("102", "38.5"), or "" when no number is
    stated. Words like "high fever" are NOT a number. Never convert, never guess.
  - temperature_unit: "F" or "C" when written or unambiguous from the number, else "".
  - duration_hours: a whole number of hours ONLY when the parent states a duration you
    can express without guessing ("for 3 days" -> "72", "since yesterday morning" is
    NOT exact -> ""); "" when not stated. Never estimate from vague time words ("the
    last couple of days", "a while").
  - evidence_span: the EXACT substring for this finding (verbatim).
- NEGATION: "no fever", "not vomiting anymore", "her fever broke" are NOT findings.
- COEXISTENCE: a health concern can sit alongside a milestone signal and any distress
  tier. Assess all three fully; never let one suppress another.
- Child health NEVER routes through tracks and never records a milestone.

Return ONLY the JSON object in the required shape. No preamble.$sys$, chr(13), ''), chr(10), chr(13) || chr(10))
    WHERE prompt_type = 'classify_update' AND is_active = true;
    RAISE NOTICE '083: classify_update prompt rewritten';
  END IF;
END $guard$;

COMMIT;

-- VERIFICATION — EXPECT md5 fc44fb5cf7228ca16a3234c788b3782a, child_health in output_schema.required, and the
-- two inserted blocks present:
--   SELECT md5(system_message) = 'fc44fb5cf7228ca16a3234c788b3782a',
--          output_schema->'required' ? 'child_health',
--          position('PARENT STATE, NOT CHILD SYMPTOMS' in system_message) > 0,
--          position('CHILD HEALTH — a THIRD' in system_message) > 0
--     FROM prompts WHERE prompt_type = 'classify_update' AND is_active;
