-- ============================================================================
-- MIGRATION 109: prompt rows — replace internal "segment" wording with reader-neutral terms — BOTH PROJECTS
--   — APPLIED financial (2026-10-01) · APPLIED Moosii (2026-10-01)   DATA ONLY (prompts + prompt_blocks text)
-- ============================================================================
-- WHY (Mark, 2026-10-01): "segment" is an internal name. The quiz prompt told the model to quiz "the supplied
-- segment content", and the model echoed it into 168 live quiz texts ("According to the segment…"). 108 banned
-- the word; this removes it from the prompts themselves so they no longer contradict the ban.
--
-- WORD SWAPS ONLY — each is ONE exact substring, replaced in place (line endings untouched: the old text never
-- spans a CRLF; financial's lesson prompt has a plain LF inside the phrase, kept as-is):
--   quiz system_message + scope   "the supplied segment content"              → "the supplied lesson's cards"
--   quiz output_schema description "Quiz questions generated from the segment content." → "… from the lesson's cards."
--   lesson + coverage_audit       "(segment content is generated downstream)" → "(the lesson's cards are generated downstream)"
--   standard_arc (structure)      "to the segment."                           → "to the lesson."
--   MOOSII: sturdy_6_card_arc     "that match the segment"                    → "that match the lesson"
--   MOOSII: sturdy_leadership     "tailored to the segment."                  → "tailored to the lesson."
-- NOT changed: JSON-schema identifiers ("name": "SegmentQuiz" / "SegmentCards") and the segment-prompt schema
-- description "Ordered cards (sub_segments)…" — identifiers, and outside this brief (reported).
--
-- GUARDED per row: the live md5 must be exactly the expected BEFORE (→ swap, then the AFTER md5 is asserted) or
-- already the AFTER (→ no-op); anything else RAISES and the whole file rolls back. md5s are of the stored text as-is.
-- prompt_version (sha256 of system_message) changes for quiz / lesson / coverage_audit, visible in provenance.
-- card_positions is NOT touched (it never contained the word).
--
-- APPLY per migrations/README.md: financial first, then Moosii.
-- ============================================================================

BEGIN;

DO $m109$
DECLARE
  v_dom text := (SELECT value FROM app_settings WHERE key = 'domain');
  r   record;
  cur text;
  n   int;
BEGIN
  IF v_dom NOT IN ('financial', 'moosii') THEN
    RAISE EXCEPTION '109: unexpected app_settings.domain %', v_dom;
  END IF;

  CREATE TEMP TABLE m109_swaps (dom text, tbl text, sel text, col text, old text, new text, md5_before text, md5_after text) ON COMMIT DROP;
  INSERT INTO m109_swaps VALUES
    -- financial
    ('financial','prompts','quiz','system_message','the supplied segment content','the supplied lesson''s cards','52add72d369cfdf049b5c5f3e2509af8','2ea099b28416d49950bbce0b019b5029'),
    ('financial','prompts','quiz','scope','the supplied segment content','the supplied lesson''s cards','47774db136fe9a714590ec747bbd160d','de29e72c8fb13393f9dbf9bd50166526'),
    ('financial','prompts','lesson','system_message',E'(segment\ncontent is generated downstream)',E'(the lesson''s cards\nare generated downstream)','c49d8ef472e9d967e4faaee96c2f8609','ebbe855f135b01f96e344b379e47454e'),
    ('financial','prompts','coverage_audit','system_message','(segment content is generated downstream)','(the lesson''s cards are generated downstream)','aa42b50ae83042397a5c778681d936e9','db5df8dfa54ad5f13a5397d016ff2c10'),
    ('financial','prompt_blocks','standard_arc','content','to the segment.','to the lesson.','73ea6fd31f26650dfa6c0ba5f911dfd2','c2794594e81e42e356351b0b527c6d42'),
    -- moosii
    ('moosii','prompts','quiz','system_message','the supplied segment content','the supplied lesson''s cards','c9f7c68339585d478dc0b6ff21d0d7f1','de87a793b76b4708a4f93ba07d6278f4'),
    ('moosii','prompts','quiz','scope','the supplied segment content','the supplied lesson''s cards','47774db136fe9a714590ec747bbd160d','de29e72c8fb13393f9dbf9bd50166526'),
    ('moosii','prompts','lesson','system_message','(segment content is generated downstream)','(the lesson''s cards are generated downstream)','ba3d08834fc0137af85c0761245a8516','6cfad49ff13a98c939c47ab1dff0b275'),
    ('moosii','prompts','coverage_audit','system_message','(segment content is generated downstream)','(the lesson''s cards are generated downstream)','667575c03a10b3578533022c7c951c72','2a91f9813f883cfa6be0ca39e12aea3e'),
    ('moosii','prompt_blocks','standard_arc','content','to the segment.','to the lesson.','ced61a0decb39c6ce3186ba3a20f2625','408ce4a3b6bb75fb953e8d31b087b3a3'),
    ('moosii','prompt_blocks','sturdy_6_card_arc','content','that match the segment','that match the lesson','57f6178483edd9107afd899655372b9a','86cea416b5baa2db62168252a148a5dd'),
    ('moosii','prompt_blocks','sturdy_leadership','content','tailored to the segment.','tailored to the lesson.','5879533a9a6c133c527621b2ea172e94','c3fbd513a10b9348ddde77d8400a6af1');

  FOR r IN SELECT * FROM m109_swaps WHERE m109_swaps.dom = v_dom LOOP
    -- exactly one target row: the ACTIVE prompt of that type, or the block of that name
    IF r.tbl = 'prompts' THEN
      EXECUTE format('SELECT count(*), max(md5(%I)) FROM prompts WHERE prompt_type = $1 AND is_active', r.col) INTO n, cur USING r.sel;
    ELSE
      EXECUTE format('SELECT count(*), max(md5(%I)) FROM prompt_blocks WHERE name = $1', r.col) INTO n, cur USING r.sel;
    END IF;
    IF n <> 1 THEN
      RAISE EXCEPTION '109: % % — expected exactly 1 row, found %', r.tbl, r.sel, n;
    END IF;

    IF cur = r.md5_after THEN
      RAISE NOTICE '109: %.% (%) already swapped — no change', r.tbl, r.col, r.sel;
      CONTINUE;
    ELSIF cur <> r.md5_before THEN
      RAISE EXCEPTION '109: %.% (%) md5 % is not the expected text % — re-base before applying', r.tbl, r.col, r.sel, cur, r.md5_before;
    END IF;

    IF r.tbl = 'prompts' THEN
      EXECUTE format('UPDATE prompts SET %1$I = replace(%1$I, $2, $3), updated_at = now() WHERE prompt_type = $1 AND is_active AND strpos(%1$I, $2) > 0', r.col) USING r.sel, r.old, r.new;
      EXECUTE format('SELECT md5(%I) FROM prompts WHERE prompt_type = $1 AND is_active', r.col) INTO cur USING r.sel;
    ELSE
      EXECUTE format('UPDATE prompt_blocks SET %1$I = replace(%1$I, $2, $3), updated_at = now() WHERE name = $1 AND strpos(%1$I, $2) > 0', r.col) USING r.sel, r.old, r.new;
      EXECUTE format('SELECT md5(%I) FROM prompt_blocks WHERE name = $1', r.col) INTO cur USING r.sel;
    END IF;
    IF cur <> r.md5_after THEN
      RAISE EXCEPTION '109: %.% (%) after-swap md5 % <> expected %', r.tbl, r.col, r.sel, cur, r.md5_after;
    END IF;
    IF cur = r.md5_before THEN
      RAISE EXCEPTION '109: %.% (%) unchanged — old text not found', r.tbl, r.col, r.sel;
    END IF;
  END LOOP;

  -- quiz output_schema: the one model-visible description (same text on both projects)
  SELECT count(*) INTO n FROM prompts WHERE prompt_type = 'quiz' AND is_active;
  IF n <> 1 THEN RAISE EXCEPTION '109: expected 1 active quiz prompt, found %', n; END IF;
  SELECT output_schema #>> '{schema,properties,questions,description}' INTO cur FROM prompts WHERE prompt_type = 'quiz' AND is_active;
  IF cur = 'Quiz questions generated from the lesson''s cards.' THEN
    RAISE NOTICE '109: quiz output_schema description already swapped — no change';
  ELSIF cur = 'Quiz questions generated from the segment content.' THEN
    UPDATE prompts
       SET output_schema = jsonb_set(output_schema, '{schema,properties,questions,description}', to_jsonb('Quiz questions generated from the lesson''s cards.'::text)),
           updated_at = now()
     WHERE prompt_type = 'quiz' AND is_active;
  ELSE
    RAISE EXCEPTION '109: quiz output_schema description is %, not the expected text', coalesce(cur, 'NULL');
  END IF;
END
$m109$;

COMMIT;

-- VERIFICATION (per project): no active quiz / lesson / coverage_audit system_message or scope matches 'segment';
-- the quiz output_schema description reads "…from the lesson's cards."; standard_arc (and on Moosii
-- sturdy_6_card_arc, sturdy_leadership) content does not match 'segment'.
