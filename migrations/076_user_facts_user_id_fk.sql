-- ============================================================================
-- MIGRATION 076: user_facts.user_id -> auth.users(id) ON DELETE CASCADE — DRAFT (pending apply)
-- ============================================================================
-- DECISION D1, made by Mark 2026-09-14: option (b). 070 shipped with NO foreign key on
-- user_id (option (a), the draft default, because the decision was still open). This adds it.
--
-- WHY auth.users AND NOT public."user": user_id is a Supabase auth uid — the same space as
-- children.parent_id and the recompute's JWT user id. `user` only partially covers that space
-- (an app parent may have no `user` row), so an FK to it would refuse facts for real users.
--
-- WHY CASCADE: a fact describes a person. When the auth user is deleted, their facts go with
-- them — no orphaned financial observations. A fact for a user_id with no auth account is
-- refused (23503), which is the structural safety invariant 3 prefers; facts only ever arrive
-- for users who already exist (partner provisioning creates the account first).
-- The cascade's lookup is served by 070's index, whose leading column is user_id.
--
-- NUMBERING: 076 because 074/075 were already taken; it depends only on 070 and nothing in
-- 074/075 depends on it, so it is applied BEFORE 074. The optional partner-id mapping draft
-- moved from 076 to 077 to make room; if it is ever applied it must carry the same FK.
--
-- APPLY per migrations/README.md (Claude, psql, after Mark's go): financial, then Moosii.
-- Idempotent: the ADD is guarded on pg_constraint, so a re-run is a no-op.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST.
-- 1. 070 is applied and auth.users exists — EXPECT both not NULL:
--    SELECT to_regclass('public.user_facts'), to_regclass('auth.users');
-- 2. The constraint is not there yet — EXPECT 0:
--    SELECT count(*) FROM pg_constraint
--     WHERE conrelid = 'public.user_facts'::regclass AND conname = 'user_facts_user_id_fkey';
-- 3. No existing fact would violate it — EXPECT 0 (the ADD fails on the first orphan otherwise):
--    SELECT count(*) FROM public.user_facts uf
--     WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = uf.user_id);
-- ---------------------------------------------------------------------------

BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.user_facts'::regclass
                    AND conname = 'user_facts_user_id_fkey') THEN
    ALTER TABLE public.user_facts
      ADD CONSTRAINT user_facts_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE;
  END IF;
END $$;

COMMENT ON COLUMN public.user_facts.user_id IS
  'Supabase auth uid. FK auth.users(id) ON DELETE CASCADE (migration 076, decision D1).';

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying.
-- 1. The FK targets auth.users with ON DELETE CASCADE — EXPECT one row, confdeltype = 'c':
--    SELECT conname, confrelid::regclass, confdeltype FROM pg_constraint
--     WHERE conrelid = 'public.user_facts'::regclass AND conname = 'user_facts_user_id_fkey';
-- 2. A fact for a user with no auth account is refused (run in a transaction, then ROLLBACK):
--    INSERT INTO user_facts (user_id, fact_key, value, source)
--    VALUES (gen_random_uuid(), '<a real key>', '<a real value>', 'manual');   -- 23503
-- (The cascade itself is proven by the local harness; it is not exercised live, since that
--  would mean deleting an auth user.)
-- ============================================================================
