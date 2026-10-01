-- ============================================================================
-- MIGRATION 106: demo outcomes (Beat 6) — demo_outcome_series + demo_outcome_aggregate + seed
--   *** FINANCIAL ONLY ***   — APPLIED financial (2026-10-01)
-- ============================================================================
-- WHY (FINDINGS-demo-personas §3; brief Mark 2026-10-01): the demo needs an outcome story ("six weeks later
-- the utilization band moved down") without lying in the fact log. Future-dated user_facts rows would become
-- the user's CURRENT value (user_facts_latest is latest-wins, no <= now() filter) and change their plan
-- (invariant 8). So seeded points live in their own labeled table and are NEVER written to user_facts.
--
-- WHAT:
--   demo_outcome_series    (user_id → auth.users CASCADE, fact_key + value → fact_values RESTRICT, so values are
--                           vocabulary tokens and no amount is possible (invariant 12), observed_at (may be in the
--                           future — this table drives nothing), label (must say "seeded")).
--   demo_outcome_aggregate (metric PK, value int, label (must say "seeded")) — illustrative figures, not computed.
--   RLS ON with NO policy and no anon/authenticated grants: service role only. Read through
--   GET /demo/outcomes (api-contract §9b), which tags every point real | seeded.
--   Seed (relative to the apply date, noon UTC):
--     Sam   credit_utilization_band 'moderate' at +42 d — "six weeks later (projected, seeded)"
--     Sarah has_emergency_buffer 'false' at −30 d — "a month ago (seeded)"; 'true' at +21 d — "in three weeks (projected, seeded)"
--     aggregate started_credit_health 120; moved_down_band_30d_pct 41
--   Personas are resolved by auth app_metadata.demo_persona (exactly one user each, else RAISE).
-- Idempotent: CREATE … IF NOT EXISTS; a persona's series is seeded only if it has none; aggregate ON CONFLICT DO NOTHING.
-- Not mirrored to Moosii: no demo there. database.types.ts (generated from Moosii) will not carry these tables.
-- APPLY per migrations/README.md: FINANCIAL ONLY.
-- ============================================================================

BEGIN;

DO $guard$
BEGIN
  IF (SELECT value FROM public.app_settings WHERE key = 'domain') IS DISTINCT FROM 'financial' THEN
    RAISE EXCEPTION '106 is FINANCIAL ONLY — app_settings.domain is %', (SELECT value FROM public.app_settings WHERE key = 'domain');
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.demo_outcome_series (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fact_key    text NOT NULL,
  value       text NOT NULL,
  observed_at timestamptz NOT NULL,
  label       text NOT NULL DEFAULT 'seeded' CONSTRAINT demo_outcome_series_label_seeded CHECK (label ~* 'seeded'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT demo_outcome_series_fact_value_fk FOREIGN KEY (fact_key, value)
    REFERENCES public.fact_values (fact_key, value) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS demo_outcome_series_user_idx ON public.demo_outcome_series (user_id, fact_key, observed_at);

CREATE TABLE IF NOT EXISTS public.demo_outcome_aggregate (
  metric     text PRIMARY KEY CONSTRAINT demo_outcome_aggregate_metric_token CHECK (metric ~ '^[a-z][a-z0-9_]{0,63}$'),
  value      integer NOT NULL,
  label      text NOT NULL DEFAULT 'seeded' CONSTRAINT demo_outcome_aggregate_label_seeded CHECK (label ~* 'seeded'),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.demo_outcome_series    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demo_outcome_aggregate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.demo_outcome_series, public.demo_outcome_aggregate FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.demo_outcome_series, public.demo_outcome_aggregate TO service_role;

DO $seed$
DECLARE
  v_sam   uuid;
  v_sarah uuid;
  v_noon  timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '12 hours';
  n int;
BEGIN
  SELECT count(*), max(id::text)::uuid INTO n, v_sam FROM auth.users WHERE raw_app_meta_data->>'demo_persona' = 'sam';
  IF n <> 1 THEN RAISE EXCEPTION '106: expected exactly 1 user with demo_persona sam, found %', n; END IF;
  SELECT count(*), max(id::text)::uuid INTO n, v_sarah FROM auth.users WHERE raw_app_meta_data->>'demo_persona' = 'sarah';
  IF n <> 1 THEN RAISE EXCEPTION '106: expected exactly 1 user with demo_persona sarah, found %', n; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.demo_outcome_series WHERE user_id = v_sam) THEN
    INSERT INTO public.demo_outcome_series (user_id, fact_key, value, observed_at, label) VALUES
      (v_sam, 'credit_utilization_band', 'moderate', v_noon + interval '42 days', 'six weeks later (projected, seeded)');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.demo_outcome_series WHERE user_id = v_sarah) THEN
    INSERT INTO public.demo_outcome_series (user_id, fact_key, value, observed_at, label) VALUES
      (v_sarah, 'has_emergency_buffer', 'false', v_noon - interval '30 days', 'a month ago (seeded)'),
      (v_sarah, 'has_emergency_buffer', 'true',  v_noon + interval '21 days', 'in three weeks (projected, seeded)');
  END IF;
END
$seed$;

INSERT INTO public.demo_outcome_aggregate (metric, value, label) VALUES
  ('started_credit_health',   120, 'seeded'),
  ('moved_down_band_30d_pct',  41, 'seeded')
ON CONFLICT (metric) DO NOTHING;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION:
-- 1. Sam 1 series row, Sarah 2, aggregate 2; user_facts row count unchanged.
-- 2. RLS on both tables, 0 policies; as `authenticated` (Sam's claims) and as `anon`: permission denied / 0 rows.
-- 3. Rolled back: a series row with value '1200' → 23503 (not vocabulary); label 'projected' → 23514.
-- UNDO: DROP TABLE public.demo_outcome_series, public.demo_outcome_aggregate;
-- ---------------------------------------------------------------------------
