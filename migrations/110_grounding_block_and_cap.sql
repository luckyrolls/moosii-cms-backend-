-- ============================================================================
-- MIGRATION 110: grounding instructions block + generation cap — BOTH PROJECTS
--   — DRAFT (pending apply)   SCHEMA (two CHECKs) + DATA (one prompt_blocks row, one app_settings row)
-- ============================================================================
-- WHY (Mark, 2026-10-12): `use_source_documents` on generate_segment_content / regen_segment_content
-- (dd99d1b) put the lesson's linked source documents into the prompt under framing text that lived in
-- code. The framing moves to the DB, and the size cap moves to app_settings instead of a code literal.
-- The code FAILS before the model call when either row is missing, malformed or the block is inactive.
-- It never falls back to text or a number in code (src/lib/grounding.ts, src/lib/sourceDocuments.ts
-- loadGrounding).
--
-- WHAT:
--   1. prompt_blocks.block_type CHECK gains 'grounding' (live: tone | structure | length | card_positions).
--   2. One shared singleton block, resolved by (block_type, name) = ('grounding', 'grounding_v1'), the
--      same immutable-name rule as card_positions. It is NOT referenced from `prompts` (grounding depends
--      on the lesson's docs, not on the tone). The card_positions block is NOT touched.
--      The specifics rule mirrors the doc_grounded review, which flags unsupported specifics.
--   3. app_settings 'grounding_max_chars' = '30000': the total body characters across a lesson's linked
--      documents that a GROUNDED GENERATION may carry. The doc_grounded review has NO cap and never reads
--      this. A CHECK keeps the value a positive integer (structural, per invariant 3).
-- The same text goes to both projects (the rules are domain-neutral). Idempotent: DROP ... IF EXISTS +
-- ADD for the CHECKs, ON CONFLICT DO NOTHING for both rows (a re-run never overwrites an edited block or
-- a changed cap).
-- Code tolerates the pre-110 schema: flag off → nothing is read; flag on → a legible failure.
-- APPLY per migrations/README.md: financial first, then Moosii. PGCLIENTENCODING=UTF8.
-- ============================================================================

BEGIN;

ALTER TABLE public.prompt_blocks DROP CONSTRAINT IF EXISTS prompt_blocks_block_type_check;
ALTER TABLE public.prompt_blocks ADD CONSTRAINT prompt_blocks_block_type_check
  CHECK (block_type = ANY (ARRAY['tone'::text, 'structure'::text, 'length'::text, 'card_positions'::text, 'grounding'::text]));

INSERT INTO public.prompt_blocks (block_type, name, label, content, is_active) VALUES
  ('grounding', 'grounding_v1', 'Grounding: reference documents (informed)',
$grounding$The documents below are the designated sources for this lesson. Use them as the factual basis for the cards and never contradict them. Do not cite, name or quote them in the card text, and do not copy long passages; write in the voice above. The Tone, Structure, Card Positions and Length rules still apply.

Numbers, ages, durations, thresholds, and strong safety or medical claims must come from the reference documents. If the documents don't state it, leave it out. Topics the documents don't cover may still be written in general terms.$grounding$,
   true)
ON CONFLICT (block_type, name) DO NOTHING;

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_grounding_max_chars_valid;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_grounding_max_chars_valid
  CHECK (key <> 'grounding_max_chars' OR value ~ '^[1-9][0-9]*$');

INSERT INTO public.app_settings (key, value) VALUES ('grounding_max_chars', '30000')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- VERIFICATION (per project, read-only):
--   SELECT (SELECT value FROM app_settings WHERE key='domain') AS domain;
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN
--     ('prompt_blocks_block_type_check','app_settings_grounding_max_chars_valid') ORDER BY conname;
--   SELECT block_type, name, label, is_active, length(content), md5(content) FROM prompt_blocks
--    WHERE block_type IN ('grounding','card_positions') ORDER BY 1;     -- card_positions md5 unchanged
--   SELECT key, value FROM app_settings WHERE key = 'grounding_max_chars';   -- EXPECT 30000
--   Negative (rolled back): UPDATE app_settings SET value='30k' WHERE key='grounding_max_chars' → 23514.
