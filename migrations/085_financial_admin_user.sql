-- ============================================================================
-- MIGRATION 085: Mark's admin profile + both review flags on financial (D-C3) — DATA ONLY
--   — DRAFT (pending apply)   *** FINANCIAL ONLY ***
-- ============================================================================
-- WHY A SEPARATE FILE: D-C3 gives Mark both review capabilities on financial, but the financial
-- project has NO auth users yet (checked 2026-09-16), so there is no uid to grant them to. Run this
-- AFTER Mark signs up on the financial project.
--
-- WHY IT INSERTS THE `user` ROW, NOT JUST UPDATES IT: financial was built from a schema dump of
-- Moosii's `public` schema, which does not carry the triggers on `auth.users`. On Moosii,
-- `new_user_trigger` (→ create_new_user()) creates the `public."user"` row at sign-up; on financial
-- the function exists but NO trigger calls it. So a sign-up leaves no `user` row, and the backend's
-- admin check (src/middleware/jwtAuth.ts verifyAdminJwt reads user.role and the two flags) refuses
-- the account. This file creates or updates the row. Attaching the auth triggers on financial is a
-- separate SCHEMA decision (see the report) — not done here.
--
-- Capabilities live on `public."user"` (can_review_editorial, can_approve_clinical; migration
-- 056), not on users_internal (which the backend does not read).
--
-- The uid is the ONLY input — no email is written here (the row's email stays NULL; it is optional,
-- and this repo does not commit account emails).
--
-- Idempotent: ON CONFLICT (id) DO UPDATE sets the same three values.
-- APPLY per migrations/README.md: FINANCIAL ONLY, after Mark's financial sign-up.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only).
-- 1. This is financial — EXPECT 'financial':
--    SELECT value FROM app_settings WHERE key = 'domain';
-- 2. Mark's auth account exists — EXPECT exactly 1 (Authentication → Users → copy his UID):
--    SELECT count(*) FROM auth.users WHERE id = '<uid>';
-- 3. Whether a profile row exists already (either answer is fine):
--    SELECT role, can_review_editorial, can_approve_clinical FROM public."user" WHERE id = '<uid>';
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
BEGIN
  IF (SELECT value FROM app_settings WHERE key = 'domain') IS DISTINCT FROM 'financial' THEN
    RAISE EXCEPTION '085 is FINANCIAL ONLY: app_settings.domain is %',
      coalesce((SELECT value FROM app_settings WHERE key = 'domain'), '<unset>');
  END IF;
END $$;

-- ---- INPUT: Mark's financial auth uid ----
CREATE TEMP TABLE seed_085 (auth_uid text NOT NULL) ON COMMIT DROP;
INSERT INTO seed_085 (auth_uid) VALUES ('<<MARK: financial auth uid>>');

DO $$
DECLARE v text := (SELECT auth_uid FROM seed_085);
BEGIN
  IF v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION '085: fill in Mark''s financial auth uid first (got %)', v;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v::uuid) THEN
    RAISE EXCEPTION '085: no auth user % on this project — sign up first', v;
  END IF;
END $$;

-- daily_reminder_time is NOT NULL with no default (create_new_user supplies it on Moosii).
INSERT INTO public."user" (id, role, can_review_editorial, can_approve_clinical, daily_reminder_time)
SELECT auth_uid::uuid, 'super_admin', true, true, time '09:00'
  FROM seed_085
ON CONFLICT (id) DO UPDATE
  SET role                 = 'super_admin',
      can_review_editorial = true,
      can_approve_clinical = true;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying (read-only). EXPECT one row: super_admin | t | t.
--   SELECT role, can_review_editorial, can_approve_clinical FROM public."user" WHERE id = '<uid>';
-- Then from the CMS pointed at the financial backend: sign in and open any admin screen (200, not 403).
-- ============================================================================
