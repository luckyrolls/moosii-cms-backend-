-- ============================================================================
-- Migration 031: content_images.scene — the scene actually used per image
-- ============================================================================
-- Image generation is ONE fused LLM call: STYLE (base+overlay) is the model's
-- instructions, and the SCENE input (the card-content userPrompt) is what the
-- model turns into the final image_prompt. Until now the scene existed only as a
-- transient input — nothing recorded WHAT scene a given image depicted, and there
-- was no hook to hand-write it.
--
-- Pass 1 lets a human OPTIONALLY supply the scene on generate/regen; if omitted
-- the scene is derived exactly as before. This column stores the scene actually
-- used (given or derived) — the userPrompt sent to the model. It is provenance
-- ALONGSIDE image_prompt (which stays the full rendered prompt, unchanged).
--
-- Nullable, no backfill. All existing rows stay NULL — old image_prompt blobs are
-- NOT parsed to reconstruct a scene. Value accrues FORWARD ONLY. NULL also marks
-- the prompt_override path (whole prompt hand-supplied, LLM skipped → no scene
-- meaningfully "used").
--
-- Flag: regenerate database.types.ts after apply (adds content_images.scene). The
-- insert path is hand-typed to include it meanwhile; the regen is a confirm.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..031 reconciliation list.
-- ============================================================================

BEGIN;

ALTER TABLE content_images
  ADD COLUMN IF NOT EXISTS scene text;

COMMENT ON COLUMN content_images.scene IS
  'The scene used for this image — the userPrompt sent to the prompt-writer LLM: '
  'the human-supplied scene when given, else the derived card-content scene. NULL '
  'when the whole prompt was hand-supplied (prompt_override) or for pre-migration '
  'rows (never backfilled). image_prompt remains the full rendered prompt. '
  'Migration 031.';

COMMIT;
