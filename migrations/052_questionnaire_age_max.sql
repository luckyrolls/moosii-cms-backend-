-- ============================================================================
-- Migration 052: questionnaire age CEILING (age_max) — column + CHECK (APPLIED)
-- ============================================================================
-- APPLIED via the Supabase SQL editor (2026-08-03), ahead of being filed — this file is
-- the reconciliation record. On the 008..052 reconciliation list. IDEMPOTENT: written
-- with IF NOT EXISTS / DROP-then-ADD CONSTRAINT so a re-run is a safe no-op (the column
-- and CHECK already exist live; verified by column probe + constraint confirmation).
--
-- WHY. The check-in model wanted a "go quiet after a while" ceiling. `questionnaire.age`
-- is the existing LOWER gate ("eligible once the youngest child reaches this age",
-- wired into mlp_item_pool as min_child_age by 041, carried in 046). `age_max` is the
-- UPPER bound counterpart.
--
-- SEMANTICS. NULL = NO ceiling — byte-identical to existing behaviour (an age_max IS NULL
-- questionnaire gates exactly as today, on the lower bound only). The CHECK forbids an
-- inverted range (a ceiling at/below the floor).
--
-- SCOPE. This migration ONLY adds the column + CHECK. Teaching the pool filter to honour
-- the ceiling is a SEPARATE slice: it maps `q.age_max AS max_child_age` in the
-- mlp_item_pool view (currently `NULL::integer`, migration 046's questionnaire arm). Once
-- that lands, BOTH the MLP pool filter AND questionnaireStatus's age_gated flag honour it
-- automatically — they share the single isAgeEligible predicate. Do NOT implement the
-- filter here.
-- ============================================================================

BEGIN;

ALTER TABLE questionnaire ADD COLUMN IF NOT EXISTS age_max integer;

-- CHECK transcribed verbatim from the confirmed live definition:
ALTER TABLE questionnaire DROP CONSTRAINT IF EXISTS questionnaire_age_max_valid;
ALTER TABLE questionnaire ADD CONSTRAINT questionnaire_age_max_valid
  CHECK (age_max IS NULL OR age IS NULL OR age_max > age);

COMMIT;
