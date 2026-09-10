-- ============================================================================
-- DRAFT 060: fact vocabulary — fact_keys + fact_values (NOT APPLIED)
-- ============================================================================
-- RATIONALE: a fact's legal (key, value) pairs are a CLOSED, CMS-authored vocabulary,
-- so "is this a real fact?" is answered by a foreign key rather than by app code.
--
-- This is the structural home of the "no amounts, ever" rule. A value must be a short
-- lowercase token starting with a LETTER, which already excludes "1200", "$40", "12%";
-- a second CHECK rejects anything that starts numeric/currency even if the shape rule is
-- ever loosened. A boolean fact is just a key whose two allowed values are true/false.
--
-- Everything downstream (user_facts, fact_track_rules, fact_entry_map) FKs the COMPOSITE
-- (fact_key, value) defined here, so a rule can never target a value a fact cannot hold,
-- and a fact can never carry a value no one authored.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — FIRST in the facts-v1 set (060 → 065, then 066
-- seeds). Idempotent: IF NOT EXISTS throughout.
-- ============================================================================

BEGIN;

-- 1. The vocabulary of fact KEYS ---------------------------------------------
CREATE TABLE IF NOT EXISTS public.fact_keys (
  fact_key    text        NOT NULL,
  kind        text        NOT NULL,
  label       text        NOT NULL,          -- CMS display name
  description text,                          -- what the platform means by this fact
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz,
  CONSTRAINT fact_keys_pkey PRIMARY KEY (fact_key),
  -- Snake_case identifier, must start with a letter. Same shape rule the seed uses.
  CONSTRAINT fact_keys_shape CHECK (fact_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  -- Two kinds only. 'boolean' is a convention for the CMS (render a toggle); the DB
  -- still validates its values through fact_values like any enum.
  CONSTRAINT fact_keys_kind_valid CHECK (kind = ANY (ARRAY['boolean'::text, 'enum'::text]))
);

COMMENT ON TABLE public.fact_keys IS
  'CMS-authored vocabulary of platform-supplied fact keys (facts v1, migration 060). '
  'A fact is boolean or a short enum — never an amount. See fact_values for legal values.';

-- 2. The legal VALUES per key ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fact_values (
  fact_key   text        NOT NULL,
  value      text        NOT NULL,
  label      text        NOT NULL,           -- CMS display name for this value
  sort_order integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fact_values_pkey PRIMARY KEY (fact_key, value),
  CONSTRAINT fact_values_fact_key_fkey
    FOREIGN KEY (fact_key) REFERENCES public.fact_keys (fact_key)
    ON UPDATE CASCADE ON DELETE CASCADE,
  -- STRUCTURAL "no amounts" rule, part 1: a short lowercase token starting with a letter.
  CONSTRAINT fact_values_shape CHECK (value ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- Part 2 (defence in depth): never anything that opens numeric / signed / dollar.
  -- ASCII-only on purpose — a multibyte currency class survives neither copy-paste into
  -- the SQL editor nor a pg_dump round-trip reliably, and the shape rule above is the
  -- real guard (a leading letter is required, so "12", "$40", "0.82" are already out).
  CONSTRAINT fact_values_not_numeric CHECK (value !~ '^[[:space:]]*[+-]?[$]?[0-9]')
);

CREATE INDEX IF NOT EXISTS fact_values_fact_key_idx ON public.fact_values (fact_key);

COMMENT ON TABLE public.fact_values IS
  'Legal values per fact key (facts v1, migration 060). The composite (fact_key, value) '
  'is the FK target for user_facts, fact_track_rules and fact_entry_map — so an unknown '
  'or numeric-looking value is rejected by the database, not by app code.';

-- 3. RLS — config table, BACKEND-MEDIATED (docs/rls-sweep.md pattern) --------
-- The CMS reads/writes these THROUGH backend routes (service role bypasses RLS), so
-- default-deny with NO policy is correct: every anon/authenticated client is shut out
-- and nothing breaks. If the CMS ever writes these Supabase-direct (the screen_help
-- pattern) it needs an admin policy instead — a no-policy enable would deny the CMS too.
ALTER TABLE public.fact_keys   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fact_values ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying. Expect the two CHECKs to REJECT these:
--   INSERT INTO fact_keys (fact_key, kind, label) VALUES ('test_key','enum','t');
--   INSERT INTO fact_values (fact_key, value, label) VALUES ('test_key','1200','x'); -- FAILS (shape + numeric)
--   INSERT INTO fact_values (fact_key, value, label) VALUES ('test_key','$40','x');  -- FAILS
--   INSERT INTO fact_values (fact_key, value, label) VALUES ('test_key','low','Low'); -- OK
--   DELETE FROM fact_keys WHERE fact_key = 'test_key';   -- cleans up both
-- ============================================================================
