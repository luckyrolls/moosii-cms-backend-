-- ============================================================================
-- MIGRATION 117: structure block "activity_v1" — activities generate activity-shaped cards — BOTH PROJECTS (data, 1 row)
--   — DRAFT (pending apply)
-- ============================================================================
-- WHY (Mark 2026-10-24; moosii-cms FINDINGS-cms-activities §5): generate_segment_content takes no overrides, so
-- generating an activity with the normal button silently produced lesson-shaped cards. The generator now applies
-- this block as the ## Structure layer whenever the segment's lesson has kind = 'activity' and no explicit structure
-- override is given (code: src/lib/structureChoice.ts; api-contract §2b/§2c). Lessons are unchanged.
--
-- WHAT: one prompt_blocks row (block_type 'structure', name 'activity_v1', label 'Activity (v1)', is_active), its text
-- chosen by app_settings.domain:
--   financial — ends with "No dollar amounts." (the financial no-amounts rule);
--   moosii    — the same text without that sentence.
--   Any other domain → RAISE (whole transaction rolled back). Resolved by its immutable name (like grounding_v1, 110),
--   NOT referenced from prompts — a tone's default structure is untouched.
-- Idempotent: ON CONFLICT (block_type, name) DO NOTHING — a re-run never overwrites a later edit.
-- No schema change: prompt_blocks_block_type_check already allows 'structure'.
-- Trap (CLAUDE.md): apply with PGCLIENTENCODING=UTF8 — the text has "–" (U+2013); the md5s below are of the UTF-8 text.
--   financial md5 93d7ecf747db8c3ea0838f55067b6c72 · moosii md5 83e45c890e58c2d1ca3dacdcd6affca0
-- APPLY per migrations/README.md: financial first, then Moosii.
-- ============================================================================

-- PRE-CHECK (read-only). EXPECT the domain, and no activity_v1 row:
--   SELECT value FROM app_settings WHERE key = 'domain';
--   SELECT name, is_active FROM prompt_blocks WHERE block_type = 'structure' ORDER BY name;

BEGIN;

DO $$
DECLARE
  v_domain text := (SELECT value FROM public.app_settings WHERE key = 'domain');
  v_base   text := 'Write this as an activity, not a lesson. Card 1: why this matters, in two sentences. '
                || 'Cards 2–4: concrete steps the reader can do in under ten minutes. '
                || 'Last card: "Do it now" in one sentence.';
  v_text   text;
BEGIN
  IF v_domain = 'financial' THEN
    v_text := v_base || ' No dollar amounts.';
  ELSIF v_domain = 'moosii' THEN
    v_text := v_base;
  ELSE
    RAISE EXCEPTION '117: app_settings.domain is % — expected financial or moosii', coalesce(v_domain, 'NULL');
  END IF;
  INSERT INTO public.prompt_blocks (block_type, name, label, content, is_active)
  VALUES ('structure', 'activity_v1', 'Activity (v1)', v_text, true)
  ON CONFLICT (block_type, name) DO NOTHING;
END $$;

COMMIT;

-- VERIFICATION: one ('structure','activity_v1') row, active, content md5 = this project's above (md5(content));
-- the domain's text (financial ends "No dollar amounts."; moosii does not); no prompts row references it; other
-- structure blocks unchanged.
