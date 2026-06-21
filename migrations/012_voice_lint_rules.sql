-- ============================================================================
-- Migration 012 (main track): voice_lint_rules — deterministic AI-tell rule list
-- ============================================================================
-- Editable rule DATA for the deterministic voice lint. The matcher ENGINE lives
-- in source code (src/lib/voiceLint.ts); only the phrase list lives here so the
-- 3 trusted editors can grow it from observed output without a deploy — same
-- split as prompts/prompt_blocks (logic in code, content in DB).
--
-- Rule types:
--   ban         — any occurrence is a hit
--   opener      — hit only when `pattern` STARTS a card (throat-clearing)
--   limit       — allowed up to `max` within `scope`; hit beyond that
--   conditional — hit UNLESS `requires` appears within `within_chars` after the
--                 match (fallible heuristic → severity locked to 'warn')
--   repeat      — generic: any `min_words`-word phrase repeated across cards in
--                 a segment (no `pattern`)
-- `tone` is null = global; reserved for future per-tone scoping.
-- Polymorphic columns are loosely typed on purpose — the matcher validates and
-- skips malformed rows rather than failing generation. No version-history table
-- (advisory, low-stakes).
--
-- APPLIED VIA THE SUPABASE SQL EDITOR — not in supabase_migrations.schema_
-- migrations; on the 008/009/010/011/012 files-vs-DB reconciliation list.
-- Idempotent: safe to re-run (create if not exists + on conflict do nothing).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS voice_lint_rules (
  id           uuid primary key default gen_random_uuid(),
  rule_key     text unique not null,          -- stable handle, e.g. "imp-to"
  type         text not null check (type in ('ban','opener','limit','conditional','repeat')),
  pattern      text,                           -- null for 'repeat'
  max          integer,                        -- 'limit'
  scope        text check (scope in ('card','segment')),  -- 'limit' / 'repeat'
  requires     text,                           -- 'conditional'
  within_chars integer,                        -- 'conditional'
  min_words    integer,                        -- 'repeat'
  severity     text not null check (severity in ('error','warn')),
  message      text not null,
  tone         text,                           -- null = global; future per-tone scoping
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- --- Seed: starter rule list -----------------------------------------------
INSERT INTO voice_lint_rules
  (rule_key, type, pattern, max, scope, requires, within_chars, min_words, severity, message)
VALUES
  -- AI tells / hedging : ban
  ('imp-to',      'ban', 'it''s important to',    null, null, null, null, null, 'error', 'Throat-clearing hedge - make the direct claim instead.'),
  ('many-find',   'ban', 'many parents find',     null, null, null, null, null, 'error', 'Generic AI framing - say it plainly.'),
  ('eotd',        'ban', 'at the end of the day', null, null, null, null, null, 'error', 'Filler cliche - cut it.'),
  ('when-comes',  'ban', 'when it comes to',      null, null, null, null, null, 'warn',  'Throat-clearing - start with the point.'),
  ('the-truth',   'ban', 'the truth is',          null, null, null, null, null, 'warn',  'Hedge - just state it.'),
  ('its-worth',   'ban', 'it''s worth noting',    null, null, null, null, null, 'warn',  'Filler - if it is worth noting, note it.'),
  ('rest-assure', 'ban', 'rest assured',          null, null, null, null, null, 'warn',  'Reassurance cliche.'),
  ('navigating',  'ban', 'navigating',            null, null, null, null, null, 'warn',  'Overused AI verb - be concrete.'),

  -- Throat-clearing openers : opener
  ('open-remember', 'opener', 'remember that', null, null, null, null, null, 'warn', 'Card opens with throat-clearing - lead with the idea.'),
  ('open-keep',     'opener', 'keep in mind',  null, null, null, null, null, 'warn', 'Card opens with a hedge.'),
  ('open-asparent', 'opener', 'as a parent',   null, null, null, null, null, 'warn', 'Generic opener - get specific.'),

  -- Overused stock phrases : limit (per segment)
  ('both-true',  'limit', 'both things can be true', 1, 'segment', null, null, null, 'warn', 'Stock phrase repeated - vary the wording.'),
  ('two-true',   'limit', 'two things are true',     1, 'segment', null, null, null, 'warn', 'Stock phrase repeated - vary the wording.'),
  ('not-alone',  'limit', 'you''re not alone',       2, 'segment', null, null, null, 'warn', 'Overused - 1 to 2 per segment max.'),
  ('every-baby', 'limit', 'every baby is different', 1, 'segment', null, null, null, 'warn', 'Parenting cliche - limit and ground it.'),

  -- Allowed only if a concrete script follows : conditional (heuristic, warn-only)
  ('you-can-say', 'conditional', 'you can say', null, null, '"', 120, null, 'warn',
   'Suggests a script but no quoted line follows - add the exact words to say.'),

  -- Generic cross-card repetition : repeat
  ('repeat-3gram', 'repeat', null, null, 'segment', null, null, 3, 'warn',
   'Phrase repeated across cards - rephrase one.')
ON CONFLICT (rule_key) DO NOTHING;

COMMIT;
