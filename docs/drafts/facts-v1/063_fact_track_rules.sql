-- ============================================================================
-- DRAFT 063: fact_track_rules — (fact_key, value) → track (NOT APPLIED)
-- ============================================================================
-- RATIONALE: the direct analogue of demographic_track_rules (migration 008): a bare
-- mapping table, CMS-authored, no is_active flag, no weight, no ordering. A user gets
-- the track when their LATEST value for the key matches a rule. Resolution stays
-- DERIVED — this table is config, never per-user state.
--
-- Same retroactive semantics as the demographic rules (api-contract.md §5): editing
-- rules is NOT inert history. Deleting a rule removes that track from every matching
-- user's plan on their next recompute. That is intended and matches how every other
-- activation source in this system behaves.
--
-- ON DELETE RESTRICT on track_id follows migration 040's rule — "a track deletes only
-- when BARE". A track still targeted by a fact rule raises 23001 rather than silently
-- losing the rule.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — after 060 (needs fact_values). Independent of
-- 061/062; must precede 065.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.fact_track_rules (
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  fact_key   text        NOT NULL,
  value      text        NOT NULL,
  track_id   uuid        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,                    -- admin uid from the verified JWT; NO FK, like content_approvals
  CONSTRAINT fact_track_rules_pkey PRIMARY KEY (id),

  -- The pair must be authored vocabulary — a rule can never target a value a fact
  -- cannot hold. RESTRICT so a value in use by a rule cannot be deleted.
  CONSTRAINT fact_track_rules_value_fkey
    FOREIGN KEY (fact_key, value) REFERENCES public.fact_values (fact_key, value)
    ON UPDATE CASCADE ON DELETE RESTRICT,

  CONSTRAINT fact_track_rules_track_id_fkey
    FOREIGN KEY (track_id) REFERENCES public.tracks (id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,

  -- No duplicate (pair → track) mappings. Mirrors demographic_track_rules' UNIQUE.
  -- Several DIFFERENT pairs may grant the SAME track; that is a UNION, not a conflict.
  CONSTRAINT fact_track_rules_unique UNIQUE (fact_key, value, track_id)
);

CREATE INDEX IF NOT EXISTS fact_track_rules_track_id_idx ON public.fact_track_rules (track_id);
CREATE INDEX IF NOT EXISTS fact_track_rules_pair_idx     ON public.fact_track_rules (fact_key, value);

COMMENT ON TABLE public.fact_track_rules IS
  'CMS-authored (fact_key, value) -> track_id mapping (facts v1, migration 063). Read by '
  'the fact arm of user_active_tracks_for_user + its view twin (065). RETROACTIVE: '
  'adding/removing a rule changes matching users on their next recompute.';

-- RLS — config table, backend-mediated (same posture as 060).
ALTER TABLE public.fact_track_rules ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying:
--   -- rejected: value not in the vocabulary
--   INSERT INTO fact_track_rules (fact_key, value, track_id)
--     VALUES ('credit_utilization_band', 'nonsense', '<track uuid>');   -- FK violation
--   -- rejected: deleting a track that a rule still targets
--   DELETE FROM tracks WHERE id = '<track uuid>';                        -- 23001 restrict_violation
-- ============================================================================
