-- ============================================================================
-- DRAFT 075: seed the demo fact vocabulary (NOT APPLIED) — DATA ONLY
-- ============================================================================
-- RATIONALE: separate file from the DDL (069–074) because it is DATA, re-runnable, and
-- editable without touching schema. Seeds the six demo keys and their legal values only
-- — NO fact_track_rules and NO fact_entry_map rows, because which track each fact should
-- grant is a CONTENT decision for the financial catalog, which does not exist yet.
-- Authoring those is a CMS act, not a migration.
--
-- Every value here is a boolean or a short enum token. No amounts, no bands with numbers
-- in them — `credit_utilization_band` deliberately carries low/moderate/high rather than
-- any percentage, so the numeric thresholds stay on the PLATFORM side and never enter
-- this database. That is the whole point of the CHECK constraints in 069/070.
--
-- Idempotent: ON CONFLICT DO NOTHING throughout, so a re-run adds nothing and errors on
-- nothing.
--
-- ⚠ DECISION D6 — FINANCIAL ONLY? This file is DATA, not schema. The apply-both rule exists
-- to keep the SCHEMAS identical, and 069-074 do that on their own. RECOMMENDED: run 075 on
-- the FINANCIAL project only, so a future CMS vocabulary screen on Moosii does not list six
-- financial facts. Running it on Moosii as well is harmless — with no rules authored, the 074
-- arm stays a no-op — if symmetry matters more.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — after 069 (and, in practice, after the whole
-- 069–074 set).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST.
-- 1. 069 is applied — EXPECT not NULL:
--    SELECT to_regclass('public.fact_keys');
-- 2. Current vocabulary size — EXPECT 0 keys and 0 values on a first run. Any other number
--    is fine (the seed is ON CONFLICT DO NOTHING), but note it so the verification counts
--    below can be read as a delta:
--    SELECT (SELECT count(*) FROM fact_keys) AS keys, (SELECT count(*) FROM fact_values) AS vals;
-- ---------------------------------------------------------------------------

BEGIN;

-- ---- Keys -------------------------------------------------------------------
INSERT INTO public.fact_keys (fact_key, kind, label, description) VALUES
  ('credit_utilization_band', 'enum',    'Credit utilization band',
   'Banded credit utilization supplied by the platform. Bands only — never a percentage or amount.'),
  ('has_direct_deposit',      'boolean', 'Has direct deposit',
   'Platform observes a recurring payroll deposit.'),
  ('new_subscription_recent', 'boolean', 'New subscription recently',
   'Platform observed a new recurring subscription charge in its recent window.'),
  ('has_emergency_buffer',    'boolean', 'Has emergency buffer',
   'Platform judges the user to hold a cash buffer. Boolean by design — the threshold lives on the platform side.'),
  ('wants_debt_payoff_plan',  'boolean', 'Wants a debt payoff plan',
   'User-declared intent, forwarded by the platform.'),
  ('saving_for_home',         'boolean', 'Saving for a home',
   'User-declared goal, forwarded by the platform.')
ON CONFLICT (fact_key) DO NOTHING;

-- ---- Values -----------------------------------------------------------------
-- The one enum.
INSERT INTO public.fact_values (fact_key, value, label, sort_order) VALUES
  ('credit_utilization_band', 'low',      'Low',      1),
  ('credit_utilization_band', 'moderate', 'Moderate', 2),
  ('credit_utilization_band', 'high',     'High',     3)
ON CONFLICT (fact_key, value) DO NOTHING;

-- The five booleans. Both values are authored explicitly: 'false' is a REAL, assertable
-- fact ("the platform checked and there is no buffer"), NOT the absence of a fact.
-- Absence = no row in user_facts at all = unknown. Keeping those distinct is what lets a
-- fact CLEAR without being confused with never having been observed.
INSERT INTO public.fact_values (fact_key, value, label, sort_order) VALUES
  ('has_direct_deposit',      'true',  'Yes', 1),
  ('has_direct_deposit',      'false', 'No',  2),
  ('new_subscription_recent', 'true',  'Yes', 1),
  ('new_subscription_recent', 'false', 'No',  2),
  ('has_emergency_buffer',    'true',  'Yes', 1),
  ('has_emergency_buffer',    'false', 'No',  2),
  ('wants_debt_payoff_plan',  'true',  'Yes', 1),
  ('wants_debt_payoff_plan',  'false', 'No',  2),
  ('saving_for_home',         'true',  'Yes', 1),
  ('saving_for_home',         'false', 'No',  2)
ON CONFLICT (fact_key, value) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying. EXPECT 6 keys and 13 values.
--   SELECT k.fact_key, k.kind, count(v.value) AS values
--   FROM fact_keys k LEFT JOIN fact_values v USING (fact_key)
--   GROUP BY k.fact_key, k.kind ORDER BY k.fact_key;
-- ============================================================================
