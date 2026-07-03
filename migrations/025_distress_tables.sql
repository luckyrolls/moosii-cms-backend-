-- ============================================================================
-- Migration 025: distress response content + audit + event tier (slice B)
-- ============================================================================
-- Three things:
--   1. distress_responses — reference content, ONE row per non-none tier. Copy is
--      PROVISIONAL (is_provisional=true) — editable by the clinical owner without
--      code changes. RLS enabled + authenticated SELECT (reference content).
--   2. distress_detections — the safety AUDIT log (item-10 analog) on a PERSISTED
--      classification: one row per strain+ detection OR per UNREADABLE assessment
--      (parse_failed, tier defaulted to none after classifier retries). Silent none
--      is NOT recordable (a row is a real detection or a parse failure) — that is the
--      distinction the audit exists to keep. RLS enabled, NO public policy —
--      backend/service-role only (sensitive).
--   3. user_update_events.distress_tier — every persisted classification records its
--      tier here (none included); the event self-describes.
--
-- Resource numbers VERIFIED CURRENT 2026-07-03 (re-verify for staleness):
--   988 Suicide & Crisis Lifeline  — call/text 988 (24/7)
--   PSI HelpLine                   — 1-800-944-4773 (NOT a crisis line)
--   Nat'l Maternal MH Hotline      — 1-833-852-6262 (call/text, 24/7)
-- Copy + tier boundaries are PROVISIONAL — see docs/provisional-clinical-decisions.md
-- (safety-tier intrusive-thoughts wording is flagged TOP priority for review).
--
-- Flag: regenerate database.types.ts after apply (distress_responses,
-- distress_detections, user_update_events.distress_tier).
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..025 reconciliation list.
-- ============================================================================

BEGIN;

-- 1. Response content -------------------------------------------------------
CREATE TABLE IF NOT EXISTS distress_responses (
  id             uuid primary key default gen_random_uuid(),
  tier           text unique not null check (tier in ('strain','overwhelm','safety')),
  message        text not null,
  resources      jsonb not null default '[]'::jsonb,  -- [{label, value, kind: phone|text|url}]
  is_provisional boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

INSERT INTO distress_responses (tier, message, resources) VALUES
(
  'strain',
  $m$This sounds like a genuinely hard stretch. Being this tired and stretched thin is real, and it doesn't mean you're doing anything wrong. Be gentle with yourself today, and lean on someone if you can — you don't have to carry all of it at once.$m$,
  '[{"label":"Postpartum Support International HelpLine (call or text)","value":"1-800-944-4773","kind":"phone"}]'::jsonb
),
(
  'overwhelm',
  $m$It sounds like you're carrying more than anyone should have to right now — more than an ordinary hard day. You are not failing, and you are not alone in this. Support from someone trained in exactly this can help; please consider reaching out today.$m$,
  '[{"label":"National Maternal Mental Health Hotline (call or text, 24/7)","value":"1-833-852-6262","kind":"phone"},{"label":"Postpartum Support International HelpLine","value":"1-800-944-4773","kind":"phone"}]'::jsonb
),
(
  'safety',
  $m$What you wrote matters, and you deserve support right now. If you're having thoughts of harming yourself or your baby, or feeling that you might not want to be here, please reach out this moment — you can call or text someone trained to help, any time, for free. You are not alone, and reaching out is a strong thing to do.$m$,
  '[{"label":"988 Suicide & Crisis Lifeline (call or text 988, 24/7)","value":"988","kind":"phone"},{"label":"988 Crisis Text (text 988)","value":"988","kind":"text"},{"label":"National Maternal Mental Health Hotline (24/7)","value":"1-833-852-6262","kind":"phone"}]'::jsonb
)
ON CONFLICT (tier) DO NOTHING;

ALTER TABLE distress_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS distress_responses_authenticated_read ON distress_responses;
CREATE POLICY distress_responses_authenticated_read
  ON distress_responses FOR SELECT TO authenticated USING (true);

-- 2. Distress audit log -----------------------------------------------------
-- One row per NOTABLE distress event: a strain+ detection, OR an UNREADABLE
-- assessment (parse_failed = true, tier defaulted to 'none' after the classifier
-- retries were exhausted). The row-level check forbids a plain 'none' row — a row
-- is EITHER a real strain+ detection OR a parse failure, never silent none. This is
-- the distinction a safety audit exists to preserve: "assessed none" (no row) vs
-- "we couldn't read the assessment" (parse_failed row).
CREATE TABLE IF NOT EXISTS distress_detections (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid references user_update_events(id) on delete cascade,
  user_id        uuid not null,
  child_id       uuid,
  tier           text not null check (tier in ('none','strain','overwhelm','safety')),
  parse_failed   boolean not null default false,
  evidence_span  text,
  correlation_id uuid,
  created_at     timestamptz not null default now(),
  check (parse_failed or tier <> 'none')  -- a row is a real detection OR a parse failure
);
CREATE INDEX IF NOT EXISTS distress_detections_tier_idx ON distress_detections (tier);
CREATE INDEX IF NOT EXISTS distress_detections_event_idx ON distress_detections (event_id);
CREATE INDEX IF NOT EXISTS distress_detections_parsefail_idx ON distress_detections (parse_failed) WHERE parse_failed;

-- RLS on, NO policy: backend/service-role only (the service role bypasses RLS).
-- This is a sensitive safety audit — locked to backend by default.
ALTER TABLE distress_detections ENABLE ROW LEVEL SECURITY;

-- 3. Tier on the event ------------------------------------------------------
ALTER TABLE user_update_events ADD COLUMN IF NOT EXISTS distress_tier text;
COMMENT ON COLUMN user_update_events.distress_tier IS
  'Distress tier of this classification (none|strain|overwhelm|safety). Set when '
  'persist=true. Provisional — see docs/provisional-clinical-decisions.md.';

COMMIT;
