-- ============================================================================
-- MIGRATION 079: UNIQUE (email) on public."user", NULLs allowed — DRAFT (pending apply)
-- ============================================================================
-- WHY. The app's only duplicate-account guard is a client-side lookup of ANOTHER user's row by
-- email (moosii-rn app/(onboarding)/verify.tsx:78-82). Migration 078 makes that row invisible to the
-- signed-in client, so the lookup now always returns nothing and the app goes on to insert a second
-- `user` row with the same email. This moves the guard into the database, where no client can skip it
-- — structural safety over a behavioural check (CLAUDE.md invariant 3).
--
-- NULL-SAFE. `UNIQUE NULLS DISTINCT` (the PostgreSQL default, spelled out): any number of rows may
-- have a NULL email; only non-NULL duplicates are refused. Needs PostgreSQL 15+ for the explicit
-- clause (financial 17.6, Moosii 15.8).
--
-- CASE. Case-sensitive, exactly as specified: 'A@x.com' and 'a@x.com' are different values.
-- Supabase auth lower-cases emails; on 2026-09-14 both projects had 0 case-insensitive duplicate
-- groups as well as 0 exact ones.
--
-- ⚠ APP EFFECT (flag for the moosii-rn seat). The duplicate-auth-account case that verify.tsx
-- used to log and step past (line 86) now reaches its insert (line 91) and fails with 23505. The app
-- shows "Failed to create your account" (line 103) instead of silently continuing with no row. The app
-- should handle 23505 on that insert deliberately.
--
-- APPLY per migrations/README.md (Claude, psql, after Mark's go): financial, then Moosii. The guard
-- inside refuses to add the constraint while duplicates exist, so a surprise duplicate stops the
-- file instead of half-applying. Idempotent: the ADD is skipped when the constraint exists.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST on each project.
-- 1. Duplicates (as specified) — EXPECT zero rows. A single row whose email is NULL is NOT a
--    blocker: NULLs stay allowed.
--    SELECT email, count(*) FROM "user" GROUP BY 1 HAVING count(*) > 1;
-- 2. Info — case-insensitive duplicates, which this constraint would still allow — EXPECT zero rows:
--    SELECT lower(btrim(email)), count(*) FROM "user" WHERE email IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
-- 3. No unique on email yet, and the name is free — EXPECT 0:
--    SELECT count(*) FROM pg_constraint WHERE conrelid = 'public."user"'::regclass AND conname = 'user_email_key';
-- Results on 2026-09-14: financial 0 rows / 0 / 0; Moosii (5 users) 0 rows / 0 / 0.
-- ---------------------------------------------------------------------------

BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public."user" WHERE email IS NOT NULL GROUP BY email HAVING count(*) > 1) THEN
    RAISE EXCEPTION '079: duplicate non-NULL emails exist in public."user" — resolve them first (see PRE-CHECK 1)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public."user"'::regclass AND conname = 'user_email_key') THEN
    ALTER TABLE public."user" ADD CONSTRAINT user_email_key UNIQUE NULLS DISTINCT (email);
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying.
-- 1. The constraint exists, on email alone, with NULLs distinct — EXPECT one row, nulls_not_distinct = f:
--    SELECT c.conname, pg_get_constraintdef(c.oid), i.indnullsnotdistinct AS nulls_not_distinct
--      FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid
--     WHERE c.conrelid = 'public."user"'::regclass AND c.conname = 'user_email_key';
-- 2. A duplicate non-NULL email is refused with 23505 (run in a transaction, then ROLLBACK).
-- ============================================================================
