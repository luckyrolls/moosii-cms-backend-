-- ============================================================================
-- MIGRATION 088: financial — seed `consts` from Moosii's row — DATA ONLY — APPLIED financial 2026-09-16
--   *** FINANCIAL ONLY ***
-- ============================================================================
-- WHY: since 087 the sign-up trigger (create_new_user) runs on financial. Besides the `user` row it
-- copies defaults from public.consts into public.user_configurations — and financial's consts is
-- EMPTY (schema-only dump), so a sign-up there gets NO user_configurations row. That row is required:
--
--   * completed_items_insert_trigger → trigger_add_moosies() reads user_configurations.moosi_to_add;
--     with no row it is NULL, `moosies = moosies + NULL` is NULL, and user.moosies is NOT NULL — so
--     INSERTING A COMPLETED ITEM FAILS. Completing any lesson or questionnaire errors.
--   * user_mlp_not_completed INNER JOINs user_configurations (mlp_limit) — no row, EMPTY upcoming plan.
--     Read by the app home plan (moosii-rn src/hooks/useUpcomingMlp.ts) and the CMS
--     (moosii-cms src/data/classify.ts:75).
--   * unique_items_today_by_user INNER JOINs it (daily_limit) — the user silently drops out.
--   * user_mlp_not_completed_limited CROSS JOINs consts — returns nothing while consts is empty.
--
-- The app's onboarding (moosii-rn verify.tsx:135-146) also inserts a config row of its own, but a CMS
-- sign-up does not, and on Moosii the trigger's row wins (the app's later insert hits the primary key
-- and is only logged). Seeding consts makes financial behave exactly like Moosii.
--
-- VALUES: Moosii's single consts row, read 2026-09-16 (id 1): weight_factor 1.5, mlp_limit 20,
-- daily_limit 50, moosi_to_add 10, monthly_fee 9.99, yearly_fee 99.9, free_trial_days 7. These are
-- Moosii's product values (fees, trial, moosies) — copied as instructed; change them in the row if
-- financial should differ.
--
-- BACKFILL: none needed — financial had 0 auth users when this was written (a user created before
-- 088 would need their config row added by hand; the pre-check reports the count).
--
-- Idempotent: ON CONFLICT (id) DO NOTHING. APPLY per migrations/README.md: FINANCIAL ONLY, after 087,
-- before any sign-up.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only).
-- 1. This is financial — EXPECT 'financial':
--    SELECT value FROM app_settings WHERE key = 'domain';
-- 2. consts is empty; users without a config row — EXPECT 0 and 0:
--    SELECT (SELECT count(*) FROM consts) AS consts,
--           (SELECT count(*) FROM "user" u WHERE NOT EXISTS
--              (SELECT 1 FROM user_configurations c WHERE c.user_id = u.id)) AS users_without_config;
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
BEGIN
  IF (SELECT value FROM app_settings WHERE key = 'domain') IS DISTINCT FROM 'financial' THEN
    RAISE EXCEPTION '088 is FINANCIAL ONLY: app_settings.domain is %',
      coalesce((SELECT value FROM app_settings WHERE key = 'domain'), '<unset>');
  END IF;
END $$;

INSERT INTO public.consts
  (id, weight_factor, mlp_limit, daily_limit, moosi_to_add, monthly_fee, yearly_fee, free_trial_days)
VALUES
  (1, 1.5, 20, 50, 10, 9.99, 99.9, 7)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying. Writes happen inside a transaction that is ROLLED BACK.
-- 1. EXPECT one row: 1 | 1.5 | 20 | 50 | 10 | 9.99 | 99.9 | 7
--    SELECT id, weight_factor, mlp_limit, daily_limit, moosi_to_add, monthly_fee, yearly_fee, free_trial_days FROM consts;
-- 2. (rolled back) a sign-up now gets a config row, a plan item shows in user_mlp_not_completed, and
--    completing an item works and adds moosies:
--    BEGIN;
--      INSERT INTO auth.users (id, email, created_at, raw_app_meta_data, aud, role)
--        VALUES ('0c880000-0000-4000-8000-000000000001', 'zz-verify-088@example.invalid', now(),
--                '{"provider":"email"}', 'authenticated', 'authenticated');
--      SELECT mlp_limit, daily_limit, moosi_to_add FROM user_configurations
--       WHERE user_id = '0c880000-0000-4000-8000-000000000001';              -- EXPECT 20 | 50 | 10
--      INSERT INTO user_mlp (user_id, item_id, item_type, track_id, position, item_name, with_quiz, item_priority)
--        VALUES ('0c880000-0000-4000-8000-000000000001', gen_random_uuid(), 'lesson',
--                (SELECT id FROM tracks LIMIT 1), 1, 'zz_verify_088', false, 100);
--      SELECT count(*) FROM user_mlp_not_completed WHERE user_id = '0c880000-0000-4000-8000-000000000001';  -- EXPECT 1
--      INSERT INTO completed_items (user_id, item_id, item_type) VALUES
--        ('0c880000-0000-4000-8000-000000000001', gen_random_uuid(), 'lesson');   -- EXPECT success
--      SELECT moosies FROM "user" WHERE id = '0c880000-0000-4000-8000-000000000001';   -- EXPECT 10
--    ROLLBACK;
-- ============================================================================
