-- ============================================================================
-- Migration 030: sub_segments.tone_id — persist tone PER CARD
-- ============================================================================
-- Tone was input-only (generate/regen take a tone_id = prompts.id and record it in
-- ai_generation_log notes, but no content row stored it). The CMS wants to show the
-- tone each card was written in, and single-card regen makes tone a PER-CARD property
-- (retoning one card must not relabel the others) — hence card-level, not segment.
--
-- Nullable, FK → prompts.id (ON DELETE SET NULL: if a tone row is removed the card
-- keeps its text, loses the label). All existing rows stay NULL ("not recorded");
-- value accrues FORWARD ONLY. NO backfill from the generation log, now or ever —
-- notes is a display string, and a twice-regenerated card has multiple entries with
-- no way to know which produced the current text. A wrong badge is worse than an
-- honest null.
--
-- Flag: regenerate database.types.ts after apply (adds sub_segments.tone_id); the
-- write paths use a scoped as-any cast meanwhile.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..030 reconciliation list.
-- ============================================================================

BEGIN;

ALTER TABLE sub_segments
  ADD COLUMN IF NOT EXISTS tone_id uuid REFERENCES prompts(id) ON DELETE SET NULL;

COMMENT ON COLUMN sub_segments.tone_id IS
  'The tone (prompts.id) this card was last written in. Per-card (single-card regen '
  'can retone one card). Null = not recorded (pre-migration or never stamped); never '
  'backfilled. Migration 030.';

COMMIT;
