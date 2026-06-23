-- ============================================================================
-- Migration 013 (main track): tone cleanup — Phase 1 of tone management
-- ============================================================================
-- Two prep steps before tone management ships:
--
-- 1. Retire "Short" and "With Image" as tones. They were never distinct VOICES —
--    per migration 0003 they were SIZE variants of "Checklist coach" and all three
--    share the crisp_action_first voice block. Once size becomes a separate
--    reusable profile (Phase 2), they're redundant: pick Checklist voice + a Short
--    size profile. Soft-disabling them (is_active=false) also makes the shared
--    crisp_action_first block 1:1 among ACTIVE tones, which is what tone editing
--    needs to stay predictable.
--    Reversible on purpose — flip is_active back, or hard-delete later via the tone
--    CRUD. (Hard-delete alternative is commented below if you'd rather.)
--
-- 2. Trim stray leading/trailing whitespace from tone display names
--    ("Short ", "Lightly humorous ", " Supportive friend ..."). Harmless now that
--    selection is moving to the stable row id, but it keeps names/logs clean.
--
-- No schema change. Selection-by-id (replacing the tone-string lookup in the
-- handlers) is a CODE change in the same Phase-1 slice, not here.
--
-- APPLIED VIA THE SUPABASE SQL EDITOR — not in supabase_migrations.schema_
-- migrations; on the 008/009/010/011/012/013 reconciliation list. Idempotent.
-- ============================================================================

BEGIN;

-- 1. Soft-disable the two size-variant tones.
UPDATE prompts
SET    is_active = false,
       updated_at = now()
WHERE  prompt_type = 'segment'
  AND  btrim(tone) IN ('Short', 'With Image');

-- Hard-delete alternative (use INSTEAD of the UPDATE above if you want them gone):
-- DELETE FROM prompts
-- WHERE prompt_type = 'segment' AND btrim(tone) IN ('Short', 'With Image');

-- 2. Trim whitespace on the remaining tone names.
UPDATE prompts
SET    tone = btrim(tone),
       updated_at = now()
WHERE  prompt_type = 'segment'
  AND  tone IS NOT NULL
  AND  tone <> btrim(tone);

COMMIT;
