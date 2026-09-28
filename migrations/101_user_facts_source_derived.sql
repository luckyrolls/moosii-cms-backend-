-- ============================================================================
-- MIGRATION 101: user_facts.source += 'derived', 'estimated' — BOTH PROJECTS (schema)
--   — APPLIED financial 2026-09-28 · APPLIED Moosii 2026-09-28
-- ============================================================================
-- WHY (FINDINGS-fact-derivation §8; decision Mark 2026-09-28): the derive_facts job computes facts
-- from MX account/transaction data. Those rows are not partner-supplied (platform_api), so they are
-- stamped 'derived' — or 'estimated' when an input was estimated (credit limit taken as
-- balance + available_credit because credit_limit was absent). 070's CHECK allows only
-- platform_api | cms | manual.
--
-- WHAT: DROP + ADD the CHECK in one transaction with the two extra values. Every existing row passes
-- (checked 2026-09-28: 0 user_facts rows on either project).
-- NOT CHANGED: POST /facts still accepts only platform_api | cms | manual (src/facts/validate.ts
-- FACT_SOURCES) — a partner cannot claim a derived fact; derived/estimated are internal-only.
-- BOTH PROJECTS: one schema (invariant 4). Moosii has no facts; harmless there.
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD.
-- APPLY per migrations/README.md: financial first, then Moosii.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT the 3-value CHECK; and 0 rows outside the new set:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'user_facts_source_valid';
--   SELECT count(*) FROM user_facts
--    WHERE source <> ALL (ARRAY['platform_api','cms','manual','derived','estimated']);
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE public.user_facts DROP CONSTRAINT IF EXISTS user_facts_source_valid;
ALTER TABLE public.user_facts ADD CONSTRAINT user_facts_source_valid
  CHECK (source = ANY (ARRAY['platform_api'::text, 'cms'::text, 'manual'::text, 'derived'::text, 'estimated'::text]));

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION:
-- 1. The PRE-CHECK query shows the 5-value CHECK.
-- 2. Rolled back: an INSERT with source 'estimated' succeeds; one with source 'guessed' fails 23514.
-- ---------------------------------------------------------------------------
