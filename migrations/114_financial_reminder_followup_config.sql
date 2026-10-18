-- ============================================================================
-- MIGRATION 114: follow-up config for "Set a Statement-Date Reminder" — *** FINANCIAL ONLY *** (data, one row)
--   — DRAFT (pending apply)
-- ============================================================================
-- WHY (Mark 2026-10-17, demo path for activity follow-ups): the financial demo's one activity gets a follow-up and a
-- data check. "I'll do it" → asked again after 7 days; it is verified (done by data + the activity_verified bonus) when
-- the user's credit_utilization_band becomes 'low', observed after the commitment (migration 113).
--
-- WHAT: lessons d9f6e3b4-e448-4602-9de9-dd6a161b486a ("Set a Statement-Date Reminder", kind activity):
--   followup_after_days = 7, verify_fact_key = 'credit_utilization_band', verify_fact_value = 'low'.
--   Metadata only: the 064 edit guard and 066 review reset cover lessons' content columns, so no re-approval.
-- FINANCIAL ONLY: refuses unless app_settings.domain = 'financial' (the lesson exists only there).
-- Guards: the lesson exists, is the activity named above, and the vocabulary has (credit_utilization_band, low); its
-- current follow-up settings are NULL or already these values (anything else = drift → refuse). Re-run = no-op.
-- ============================================================================

-- PRE-CHECK (read-only). EXPECT domain financial; one row, kind activity, three NULLs:
--   SELECT value FROM app_settings WHERE key = 'domain';
--   SELECT lesson_name, kind, followup_after_days, verify_fact_key, verify_fact_value FROM lessons
--    WHERE id = 'd9f6e3b4-e448-4602-9de9-dd6a161b486a';

BEGIN;

DO $$
DECLARE l record;
BEGIN
  IF (SELECT value FROM public.app_settings WHERE key = 'domain') IS DISTINCT FROM 'financial' THEN
    RAISE EXCEPTION '114: FINANCIAL ONLY — app_settings.domain is %', (SELECT value FROM public.app_settings WHERE key = 'domain');
  END IF;
  SELECT lesson_name, kind, followup_after_days, verify_fact_key, verify_fact_value INTO l
    FROM public.lessons WHERE id = 'd9f6e3b4-e448-4602-9de9-dd6a161b486a';
  IF NOT FOUND THEN RAISE EXCEPTION '114: lesson d9f6e3b4-… not found'; END IF;
  IF l.kind <> 'activity' OR l.lesson_name <> 'Set a Statement-Date Reminder' THEN
    RAISE EXCEPTION '114: lesson d9f6e3b4-… is % "%", expected the activity "Set a Statement-Date Reminder"', l.kind, l.lesson_name;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fact_values WHERE fact_key = 'credit_utilization_band' AND value = 'low') THEN
    RAISE EXCEPTION '114: fact value (credit_utilization_band, low) missing from the vocabulary';
  END IF;
  IF (l.followup_after_days IS NOT NULL AND l.followup_after_days <> 7)
     OR (l.verify_fact_key IS NOT NULL AND l.verify_fact_key <> 'credit_utilization_band')
     OR (l.verify_fact_value IS NOT NULL AND l.verify_fact_value <> 'low') THEN
    RAISE EXCEPTION '114: lesson already has other follow-up settings (%, %, %) — re-base', l.followup_after_days, l.verify_fact_key, l.verify_fact_value;
  END IF;
END $$;

UPDATE public.lessons
   SET followup_after_days = 7, verify_fact_key = 'credit_utilization_band', verify_fact_value = 'low'
 WHERE id = 'd9f6e3b4-e448-4602-9de9-dd6a161b486a'
   AND (followup_after_days IS DISTINCT FROM 7 OR verify_fact_key IS DISTINCT FROM 'credit_utilization_band'
        OR verify_fact_value IS DISTINCT FROM 'low');

COMMIT;

-- VERIFICATION: the row reads (7, credit_utilization_band, low); is_published, review state and with_quiz unchanged;
-- no other lesson has follow-up settings.
