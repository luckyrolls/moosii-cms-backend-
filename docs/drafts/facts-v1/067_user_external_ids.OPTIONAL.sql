-- ============================================================================
-- DRAFT 067 (OPTIONAL — DECISION REQUIRED): user_external_ids (NOT APPLIED)
-- ============================================================================
-- ⚠ THIS FILE EXISTS BECAUSE THE CONTRACT ASKS FOR SOMETHING THE SCHEMA CANNOT DO.
-- The facts-intake body is specified as `{ external_user_id | user_id, ... }`, but
-- NOTHING in this database maps a partner's user id to a Supabase user id — verified,
-- there is no such table and no such column anywhere. So `external_user_id` is
-- unresolvable today and POST /facts could only ever accept `user_id`.
--
-- TWO WAYS OUT — Mark picks:
--   (A) DROP external_user_id from v1. The partner must send the Supabase `user_id`.
--       Nothing to build, no new table, no sync problem. Correct if the partner already
--       holds the Supabase uid (e.g. they provisioned the account or received it back
--       at signup). RECOMMENDED IF TRUE.
--   (B) APPLY THIS FILE. The partner keeps its own identifier and this table is the
--       translation layer. Costs a mapping that something must populate — and this
--       migration does NOT answer WHO populates it, because that is a signup-flow
--       question spanning the app, not a schema question. Do not apply this until that
--       is answered, or you get an empty table and a contract that still 404s.
--
-- NOT AN MX ADAPTER (explicitly out of scope): this is an identity mapping only, no
-- aggregator-specific fields, no token storage, no account/institution modelling.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — only under option (B); after 060, before any
-- POST /facts code that resolves external ids.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_external_ids (
  id               uuid        NOT NULL DEFAULT gen_random_uuid(),
  partner          text        NOT NULL,   -- which partner's namespace this id lives in
  external_user_id text        NOT NULL,
  user_id          uuid        NOT NULL,   -- Supabase auth uid (same space as children.parent_id)
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,                   -- admin uid if mapped by hand; NO FK
  CONSTRAINT user_external_ids_pkey PRIMARY KEY (id),

  -- An external id means ONE person within a partner's namespace.
  CONSTRAINT user_external_ids_partner_external_uq UNIQUE (partner, external_user_id),
  -- And a person has at most one id per partner. Both directions pinned, so the
  -- translation can never become ambiguous in either direction.
  CONSTRAINT user_external_ids_partner_user_uq UNIQUE (partner, user_id),

  CONSTRAINT user_external_ids_partner_shape CHECK (partner ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT user_external_ids_external_nonempty CHECK (length(btrim(external_user_id)) > 0)

  -- Match whatever user_id FK decision is made for user_facts (061) — the two must agree.
  -- , CONSTRAINT user_external_ids_user_id_fkey
  --     FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS user_external_ids_user_id_idx ON public.user_external_ids (user_id);

COMMENT ON TABLE public.user_external_ids IS
  'OPTIONAL (facts v1, draft 067): partner external_user_id <-> Supabase user_id. Exists '
  'only to let POST /facts accept external_user_id. Unpopulated unless the signup flow '
  'writes it — decide that before applying.';

-- RLS — identity mapping, backend-only. Default-deny, no policy.
ALTER TABLE public.user_external_ids ENABLE ROW LEVEL SECURITY;

COMMIT;
