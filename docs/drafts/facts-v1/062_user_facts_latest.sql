-- ============================================================================
-- DRAFT 062: user_facts_latest — latest-wins resolution (NOT APPLIED)
-- ============================================================================
-- RATIONALE: "the user's current facts" is DERIVED from the append-only log, never
-- stored. Same discipline as user_active_tracks (derived) and milestone suppression
-- (computed fresh each rebuild, no state table) — nothing to keep in sync, nothing to
-- un-set, and a fact that CLEARS takes effect the moment the new observation lands.
--
-- ORDERING: observed_at DESC (what the platform says), then created_at DESC (when we
-- received it), then id DESC as a total-order tiebreak so the result is deterministic
-- even for two rows at the same instant. The 061 UNIQUE (user_id, fact_key, observed_at)
-- means the first key alone is almost always decisive.
--
-- SECURITY: security_invoker so the view can NEVER hand out rows the underlying table's
-- RLS would refuse. In v1 every reader is the service-role backend (or a SECURITY
-- DEFINER function running as owner), so invoker semantics change nothing operationally
-- — they just remove "the view is a hole in the table's RLS" as a future foot-gun.
-- Grants are then locked to service_role explicitly (migration 057's REVOKE/GRANT
-- precedent) so a stray anon/authenticated SELECT is a permission error, not empty rows.
--
-- ⚠ REQUIRES POSTGRES 15+ for `security_invoker`. Check first:
--   SELECT current_setting('server_version_num')::int >= 150000;
-- If that is false, drop the WITH (...) clause and instead rely on the REVOKE/GRANT below
-- alone — a plain view runs as its OWNER, so the grants become the only thing standing
-- between a non-service reader and the facts. Note that in the plain-view case the
-- REVOKE is load-bearing, not belt-and-braces.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — after 061, before 065 (the arm reads this view).
-- Idempotent: CREATE OR REPLACE.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.user_facts_latest
  WITH (security_invoker = true) AS
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
  'migration 062). DERIVED — no state table. A fact that CLEARS is simply a newer '
  'observation, so this view flips and every consumer follows on the next recompute.';

-- Lock the view to the backend. Nothing else should read facts in v1.
REVOKE ALL ON public.user_facts_latest FROM anon, authenticated;
GRANT SELECT ON public.user_facts_latest TO service_role;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying, using the two rows from 061's verification:
--   SELECT fact_key, value FROM user_facts_latest WHERE user_id = '<uuid>';
--   -- EXPECT exactly ONE row: has_emergency_buffer = 'false' (the newer observation),
--   -- while SELECT count(*) FROM user_facts WHERE user_id = '<uuid>' still returns 2.
-- ============================================================================
