-- ============================================================================
-- MIGRATION 108: voice lint — ban internal terms ("segment", "sub-segment", "card series") — BOTH PROJECTS
--   — APPLIED financial (2026-10-01) · APPLIED Moosii (2026-10-01)   DATA ONLY (voice_lint_rules rows)
-- ============================================================================
-- WHY (Mark, 2026-10-01): "segment" / "sub-segment" are internal names; readers must only ever see
-- "lesson", "activity" or nothing. Audit 2026-10-01: every hit is in QUIZ text ("According to the segment…",
-- "The segment says…") — financial 5, Moosii 163 — echoed from the quiz prompt's "supplied segment content".
--
-- WHAT: four error-severity `ban` rules. Error-severity bans are (a) injected verbatim into the prompt as
-- "Never use these phrases or close variants of them: …" (loadPromptBanInstruction) and (b) flagged by the
-- deterministic lint on generated cards (lintSegmentCards → jobs.result.lint). Patterns are matched as whole
-- phrases on lowercased text, so "segment" also catches "sub-segment".
-- Where they apply (code, same commit): segment content generate + regen (already), and now the QUIZ prompt
-- (generateQuiz.ts `## Avoid`). NOT injected: lesson stubs (generate_lessons / coverage_audit), questionnaires,
-- the reviewer — see the report.
-- The rules carry no tone: the engine ignores `tone`, so they apply to every tone on the project.
-- Idempotent: ON CONFLICT (rule_key) DO NOTHING.
-- APPLY per migrations/README.md: financial first, then Moosii.
-- ============================================================================

BEGIN;

INSERT INTO public.voice_lint_rules (rule_key, type, pattern, severity, message, is_active) VALUES
  ('ban_internal_segment',          'ban', 'segment',          'error', 'internal term "segment" — say "lesson", "activity" or nothing', true),
  ('ban_internal_sub_segment',      'ban', 'sub-segment',      'error', 'internal term "sub-segment" — say "card" or nothing',             true),
  ('ban_internal_card_series',      'ban', 'card series',      'error', 'internal term "card series" — say "lesson" or "activity"',      true),
  ('ban_internal_this_card_series', 'ban', 'this card series', 'error', 'internal term "this card series" — say "this lesson" or "this activity"', true)
ON CONFLICT (rule_key) DO NOTHING;

COMMIT;

-- VERIFICATION: 4 rows with these rule_keys, type ban, severity error, active; loadPromptBanInstruction() output
-- lists all four; lintCards flags a card containing "the segment" / "this card series".
