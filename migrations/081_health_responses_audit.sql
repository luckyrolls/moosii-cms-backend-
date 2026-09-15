-- ============================================================================
-- MIGRATION 081 (child health H3): health_responses, health_detections, event band, distress
-- downgrade marker — APPLIED financial 2026-09-15 · APPLIED moosii 2026-09-15
-- ============================================================================
-- Schema only; the provisional copy is seeded in 082 (Moosii only). Applied BEFORE 082, which
-- needs health_responses.
--
--   health_responses   ONE fixed row per band (never a random variant — urgent copy must not vary).
--                      Signed-in read, is_admin() write, like distress_responses (025/026).
--   health_detections  the child-health AUDIT, backend-only (RLS on, NO policy). One row per
--                      persisted classification with a band OR an unreadable assessment —
--                      never a silent "no concern" row (same discipline as distress_detections).
--   user_update_events.health_band   every persisted classification records its band (NULL = none).
--   distress_detections.downgraded_from   the code backstop that narrows strain/overwhelm on
--                      symptom-only evidence (decision D2/D4 proposed change) is AUDITED: a
--                      downgrade writes a row with tier 'none' + downgraded_from. 'safety' can never
--                      appear here — safety is never downgraded. The 025 row check is rewritten to
--                      admit a downgrade row while still refusing a plain silent-none row.
--
-- BOTH projects (schema parity).
-- APPLY per migrations/README.md (Claude, psql, after Mark's go): financial, then Moosii.
-- Idempotent: IF NOT EXISTS, and the constraint swap is guarded on pg_constraint.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK
-- 1. EXPECT both NULL:  SELECT to_regclass('public.health_responses'), to_regclass('public.health_detections');
-- 2. EXPECT false:      SELECT EXISTS (SELECT 1 FROM information_schema.columns
--                         WHERE table_name = 'user_update_events' AND column_name = 'health_band');
-- 3. The 025 check is still the unnamed default — EXPECT 'CHECK ((parse_failed OR (tier <> ''none''::text)))':
--    SELECT pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conrelid = 'public.distress_detections'::regclass AND conname = 'distress_detections_check';
-- ---------------------------------------------------------------------------

BEGIN;

-- 1. Fixed response per band ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.health_responses (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  band           text        NOT NULL,
  message        text        NOT NULL,
  resources      jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- [{label, value, kind: phone|text|url}]
  is_provisional boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_responses_band_uq UNIQUE (band),
  CONSTRAINT health_responses_band_valid CHECK (band IN ('emergency', 'same_day', 'routine'))
);

ALTER TABLE public.health_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS health_responses_authenticated_read ON public.health_responses;
CREATE POLICY health_responses_authenticated_read ON public.health_responses
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS health_responses_admin_write ON public.health_responses;
CREATE POLICY health_responses_admin_write ON public.health_responses
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 2. Audit -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.health_detections (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid        REFERENCES public.user_update_events (id) ON DELETE CASCADE,
  user_id          uuid        NOT NULL,
  child_id         uuid,
  band             text,
  child_age_months integer,                              -- NULL = unknown age (H-D3 applied)
  findings         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  matched_rule_ids uuid[]      NOT NULL DEFAULT '{}',
  unmatched_flags  text[]      NOT NULL DEFAULT '{}',    -- recognised flag, no rule at this age (seed gap)
  unknown_flags    text[]      NOT NULL DEFAULT '{}',    -- key not in the vocabulary (dropped)
  rules_version    text,
  parse_failed     boolean     NOT NULL DEFAULT false,
  correlation_id   uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_detections_band_valid CHECK (band IS NULL OR band IN ('emergency', 'same_day', 'routine')),
  CONSTRAINT health_detections_row_is_notable CHECK (parse_failed OR band IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS health_detections_band_idx  ON public.health_detections (band);
CREATE INDEX IF NOT EXISTS health_detections_event_idx ON public.health_detections (event_id);
CREATE INDEX IF NOT EXISTS health_detections_parsefail_idx ON public.health_detections (parse_failed) WHERE parse_failed;

-- RLS on, NO policy: backend/service-role only (sensitive, like distress_detections).
ALTER TABLE public.health_detections ENABLE ROW LEVEL SECURITY;

-- 3. Band on the event ---------------------------------------------------------------------------
ALTER TABLE public.user_update_events ADD COLUMN IF NOT EXISTS health_band text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.user_update_events'::regclass AND conname = 'user_update_events_health_band_valid') THEN
    ALTER TABLE public.user_update_events ADD CONSTRAINT user_update_events_health_band_valid
      CHECK (health_band IS NULL OR health_band IN ('emergency', 'same_day', 'routine'));
  END IF;
END $$;
COMMENT ON COLUMN public.user_update_events.health_band IS
  'Child-health urgency band of this classification (emergency|same_day|routine; NULL = no concern). '
  'Set when persist=true. Provisional — see provisional-clinical-decisions.md.';

-- 4. Distress downgrade marker ---------------------------------------------------------------------
ALTER TABLE public.distress_detections ADD COLUMN IF NOT EXISTS downgraded_from text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.distress_detections'::regclass AND conname = 'distress_detections_downgraded_from_valid') THEN
    ALTER TABLE public.distress_detections ADD CONSTRAINT distress_detections_downgraded_from_valid
      CHECK (downgraded_from IS NULL OR downgraded_from IN ('strain', 'overwhelm'));   -- never 'safety'
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.distress_detections'::regclass AND conname = 'distress_detections_row_is_notable') THEN
    ALTER TABLE public.distress_detections DROP CONSTRAINT IF EXISTS distress_detections_check;
    ALTER TABLE public.distress_detections ADD CONSTRAINT distress_detections_row_is_notable
      CHECK (parse_failed OR tier <> 'none' OR downgraded_from IS NOT NULL);
  END IF;
END $$;
COMMENT ON COLUMN public.distress_detections.downgraded_from IS
  'Set when the code backstop narrowed strain/overwhelm to none because the only evidence was child '
  'symptom wording (migration 081; D2/D4 proposed change). Never safety.';

COMMIT;

-- ============================================================================
-- VERIFICATION (in a transaction, ROLLBACK): a plain tier-none distress row is still refused; a
-- none row with downgraded_from='strain' is accepted; downgraded_from='safety' is refused; a
-- health_detections row with neither band nor parse_failed is refused; health_band 'urgent' is refused.
-- ============================================================================
