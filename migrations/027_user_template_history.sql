-- ============================================================================
-- Migration 027: user_template_history — last-served ack variant per (user, key)
-- ============================================================================
-- Minimal state for ack-variant selection (slice 4): remembers the last
-- response_templates variant served to a user for a given key, so the backend can
-- exclude it from the next random draw and acks don't repeat back-to-back. One row
-- per (user_id, key), upserted at response assembly.
--
-- last_variant_id is a SOFT marker (no FK): if a template variant is later deleted,
-- the stale marker simply won't match any active row on the next draw — harmless. RLS
-- enabled, NO policy: backend/service-role only (internal selection state, not
-- app-readable). All history I/O in code is non-fatal — a missing table or failed
-- write only means an ack might repeat, never a broken classification.
--
-- Flag: regenerate database.types.ts after apply (user_template_history).
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..027 reconciliation list.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_template_history (
  user_id         uuid not null,
  key             text not null,
  last_variant_id uuid not null,
  updated_at      timestamptz not null default now(),
  primary key (user_id, key)
);

ALTER TABLE user_template_history ENABLE ROW LEVEL SECURITY;

COMMIT;
