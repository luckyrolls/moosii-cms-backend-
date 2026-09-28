-- ============================================================================
-- MIGRATION 100: financial — no amounts, not even as examples (tone + quiz) + lesson typo
--   — APPLIED financial 2026-09-28   *** FINANCIAL ONLY ***   DATA ONLY
-- ============================================================================
-- WHY (FINDINGS-financial-images.md §5; decisions Mark 2026-09-28): the Plain Money tone forbade the
-- READER'S amounts ("you do not know them"), and gpt-4o read worked examples as allowed — cards 2-3
-- of "Why Your Credit Balance-to-Limit Ratio Matters" say "$1,000", "$300", "$400". The quiz prompt
-- does not see the tone block and only forbade amounts "the content does not contain".
--
-- 1. prompt_blocks f0840000-…0204 (tone "plain_money"): the amounts sentence is replaced with Mark's
--    wording. The prior text is appended to prompt_block_versions first (revert point; that table's
--    documented purpose — no code writes it today). md5 39092208… → ff8985d0….
-- 2. prompts f0890000-…0402 (financial quiz): Mark's same sentence appended as a new paragraph.
--    md5 46f131e1… → 52add72d….
-- 3. lessons f9b2c834-… description: "hat credit utilization…" → "What credit utilization…".
--    md5 5eec1ce0… → 65a642ec…. The lesson is unpublished, so content_edit_policy_guard (financial
--    lock on published lessons) lets it through.
--
-- NOT HERE — the voice_lint_rule Mark asked for (currency regex). It cannot be expressed with today's
-- engine: voice_lint_rules.type is CHECK-limited to ban|opener|limit|conditional|repeat (012), every
-- pattern is escaped and matched as a literal whole phrase (src/lib/voiceLint.ts phraseRegex), the
-- loader ignores the `tone` column, and error-severity `ban` rows are injected VERBATIM into every
-- generation prompt (loadPromptBanInstruction). A regex seeded as a ban would never match and would
-- put "\$\s?\d" into every financial content prompt. Needs a `regex` rule type (code + CHECK, both
-- projects) — see the report.
--
-- GUARDS (like 083): each change runs only when the live value's md5 is exactly the expected prior
-- text; if it is already the new text it is a no-op (NOTICE); anything else RAISES and nothing applies.
-- All three live values are LF (no CR). Every literal below is CR-stripped, so a CRLF checkout of
-- this file still writes LF.
-- APPLY per migrations/README.md: FINANCIAL ONLY. Idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only). EXPECT financial; 39092208ae615e67ac6d4d6518dc274e;
-- 46f131e176d06008470b91906c76ecdc; 5eec1ce0e94897f6c31a297fdd46a393 / is_published f:
--   SELECT value FROM app_settings WHERE key = 'domain';
--   SELECT md5(content) FROM prompt_blocks WHERE id = 'f0840000-0000-4000-8000-000000000204';
--   SELECT md5(system_message) FROM prompts WHERE id = 'f0890000-0000-4000-8000-000000000402';
--   SELECT md5(description), is_published FROM lessons WHERE id = 'f9b2c834-5288-4ef9-9899-12aa35d3dba4';
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
DECLARE
  cur text;
  old_sentence text := replace($o$Do not state dollar amounts or balances — you do not know them. Refer to the reader's
own numbers generically ("your balance", "the card with the highest rate").$o$, E'\r', '');
  new_sentence text := replace($n$Never write a dollar amount, price, balance or limit, not even as an example. Explain rules in
words and ratios; 'under 30% of your limit' is allowed as a guideline. Refer to the reader's own
figures generically ('your balance').$n$, E'\r', '');
  quiz_rule text := $q$Never write a dollar amount, price, balance or limit, not even as an example. Explain rules in words and ratios; 'under 30% of your limit' is allowed as a guideline. Refer to the reader's own figures generically ('your balance').$q$;
BEGIN
  IF (SELECT value FROM app_settings WHERE key = 'domain') IS DISTINCT FROM 'financial' THEN
    RAISE EXCEPTION '100 is FINANCIAL ONLY — app_settings.domain is not ''financial''';
  END IF;

  -- 1. tone block
  SELECT md5(content) INTO cur FROM prompt_blocks WHERE id = 'f0840000-0000-4000-8000-000000000204';
  IF cur IS NULL THEN
    RAISE EXCEPTION '100: tone block …0204 not found';
  ELSIF cur = 'ff8985d0d519e748c42132d0b3476411' THEN
    RAISE NOTICE '100: tone block already carries the no-amounts rule — no change';
  ELSIF cur <> '39092208ae615e67ac6d4d6518dc274e' THEN
    RAISE EXCEPTION '100: tone block md5 % is not the expected prior text — re-base before applying', cur;
  ELSE
    INSERT INTO prompt_block_versions (block_id, content, edited_by)
      SELECT id, content, NULL FROM prompt_blocks WHERE id = 'f0840000-0000-4000-8000-000000000204';
    UPDATE prompt_blocks SET content = replace(content, old_sentence, new_sentence), updated_at = now()
     WHERE id = 'f0840000-0000-4000-8000-000000000204';
    SELECT md5(content) INTO cur FROM prompt_blocks WHERE id = 'f0840000-0000-4000-8000-000000000204';
    IF cur <> 'ff8985d0d519e748c42132d0b3476411' THEN
      RAISE EXCEPTION '100: tone block result md5 % is not the expected new text', cur;
    END IF;
  END IF;

  -- 2. quiz prompt
  SELECT md5(system_message) INTO cur FROM prompts WHERE id = 'f0890000-0000-4000-8000-000000000402';
  IF cur IS NULL THEN
    RAISE EXCEPTION '100: quiz prompt …0402 not found';
  ELSIF cur = '52add72d369cfdf049b5c5f3e2509af8' THEN
    RAISE NOTICE '100: quiz prompt already carries the no-amounts rule — no change';
  ELSIF cur <> '46f131e176d06008470b91906c76ecdc' THEN
    RAISE EXCEPTION '100: quiz prompt md5 % is not the expected prior text — re-base before applying', cur;
  ELSE
    UPDATE prompts SET system_message = system_message || E'\n\n' || quiz_rule
     WHERE id = 'f0890000-0000-4000-8000-000000000402';
    SELECT md5(system_message) INTO cur FROM prompts WHERE id = 'f0890000-0000-4000-8000-000000000402';
    IF cur <> '52add72d369cfdf049b5c5f3e2509af8' THEN
      RAISE EXCEPTION '100: quiz prompt result md5 % is not the expected new text', cur;
    END IF;
  END IF;

  -- 3. lesson description typo
  SELECT md5(description) INTO cur FROM lessons WHERE id = 'f9b2c834-5288-4ef9-9899-12aa35d3dba4';
  IF cur IS NULL THEN
    RAISE EXCEPTION '100: lesson f9b2c834… not found (or null description)';
  ELSIF cur = '65a642ec1888ebb164a4faf24ebddde4' THEN
    RAISE NOTICE '100: lesson description already fixed — no change';
  ELSIF cur <> '5eec1ce0e94897f6c31a297fdd46a393' THEN
    RAISE EXCEPTION '100: lesson description md5 % is not the expected prior text — re-base before applying', cur;
  ELSE
    UPDATE lessons SET description = 'W' || description WHERE id = 'f9b2c834-5288-4ef9-9899-12aa35d3dba4';
  END IF;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION — read the rows back. EXPECT ff8985d0…, 52add72d…, 65a642ec…, and one
-- prompt_block_versions row for …0204 whose md5 is 39092208… (the prior text):
--   SELECT md5(content), content FROM prompt_blocks WHERE id = 'f0840000-0000-4000-8000-000000000204';
--   SELECT md5(system_message), system_message FROM prompts WHERE id = 'f0890000-0000-4000-8000-000000000402';
--   SELECT md5(description), description FROM lessons WHERE id = 'f9b2c834-5288-4ef9-9899-12aa35d3dba4';
--   SELECT md5(content), created_at FROM prompt_block_versions WHERE block_id = 'f0840000-0000-4000-8000-000000000204';
-- ---------------------------------------------------------------------------
