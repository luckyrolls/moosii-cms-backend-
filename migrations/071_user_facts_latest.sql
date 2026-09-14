-- ============================================================================
-- MIGRATION 071: user_facts_latest — latest-wins resolution — APPLIED financial 2026-09-14 · PENDING moosii
-- ============================================================================
-- RATIONALE: "the user's current facts" is DERIVED from the append-only log, never
-- stored. Same discipline as user_active_tracks (derived) and milestone suppression
-- (computed fresh each rebuild, no state table) — nothing to keep in sync, nothing to
-- un-set, and a fact that CLEARS takes effect the moment the new observation lands.
--
-- ORDERING: observed_at DESC (what the platform says), then created_at DESC (when we
-- received it), then id DESC as a total-order tiebreak so the result is deterministic
-- even for two rows at the same instant. The 070 UNIQUE (user_id, fact_key, observed_at)
-- means the first key alone is almost always decisive.
--
-- SECURITY: a PLAIN view (runs with its owner's rights), locked to service_role by the
-- REVOKE/GRANT below (migration 057's precedent). The REVOKE is LOAD-BEARING: it is the only
-- thing between an anon/authenticated client and every user's facts, and a direct SELECT by
-- either is a permission error (tested).
--
-- ⚠ NOT security_invoker — that was the first draft, REJECTED after a local test (PG 17,
-- 2026-09-12). user_active_tracks (074) is itself a plain view, so its other arms read their
-- tables with the VIEW OWNER's rights. A security_invoker view nested inside it instead
-- applies user_facts' RLS as the CALLER, and for `authenticated` that RLS has no policy. The
-- fact arm therefore returned ZERO rows to an authenticated reader while every other arm
-- returned everything: fact-granted tracks silently vanished from the view by ROLE, with no
-- error, and the twins disagreed. A plain view keeps the fact arm on the same footing as the
-- other arms. Do not "harden" this back to security_invoker.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — after 070, before 074 (the arm reads this view).
-- Idempotent: CREATE OR REPLACE.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST.
-- 1. 070 is applied — EXPECT not NULL:
--    SELECT to_regclass('public.user_facts');
-- 2. The view name is free — EXPECT NULL:
--    SELECT to_regclass('public.user_facts_latest');
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE VIEW public.user_facts_latest AS
  SELECT DISTINCT ON (uf.user_id, uf.fact_key)
         uf.user_id,
         uf.fact_key,
         uf.value,
         uf.observed_at,
         uf.source,
         uf.source_ref,
         uf.id AS observation_id
  FROM public.user_facts uf
  ORDER BY uf.user_id, uf.fact_key, uf.observed_at DESC, uf.created_at DESC, uf.id DESC;

COMMENT ON VIEW public.user_facts_latest IS
  'Latest-wins current value per (user_id, fact_key) over the user_facts log (facts v1, '
  'migration 071). DERIVED — no state table. A fact that CLEARS is simply a newer '
  'observation, so this view flips and every consumer follows on the next recompute.';

-- Lock the view to the backend. Nothing else should read facts in v1.
REVOKE ALL ON public.user_facts_latest FROM anon, authenticated;
GRANT SELECT ON public.user_facts_latest TO service_role;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying, using the two rows from 070's verification:
--   SELECT fact_key, value FROM user_facts_latest WHERE user_id = '<uuid>';
--   -- EXPECT exactly ONE row: has_emergency_buffer = 'false' (the newer observation),
--   -- while SELECT count(*) FROM user_facts WHERE user_id = '<uuid>' still returns 2.
-- ============================================================================
