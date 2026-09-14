-- ============================================================================
-- DRAFT 077 (OPTIONAL — DECISION REQUIRED): user_external_ids (NOT APPLIED)
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
-- APPLY VIA THE SUPABASE SQL EDITOR — only under option (B); after 069, before any
-- POST /facts code that resolves external ids.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST.
-- 0. ⚠ DECISION D2 GATE — DO NOT RUN THIS FILE unless option (B) was chosen AND the signup
--    flow that POPULATES this table has been decided. Applying it alone yields an empty
--    mapping table and a POST /facts that still 404s on every external_user_id.
-- 1. The table name is free — EXPECT NULL:
--    SELECT to_regclass('public.user_external_ids');
-- 2. Match the user_id FK choice made for user_facts in 070 (the two must agree):
--    SELECT conname FROM pg_constraint
--     WHERE conrelid = 'public.user_facts'::regclass AND contype = 'f';
--    -- a user_facts_user_id_fkey row here means option (b); uncomment the same FK below.
-- ---------------------------------------------------------------------------

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

  -- D1 DECIDED (b) in migration 076: UNCOMMENT this FK before applying — the two must agree.
  -- , CONSTRAINT user_external_ids_user_id_fkey
  --     FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS user_external_ids_user_id_idx ON public.user_external_ids (user_id);

COMMENT ON TABLE public.user_external_ids IS
  'OPTIONAL (facts v1, draft 077): partner external_user_id <-> Supabase user_id. Exists '
  'only to let POST /facts accept external_user_id. Unpopulated unless the signup flow '
  'writes it — decide that before applying.';

-- RLS — identity mapping, backend-only. Default-deny, no policy.
ALTER TABLE public.user_external_ids ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying (only under option B). Everything rolls back.
--
-- 1. Both uniqueness rules bite — a partner id means ONE person, and a person has ONE id per
--    partner. The second INSERT in each pair must FAIL with 23505:
--    BEGIN;
--      INSERT INTO user_external_ids (partner, external_user_id, user_id)
--      VALUES ('demo', 'ext-1', gen_random_uuid());
--      INSERT INTO user_external_ids (partner, external_user_id, user_id)
--      VALUES ('demo', 'ext-1', gen_random_uuid());          -- EXPECT 23505 (same ext id)
--    ROLLBACK;
--    BEGIN;
--      INSERT INTO user_external_ids (partner, external_user_id, user_id)
--      VALUES ('demo', 'ext-1', '00000000-0000-0000-0000-000000000001');
--      INSERT INTO user_external_ids (partner, external_user_id, user_id)
--      VALUES ('demo', 'ext-2', '00000000-0000-0000-0000-000000000001');  -- EXPECT 23505 (same user)
--    ROLLBACK;
--
-- 2. The SAME external id under a DIFFERENT partner is legal — namespaces are per partner.
--    Both must SUCCEED:
--    BEGIN;
--      INSERT INTO user_external_ids (partner, external_user_id, user_id)
--      VALUES ('demo', 'ext-1', gen_random_uuid());
--      INSERT INTO user_external_ids (partner, external_user_id, user_id)
--      VALUES ('other', 'ext-1', gen_random_uuid());         -- EXPECT success
--    ROLLBACK;
--
-- 3. The shape CHECKs reject junk. Each must FAIL with 23514:
--    BEGIN;
--      INSERT INTO user_external_ids (partner, external_user_id, user_id)
--      VALUES ('demo', '   ', gen_random_uuid());            -- blank external id
--    ROLLBACK;
--    BEGIN;
--      INSERT INTO user_external_ids (partner, external_user_id, user_id)
--      VALUES ('Bad Partner', 'ext-1', gen_random_uuid());   -- partner not snake_case
--    ROLLBACK;
-- ============================================================================
