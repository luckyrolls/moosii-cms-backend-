-- ============================================================================
-- MIGRATION 110: grounding instructions block + generation cap — BOTH PROJECTS (text differs per domain)
--   — APPLIED financial (2026-10-12) · Moosii PENDING   SCHEMA (two CHECKs) + DATA (one prompt_blocks row, one app_settings row)
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
--      The text is chosen by app_settings.domain (pre-checked; anything else RAISEs). The two texts differ
--      ONLY in the claim types named by the specifics rule, which mirrors each project's doc_grounded
--      review rule below (Mark, 2026-10-12: financial gets its own wording).
--        moosii:    "...and strong safety or medical claims must come from the reference documents..."
--        financial: "...and strong legal, tax or credit-score claims must come from the reference documents..."
--
--      ⚠ DRIFT WATCH — keep the block's specifics rule and the review's matching rule in step. The
--      review rule as LIVE on 2026-10-12 (active prompts row prompt_type='review_doc_grounded', model
--      gemini-2.5-flash; quoted verbatim from system_message):
--        MOOSII  row b5c7e5c9-5f0b-4002-b93c-89dec5e03ef8, system_message md5 1c4a2f4b7af0efc486cf1416833df8af (CRLF):
--          "- SPECIFIC-BUT-UNSUPPORTED — a confident specific claim (a statistic, a precise number, a named
--          guideline/threshold, a strong causal or medical assertion) that has NO provenance in ANY linked
--          document. (kind="unsupported", severity="warning", source_passage="no passage found"). Do NOT flag
--          ordinary supportive, emotional, or general prose — only confident SPECIFICS that assert fact."
--        FINANCIAL row f0890000-0000-4000-8000-000000000404 (089), md5 e33b135c476c0e50a76d97ee18bb6caa (LF):
--          "- SPECIFIC-BUT-UNSUPPORTED — a confident specific claim (a statistic, a precise number, a named rule
--          or threshold, a strong causal, legal, tax or credit-score assertion) that has NO provenance in ANY
--          linked document. (kind="unsupported", severity="warning", source_passage="no passage found"). Do NOT
--          flag ordinary supportive or general prose — only confident SPECIFICS that assert fact."
--      If either md5 above changes, re-read both rules before trusting the pair.
--   3. app_settings 'grounding_max_chars' = '30000': the total body characters across a lesson's linked
--      documents that a GROUNDED GENERATION may carry. The doc_grounded review has NO cap and never reads
--      this. A CHECK keeps the value a positive integer (structural, per invariant 3).
-- Idempotent: DROP ... IF EXISTS + ADD for the CHECKs, ON CONFLICT DO NOTHING for both rows (a re-run never
-- overwrites an edited block or a changed cap).
-- Code tolerates the pre-110 schema: flag off → nothing is read; flag on → a legible failure.
-- APPLY per migrations/README.md: financial first, then Moosii. PGCLIENTENCODING=UTF8.
-- ============================================================================

BEGIN;

ALTER TABLE public.prompt_blocks DROP CONSTRAINT IF EXISTS prompt_blocks_block_type_check;
ALTER TABLE public.prompt_blocks ADD CONSTRAINT prompt_blocks_block_type_check
  CHECK (block_type = ANY (ARRAY['tone'::text, 'structure'::text, 'length'::text, 'card_positions'::text, 'grounding'::text]));

DO $mig$
DECLARE
  v_domain text := (SELECT value FROM public.app_settings WHERE key = 'domain');
  v_claims text;
BEGIN
  v_claims := CASE v_domain
    WHEN 'moosii'    THEN 'strong safety or medical claims'
    WHEN 'financial' THEN 'strong legal, tax or credit-score claims'
  END;
  IF v_claims IS NULL THEN
    RAISE EXCEPTION '110: app_settings.domain is %, expected moosii or financial', coalesce(v_domain, 'missing');
  END IF;

  INSERT INTO public.prompt_blocks (block_type, name, label, content, is_active) VALUES
    ('grounding', 'grounding_v1', 'Grounding: reference documents (informed)',
     'The documents below are the designated sources for this lesson. Use them as the factual basis for the cards and never contradict them. Do not cite, name or quote them in the card text, and do not copy long passages; write in the voice above. The Tone, Structure, Card Positions and Length rules still apply.'
     || E'\n\n'
     || 'Numbers, ages, durations, thresholds, and ' || v_claims || ' must come from the reference documents. If the documents don''t state it, leave it out. Topics the documents don''t cover may still be written in general terms.',
     true)
  ON CONFLICT (block_type, name) DO NOTHING;
END
$mig$;

ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_grounding_max_chars_valid;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_grounding_max_chars_valid
  CHECK (key <> 'grounding_max_chars' OR value ~ '^[1-9][0-9]*$');

INSERT INTO public.app_settings (key, value) VALUES ('grounding_max_chars', '30000')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- VERIFICATION (per project, read-only):
--   SELECT (SELECT value FROM app_settings WHERE key='domain') AS domain;
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN
--     ('prompt_blocks_block_type_check','app_settings_grounding_max_chars_valid') ORDER BY conname;
--   SELECT block_type, name, label, is_active, length(content), md5(content) FROM prompt_blocks
--    WHERE block_type IN ('grounding','card_positions') ORDER BY 1;     -- card_positions md5 unchanged
--   SELECT content FROM prompt_blocks WHERE block_type='grounding';      -- the domain's claim wording
--   SELECT key, value FROM app_settings WHERE key = 'grounding_max_chars';   -- EXPECT 30000
--   Negative (rolled back): UPDATE app_settings SET value='30k' WHERE key='grounding_max_chars' → 23514.
