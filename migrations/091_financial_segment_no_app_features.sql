-- ============================================================================
-- MIGRATION 091: financial — no-app-features rule in the segment prompt — DATA ONLY
--   — APPLIED financial 2026-09-21   *** FINANCIAL ONLY ***
-- ============================================================================
-- WHY (Mark, 2026-09-21): 090 put "never describe, promise, or give instructions for the partner
-- app's features" into the lesson and coverage_audit prompts. The segment prompt (089, id …0301)
-- writes the card text itself, so the same line goes there too, word for word, directly after the
-- same anchor sentence.
--
-- Guarded on the segment prompt's current md5 and on the anchor occurring exactly once.
-- Idempotent: a re-run after apply is a no-op (the rule is detected and left alone).
-- APPLY per migrations/README.md: FINANCIAL ONLY, after 089 and 090.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT financial; bf582c55…, anchor_count 1:
--   SELECT value FROM app_settings WHERE key = 'domain';
--   SELECT md5(system_message),
--          (length(system_message) - length(replace(system_message, 'ask, rather than choosing for them.', '')))
--            / length('ask, rather than choosing for them.') AS anchor_count
--     FROM prompts WHERE id = 'f0840000-0000-4000-8000-000000000301';
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
DECLARE
  anchor   constant text := 'ask, rather than choosing for them.';
  new_rule constant text := 'Never describe, promise, or give instructions for the partner app''s features: no screens,'
    || chr(10) || 'tabs, buttons, settings, notifications or steps in the app, and nothing about what the app'
    || chr(10) || 'can see, track or do. Every lesson is about the reader''s money, not about the app.';
  cur text;
BEGIN
  IF (SELECT value FROM app_settings WHERE key = 'domain') IS DISTINCT FROM 'financial' THEN
    RAISE EXCEPTION '091 is FINANCIAL ONLY: app_settings.domain is %',
      coalesce((SELECT value FROM app_settings WHERE key = 'domain'), '<unset>');
  END IF;

  SELECT system_message INTO cur FROM prompts
   WHERE id = 'f0840000-0000-4000-8000-000000000301' AND prompt_type = 'segment';
  IF NOT FOUND THEN RAISE EXCEPTION '091: financial segment prompt (089) not found'; END IF;

  IF position(new_rule in cur) > 0 THEN
    RAISE NOTICE '091: segment prompt already carries the rule — unchanged';
    RETURN;
  END IF;
  IF md5(cur) <> 'bf582c55a6f3ad13e49608503f3afee0' THEN
    RAISE EXCEPTION '091: segment prompt is not the text this file was written against (md5 %) — re-base', md5(cur);
  END IF;
  IF (length(cur) - length(replace(cur, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '091: anchor sentence not found exactly once in the segment prompt';
  END IF;

  UPDATE prompts SET system_message = replace(system_message, anchor, anchor || chr(10) || new_rule)
   WHERE id = 'f0840000-0000-4000-8000-000000000301';
END $$;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying (read-only). EXPECT t | 1:
--   SELECT position('ask, rather than choosing for them.' || chr(10) || 'Never describe, promise' in system_message) > 0,
--          (length(system_message) - length(replace(system_message, 'Never describe, promise, or give instructions', '')))
--            / length('Never describe, promise, or give instructions')
--     FROM prompts WHERE id = 'f0840000-0000-4000-8000-000000000301';
-- ============================================================================
