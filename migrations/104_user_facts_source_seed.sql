-- ============================================================================
-- MIGRATION 104: user_facts.source += 'seed' — BOTH PROJECTS (schema)
--   — APPLIED financial 2026-09-28 · APPLIED Moosii 2026-09-28
-- ============================================================================
-- WHY (FINDINGS-demo-personas §2, renumbered; decision Mark 2026-09-28): the demo persona Sarah gets
-- SEEDED facts (not partner-supplied, not derived from bank data). They must be labeled as such so the
-- outcomes view and any audit can tell them apart: source 'seed', source_ref 'demo-seed', written by the
-- seed_facts job (financial only, demo personas only — api-contract §8e).
--
-- WHAT: DROP + ADD the CHECK in one transaction with 'seed' added (101 added derived + estimated).
-- NOT CHANGED: POST /facts still accepts only platform_api | cms | manual (src/facts/validate.ts).
-- BOTH PROJECTS: one schema (invariant 4). Moosii has no facts; harmless there.
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD.
-- APPLY per migrations/README.md: financial first, then Moosii.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT the 5-value CHECK (101); and 0 rows outside the new set:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'user_facts_source_valid';
--   SELECT count(*) FROM user_facts
--    WHERE source <> ALL (ARRAY['platform_api','cms','manual','derived','estimated','seed']);
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE public.user_facts DROP CONSTRAINT IF EXISTS user_facts_source_valid;
ALTER TABLE public.user_facts ADD CONSTRAINT user_facts_source_valid
  CHECK (source = ANY (ARRAY['platform_api'::text, 'cms'::text, 'manual'::text, 'derived'::text, 'estimated'::text, 'seed'::text]));

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION:
-- 1. The PRE-CHECK query shows the 6-value CHECK.
-- 2. Rolled back: an INSERT with source 'seed' passes the CHECK; 'guessed' fails 23514.
-- ---------------------------------------------------------------------------
