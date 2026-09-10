-- ============================================================================
-- DRAFT 061: user_facts — append-only observation history (NOT APPLIED)
-- ============================================================================
-- RATIONALE: financial facts are NOT monotonic. "has an emergency buffer" can become
-- false; a subscription lapses. The existing child-fact model (child_milestones) is
-- presence-as-truth with ON CONFLICT DO NOTHING — first-reach-wins, no update, no
-- delete — which is right for milestones ("a fact never un-happens") and WRONG here.
--
-- So: this table is an APPEND-ONLY LOG of observations. Nothing is ever updated or
-- deleted in normal operation; "the user's current value" is DERIVED by 062's
-- latest-wins view. That keeps history (trajectory is the point) and makes clearing a
-- fact an ordinary write rather than a special un-record path.
--
-- ⚠ DECISION FOR MARK — user_id has NO FOREIGN KEY in this draft. The brief said "FKs
-- the same target children.parent_id does", but children.parent_id has NO FK at all
-- (verified: database.types.ts children Relationships: []) — it is a bare uuid in the
-- AUTH-UID space. So "the same target" is literally "no constraint". Three options:
--   (a) AS DRAFTED — no FK. Matches children.parent_id exactly. Accepts a fact for a
--       user_id that does not exist yet (relevant if platform facts can arrive before
--       the person signs up). Costs structural safety, which invariant 3 prefers.
--   (b) REFERENCES auth.users (id) ON DELETE CASCADE — the real referent of the
--       auth-uid space, and what the recompute's user_id (from the verified JWT) is.
--       RECOMMENDED IF facts only ever arrive for users who already exist.
--   (c) REFERENCES public."user" (id) — what user_demographic_responses does
--       (migration 008). REJECTED: `user` only PARTIALLY covers the auth-uid space
--       (src/middleware/jwtAuth.ts — an app parent may have no `user` row), so this
--       would reject facts for legitimate users.
-- Uncomment the (b) constraint below if that is the call.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — after 060, before 062.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_facts (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL,
  fact_key    text        NOT NULL,
  value       text        NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),  -- WHEN THE PLATFORM OBSERVED IT
  source      text        NOT NULL,
  source_ref  text,                                -- partner event id / admin uid / job id
  created_at  timestamptz NOT NULL DEFAULT now(),  -- when WE received it
  CONSTRAINT user_facts_pkey PRIMARY KEY (id),

  -- The pair must be authored vocabulary (060). RESTRICT: a key/value in use cannot be
  -- deleted out from under recorded history (same posture as migrations 038/040).
  CONSTRAINT user_facts_value_fkey
    FOREIGN KEY (fact_key, value) REFERENCES public.fact_values (fact_key, value)
    ON UPDATE CASCADE ON DELETE RESTRICT,

  -- "No amounts, ever" repeated on the observation itself, so a bad row cannot exist
  -- even if the vocabulary table is later loosened.
  CONSTRAINT user_facts_value_shape       CHECK (value ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT user_facts_value_not_numeric CHECK (value !~ '^[[:space:]]*[+-]?[$]?[0-9]'),

  CONSTRAINT user_facts_source_valid
    CHECK (source = ANY (ARRAY['platform_api'::text, 'cms'::text, 'manual'::text])),

  -- One observation per (user, key) per instant. Makes the latest-wins DISTINCT ON
  -- deterministic and makes a duplicate delivery of the same event a no-op conflict
  -- rather than a second history row.
  CONSTRAINT user_facts_one_per_instant UNIQUE (user_id, fact_key, observed_at)

  -- OPTION (b) — uncomment if Mark chooses an FK (see the decision note above):
  -- , CONSTRAINT user_facts_user_id_fkey
  --     FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE
);

-- The ONLY read pattern in v1: "latest value per key for this user" (the 062 view) and
-- "this user's history" (GET /facts/:user_id). Both are served by this one index.
CREATE INDEX IF NOT EXISTS user_facts_user_key_observed_idx
  ON public.user_facts (user_id, fact_key, observed_at DESC);

COMMENT ON TABLE public.user_facts IS
  'Append-only log of platform-supplied user facts (facts v1, migration 061). NEVER '
  'updated or deleted: a fact that CLEARS is a NEW observation with the new value. '
  'Current value is derived by user_facts_latest (062). Values are boolean or short '
  'enum only — amounts are rejected by CHECK.';

-- RLS — per-user, financial-adjacent. Default-deny, NO policy: only the service-role
-- backend touches this table, and the app NEVER reads facts directly in v1 (admin reads
-- go through GET /facts/:user_id). Add to docs/rls-sweep.md when this is applied.
ALTER TABLE public.user_facts ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying (and after the 066 seeds).
--   -- rejected: unknown pair
--   INSERT INTO user_facts (user_id, fact_key, value, source)
--     VALUES (gen_random_uuid(), 'credit_utilization_band', 'enormous', 'manual'); -- FK violation
--   -- rejected: an amount
--   INSERT INTO user_facts (user_id, fact_key, value, source)
--     VALUES (gen_random_uuid(), 'credit_utilization_band', '0.82', 'manual');      -- CHECK violation
--   -- accepted, then CLEARED by a second observation (both rows survive):
--   INSERT INTO user_facts (user_id, fact_key, value, source, observed_at)
--     VALUES ('<uuid>', 'has_emergency_buffer', 'true',  'manual', now() - interval '1 day');
--   INSERT INTO user_facts (user_id, fact_key, value, source, observed_at)
--     VALUES ('<uuid>', 'has_emergency_buffer', 'false', 'manual', now());
--   SELECT count(*) FROM user_facts WHERE user_id = '<uuid>';  -- EXPECT 2 (history kept)
-- ============================================================================
