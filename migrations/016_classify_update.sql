-- ============================================================================
-- Migration 016 (main track): classify-update — user_update_events + signals + prompt
-- ============================================================================
-- Slice 1 of §2j (Layer 3): classify a parent's free-form update against the live
-- track catalog and PROPOSE track activations (enrich-only, dry-run). This migration
-- creates the append-only event log + a linked signals table, and seeds the
-- classifier prompt row.
--
-- user_update_events: raw prose VERBATIM, never mutated, written only when the
--   endpoint is called with persist=true. user_id/child_id are uuid with no FK
--   (raw intake log; FKs can be added later).
-- user_update_signals: derived signals as SEPARATE linked rows (never overwrite the
--   prose). `matched` + `matched_track_id` let us later query unmatched signals
--   (catalog-gap analysis — e.g. many "crawling" signals with no track to enrich).
--
-- Prompt is DB-composed (prompt_type='classify_update'); output_schema kept in the
-- permissive responseSchema form so it works on either provider (CLASSIFY_WRITER).
--
-- APPLIED VIA THE SUPABASE SQL EDITOR — not in schema_migrations; on the 008..016 /
-- 0001..0005 reconciliation list. Regenerate database.types.ts after applying.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_update_events (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid,
  child_id          uuid,
  raw_text          text not null,
  source            text,                    -- e.g. 'cms_test'
  processing_status text not null default 'classified',
  correlation_id    uuid,
  created_at        timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS user_update_signals (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null references user_update_events(id) on delete cascade,
  type             text,
  value            text,
  confidence       numeric,
  evidence_span    text,
  matched          boolean not null default false,  -- produced an accepted proposal?
  matched_track_id uuid,                             -- the track it enriched, if any
  created_at       timestamptz not null default now()
);
CREATE INDEX IF NOT EXISTS idx_uus_event ON user_update_signals (event_id);
CREATE INDEX IF NOT EXISTS idx_uus_unmatched ON user_update_signals (matched) WHERE matched = false;

-- Classifier prompt (single active row).
INSERT INTO prompts (prompt_type, is_active, system_message, output_schema)
SELECT
  'classify_update',
  true,
  $sys$You classify a parent's free-form update about their child against a catalog of
Moosii support TRACKS. Each track has a name and a description of what it helps
with; some list the screening questions that route parents into them. Decide
whether the update contains an ACTIONABLE signal that matches a track, and if so
propose activating that track.

MOST UPDATES CONTAIN NO ACTIONABLE SIGNAL. Weather, a vent, a passing feeling, a
photo caption — usually nothing to act on. `relevant: false` with no signals is
the CORRECT and COMMON answer. Do NOT stretch to find a match, and do not reward
yourself for being helpful — a false "relevant" is worse than a missed weak one.
When in doubt, return `relevant: false`.

SIGNALS — a concrete, specific thing the prose actually STATES (a milestone, a
concern, a clear need). For each:
- type: short category (e.g. "milestone", "concern", "need")
- value: the specific thing (e.g. "crawling")
- confidence: 0..1, calibrated to how clearly the words state it; vague/inferred -> low
- evidence_span: the EXACT substring of the update that triggered it (verbatim)
Include a signal only if it is genuinely present. No signal is fine.

PROPOSALS — for a signal that clearly matches a track's PURPOSE (read its
description), propose activating that track:
- track_id: the EXACT id from the catalog. NEVER invent an id. Nothing fits -> propose nothing.
- confidence: 0..1 that this track is the right enrichment for this signal
- source_signal: the signal value it came from
A loose thematic association is NOT enough — the description must genuinely fit.

CALIBRATION. Prefer fewer, higher-confidence outputs. If you cannot justify a
signal or proposal from the exact words, leave it out. `relevant: false` is a
successful classification.

Return ONLY the JSON object in the required shape. No preamble.$sys$,
  $schema${
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "relevant": { "type": "boolean" },
      "signals": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "type": { "type": "string" },
            "value": { "type": "string" },
            "confidence": { "type": "number" },
            "evidence_span": { "type": "string" }
          },
          "required": ["type", "value", "confidence", "evidence_span"]
        }
      },
      "proposed_enrichments": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "track_id": { "type": "string" },
            "confidence": { "type": "number" },
            "source_signal": { "type": "string" }
          },
          "required": ["track_id", "confidence", "source_signal"]
        }
      }
    },
    "required": ["relevant", "signals", "proposed_enrichments"]
  }$schema$::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM prompts WHERE prompt_type = 'classify_update' AND is_active = true
);

COMMIT;
