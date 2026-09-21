-- ============================================================================
-- MIGRATION 090: financial — Getting Oriented is about the reader's money, not the app — DATA ONLY
--   — APPLIED financial 2026-09-21   *** FINANCIAL ONLY ***
-- ============================================================================
-- WHY (Mark, 2026-09-21): lessons must never describe, promise, or instruct on the partner app's
-- features. The seeded Getting Oriented description (084, from the brief) framed the track around
-- the app ("What the app can now see, how to read a spending summary"), which invites exactly that.
--
-- 1. tracks.description for Getting Oriented → Mark's text (guarded on the 084 text's md5, so a
--    description edited in the CMS since is never overwritten blind).
-- 2. One sentence added to the `lesson` prompt (084) AND the `coverage_audit` prompt (089), directly
--    after the general-education paragraph both share:
--      "Never describe, promise, or give instructions for the partner app's features ..."
--    Mark asked for the lesson prompt; the CMS's "generate lessons" button runs coverage_audit, not
--    generate_lessons, so the rule lands in both or it never reaches a CMS-generated lesson.
--    Each prompt is guarded on its current md5 and on the anchor sentence occurring exactly once.
--
-- NOT CHANGED: the three Getting Oriented lessons already generated under the old description
-- (see the report) — regenerating or archiving them is a content decision. 084's file keeps the
-- original seed text as its record.
--
-- Idempotent: a re-run after apply is a no-op (the new text is detected and left alone).
-- APPLY per migrations/README.md: FINANCIAL ONLY, after 084 and 089.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT financial; 429e58bf…; lesson ac42bce2…,
-- coverage_audit 41b080af…, each with anchor_count 1:
--   SELECT value FROM app_settings WHERE key = 'domain';
--   SELECT md5(description) FROM tracks WHERE id = 'f0840000-0000-4000-8000-000000000001';
--   SELECT prompt_type, md5(system_message),
--          (length(system_message) - length(replace(system_message, 'ask, rather than choosing for them.', '')))
--            / length('ask, rather than choosing for them.') AS anchor_count
--     FROM prompts WHERE prompt_type IN ('lesson','coverage_audit') ORDER BY 1;
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
DECLARE
  anchor   constant text := 'ask, rather than choosing for them.';
  new_rule constant text := 'Never describe, promise, or give instructions for the partner app''s features: no screens,'
    || chr(10) || 'tabs, buttons, settings, notifications or steps in the app, and nothing about what the app'
    || chr(10) || 'can see, track or do. Every lesson is about the reader''s money, not about the app.';
  new_desc constant text := 'For someone who has just started paying attention to their money. How to see where money actually goes in a month, the difference between fixed and flexible spending, and how to pick one thing to work on first. About the reader''s money, never about the app''s features — do not describe what the app does or how to use it.';
  r record;
  cur_desc text;
BEGIN
  IF (SELECT value FROM app_settings WHERE key = 'domain') IS DISTINCT FROM 'financial' THEN
    RAISE EXCEPTION '090 is FINANCIAL ONLY: app_settings.domain is %',
      coalesce((SELECT value FROM app_settings WHERE key = 'domain'), '<unset>');
  END IF;

  -- 1. Track description
  SELECT description INTO cur_desc FROM tracks WHERE id = 'f0840000-0000-4000-8000-000000000001';
  IF NOT FOUND THEN RAISE EXCEPTION '090: Getting Oriented track (084) not found'; END IF;
  IF cur_desc = new_desc THEN
    RAISE NOTICE '090: Getting Oriented description already updated — unchanged';
  ELSIF md5(cur_desc) <> '429e58bf6c5e0c3b338610db27c5e5ec' THEN
    RAISE EXCEPTION '090: Getting Oriented description is not 084''s seed text (md5 %) — edited since; re-base before applying', md5(cur_desc);
  ELSE
    UPDATE tracks SET description = new_desc WHERE id = 'f0840000-0000-4000-8000-000000000001';
  END IF;

  -- 2. The rule in both prompts
  FOR r IN
    SELECT p.id, p.prompt_type, p.system_message, e.pre_md5
      FROM (VALUES ('lesson', 'ac42bce271c39e42fa41586a9c6077cb'),
                   ('coverage_audit', '41b080afb627115b8936c0830695ee4e')) AS e(prompt_type, pre_md5)
      LEFT JOIN prompts p ON p.prompt_type = e.prompt_type AND p.is_active
  LOOP
    IF r.id IS NULL THEN RAISE EXCEPTION '090: no active % prompt', r.prompt_type; END IF;
    IF position(new_rule in r.system_message) > 0 THEN
      RAISE NOTICE '090: % prompt already carries the rule — unchanged', r.prompt_type;
      CONTINUE;
    END IF;
    IF md5(r.system_message) <> r.pre_md5 THEN
      RAISE EXCEPTION '090: % prompt is not the text this file was written against (md5 %) — re-base', r.prompt_type, md5(r.system_message);
    END IF;
    IF (length(r.system_message) - length(replace(r.system_message, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION '090: anchor sentence not found exactly once in the % prompt', r.prompt_type;
    END IF;
    UPDATE prompts SET system_message = replace(system_message, anchor, anchor || chr(10) || new_rule)
     WHERE id = r.id;
  END LOOP;
END $$;

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying (read-only).
-- 1. EXPECT the new description, starting "For someone who has just started paying attention":
--    SELECT description FROM tracks WHERE id = 'f0840000-0000-4000-8000-000000000001';
-- 2. EXPECT t | 1 for both prompts (the rule present exactly once, directly after the anchor):
--    SELECT prompt_type,
--           position('ask, rather than choosing for them.' || chr(10) || 'Never describe, promise' in system_message) > 0,
--           (length(system_message) - length(replace(system_message, 'Never describe, promise, or give instructions', '')))
--             / length('Never describe, promise, or give instructions')
--      FROM prompts WHERE prompt_type IN ('lesson','coverage_audit') ORDER BY 1;
-- ============================================================================
