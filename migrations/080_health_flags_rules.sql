-- ============================================================================
-- MIGRATION 080 (child health H1): health_red_flags + health_urgency_rules — APPLIED financial 2026-09-15 · PENDING moosii
-- ============================================================================
-- Child health in classify (docs/drafts/child-health/PROPOSAL.md; decided by Mark 2026-09-15).
-- The classifier EXTRACTS red-flag findings from a parent's update; CODE decides the urgency
-- band from the classified child's age and these rules. Keeping the vocabulary and thresholds
-- in rows means the clinical owner edits data, not prompts or code.
--
--   health_red_flags      the vocabulary rendered into the classifier's user message
--   health_urgency_rules  flag + age range [min, max) months + optional minimum temperature (°C)
--                         + optional minimum duration (hours) -> band
--
-- Everything clinical is is_provisional = true and carries source_ref (the AAP page and phrase),
-- awaiting review (docs/provisional-clinical-decisions.md H-D1..H-D9).
--
-- RLS: signed-in users read (reference content, like distress_responses 025); writes need
-- is_admin() (the CMS editor), as response_templates (026).
--
-- BOTH projects (schema parity). Seeds are 082, Moosii only.
-- APPLY per migrations/README.md (Claude, psql, after Mark's go): financial, then Moosii.
-- Idempotent: IF NOT EXISTS / DROP POLICY IF EXISTS.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — EXPECT both NULL:
--   SELECT to_regclass('public.health_red_flags'), to_regclass('public.health_urgency_rules');
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS public.health_red_flags (
  key              text        PRIMARY KEY,
  label            text        NOT NULL,
  description      text        NOT NULL,   -- rendered into the classifier prompt: what counts
  uses_temperature boolean     NOT NULL DEFAULT false,
  uses_duration    boolean     NOT NULL DEFAULT false,
  is_active        boolean     NOT NULL DEFAULT true,
  is_provisional   boolean     NOT NULL DEFAULT true,
  source_ref       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_red_flags_key_shape CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$')
);

CREATE TABLE IF NOT EXISTS public.health_urgency_rules (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key           text        NOT NULL,   -- stable natural key (seeds + CMS)
  red_flag_key       text        NOT NULL,
  min_age_months     integer     NOT NULL DEFAULT 0,
  max_age_months     integer,                -- EXCLUSIVE; NULL = no upper bound
  min_temperature_c  numeric(4,1),
  min_duration_hours integer,
  band               text        NOT NULL,
  is_active          boolean     NOT NULL DEFAULT true,
  is_provisional     boolean     NOT NULL DEFAULT true,
  source_ref         text        NOT NULL,   -- the AAP page + the phrase this rule encodes
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT health_urgency_rules_rule_key_uq UNIQUE (rule_key),
  CONSTRAINT health_urgency_rules_flag_fkey
    FOREIGN KEY (red_flag_key) REFERENCES public.health_red_flags (key) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT health_urgency_rules_band_valid CHECK (band IN ('emergency', 'same_day', 'routine')),
  CONSTRAINT health_urgency_rules_min_age_valid CHECK (min_age_months >= 0),
  CONSTRAINT health_urgency_rules_age_range_valid CHECK (max_age_months IS NULL OR max_age_months > min_age_months),
  CONSTRAINT health_urgency_rules_temperature_valid CHECK (min_temperature_c IS NULL OR min_temperature_c BETWEEN 35 AND 43),
  CONSTRAINT health_urgency_rules_duration_valid CHECK (min_duration_hours IS NULL OR min_duration_hours > 0)
);

CREATE INDEX IF NOT EXISTS health_urgency_rules_flag_active_idx
  ON public.health_urgency_rules (red_flag_key) WHERE is_active;

COMMENT ON TABLE public.health_red_flags IS
  'Child-health red-flag vocabulary rendered into the classify_update prompt (migration 080). PROVISIONAL clinical content.';
COMMENT ON TABLE public.health_urgency_rules IS
  'flag + age [min,max) months + optional min temperature C / min duration h -> band (migration 080). '
  'Highest band across matching rules wins. PROVISIONAL — see provisional-clinical-decisions.md H-D1..H-D5.';

ALTER TABLE public.health_red_flags     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_urgency_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS health_red_flags_authenticated_read ON public.health_red_flags;
CREATE POLICY health_red_flags_authenticated_read ON public.health_red_flags
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS health_red_flags_admin_write ON public.health_red_flags;
CREATE POLICY health_red_flags_admin_write ON public.health_red_flags
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS health_urgency_rules_authenticated_read ON public.health_urgency_rules;
CREATE POLICY health_urgency_rules_authenticated_read ON public.health_urgency_rules
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS health_urgency_rules_admin_write ON public.health_urgency_rules;
CREATE POLICY health_urgency_rules_admin_write ON public.health_urgency_rules
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

COMMIT;

-- ============================================================================
-- VERIFICATION — both tables exist with RLS on and two policies each; a rule with an invalid
-- band, an inverted age range or an unknown flag is refused (run in a transaction, ROLLBACK).
-- ============================================================================
