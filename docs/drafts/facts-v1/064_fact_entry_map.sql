-- ============================================================================
-- DRAFT 064: fact_entry_map — (fact_key, value) → ONE lesson or segment (NOT APPLIED)
-- ============================================================================
-- RATIONALE: a track is the broad response to a fact (063); this is the NARROW one —
-- "this exact fact should drop the user at this exact piece of content". Distinct from
-- the track rule and deliberately separate: a fact may have a track, an entry point,
-- both, or neither.
--
-- EXACTLY-ONE TARGET IS STRUCTURAL, copying the content_images one-owner precedent
-- (`num_nonnulls(...) = 1`, api-contract.md §5): a row with two targets, or none, cannot
-- exist. No app code has to decide which pointer to trust.
--
-- ONE entry point per (fact_key, value) — a fact that means two different "start here"
-- answers is an authoring error, not a fan-out, so it is a UNIQUE, not a free list.
--
-- ⚠ NOTE — nothing READS this table in v1. It is authored config for a consumer that
-- does not exist yet (the MLP does not currently accept a forced entry point; that is a
-- separate slice with real ranking implications). It is included here because the shape
-- is decided and the CMS can start authoring against it. Flagged so nobody assumes
-- writing a row changes a plan today.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — after 060 (needs fact_values). Independent of
-- 061/062/063/065.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.fact_entry_map (
  id         uuid        NOT NULL DEFAULT gen_random_uuid(),
  fact_key   text        NOT NULL,
  value      text        NOT NULL,
  lesson_id  uuid,
  segment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,                    -- admin uid from the verified JWT; NO FK
  CONSTRAINT fact_entry_map_pkey PRIMARY KEY (id),

  CONSTRAINT fact_entry_map_value_fkey
    FOREIGN KEY (fact_key, value) REFERENCES public.fact_values (fact_key, value)
    ON UPDATE CASCADE ON DELETE RESTRICT,

  CONSTRAINT fact_entry_map_lesson_id_fkey
    FOREIGN KEY (lesson_id) REFERENCES public.lessons (id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  CONSTRAINT fact_entry_map_segment_id_fkey
    FOREIGN KEY (segment_id) REFERENCES public.segments (id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,

  -- EXACTLY ONE target — the content_images one-owner pattern.
  CONSTRAINT fact_entry_map_one_target CHECK (num_nonnulls(lesson_id, segment_id) = 1),

  -- One entry point per authored pair.
  CONSTRAINT fact_entry_map_one_per_value UNIQUE (fact_key, value)
);

CREATE INDEX IF NOT EXISTS fact_entry_map_lesson_id_idx  ON public.fact_entry_map (lesson_id)  WHERE lesson_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS fact_entry_map_segment_id_idx ON public.fact_entry_map (segment_id) WHERE segment_id IS NOT NULL;

COMMENT ON TABLE public.fact_entry_map IS
  'CMS-authored (fact_key, value) -> exactly one lesson OR segment (facts v1, migration '
  '064). Direct entry point for a fact. NOT read by anything in v1 — the MLP has no '
  'forced-entry mechanism yet; this is authoring config ahead of that slice.';

-- RLS — config table, backend-mediated (same posture as 060/063).
ALTER TABLE public.fact_entry_map ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying:
--   INSERT INTO fact_entry_map (fact_key, value, lesson_id, segment_id)
--     VALUES ('wants_debt_payoff_plan','true','<lesson uuid>','<segment uuid>'); -- FAILS (two targets)
--   INSERT INTO fact_entry_map (fact_key, value) VALUES ('wants_debt_payoff_plan','true'); -- FAILS (no target)
--   INSERT INTO fact_entry_map (fact_key, value, lesson_id)
--     VALUES ('wants_debt_payoff_plan','true','<lesson uuid>');                  -- OK
-- ============================================================================
