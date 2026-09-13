-- ============================================================================
-- DRAFT 072: fact_track_rules — (fact_key, value) → track (NOT APPLIED)
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
-- when BARE". A track still targeted by a fact rule is REFUSED rather than silently
-- losing the rule. ⚠ The refusal's SQLSTATE is 23503 (foreign_key_violation), the same code
-- NO ACTION raises — NOT the 23001 that migration 038, CLAUDE.md and api-contract.md claim.
-- Measured on real PostgreSQL 17.11 (2026-09-12): RESTRICT -> 23503, NO ACTION -> 23503.
-- 038's "verified" was pglite. Catch 23503.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — after 069 (needs fact_values). Independent of
-- 070/071; must precede 074.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST.
-- 1. 069 is applied (rules FK the composite) — EXPECT not NULL:
--    SELECT to_regclass('public.fact_values');
-- 2. The table name is free — EXPECT NULL:
--    SELECT to_regclass('public.fact_track_rules');
-- 3. The live tracks table still has the `id` target and the 040 RESTRICT posture on its
--    other config FKs (so a track stays deletable only when bare):
--    SELECT conname FROM pg_constraint
--     WHERE confrelid = 'public.tracks'::regclass AND confdeltype = 'r' ORDER BY 1;
--    EXPECT at least one row (040's RESTRICT FKs). Zero rows means the "bare track" posture
--    has changed since 040 — stop and ask before adding another RESTRICT FK to tracks.
-- ---------------------------------------------------------------------------

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
  'CMS-authored (fact_key, value) -> track_id mapping (facts v1, migration 072). Read by '
  'the fact arm of user_active_tracks_for_user + its view twin (074). RETROACTIVE: '
  'adding/removing a rule changes matching users on their next recompute.';

-- RLS — config table, backend-mediated (same posture as 069).
ALTER TABLE public.fact_track_rules ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying:
--   -- rejected: value not in the vocabulary
--   INSERT INTO fact_track_rules (fact_key, value, track_id)
--     VALUES ('credit_utilization_band', 'nonsense', '<track uuid>');   -- FK violation
--   -- rejected: deleting a track that a rule still targets
--   DELETE FROM tracks WHERE id = '<track uuid>';                        -- 23503, refused by RESTRICT
-- ============================================================================
