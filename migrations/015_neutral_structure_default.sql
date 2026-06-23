-- ============================================================================
-- Migration 015 (main track): neutral default structure ('standard_arc')
-- ============================================================================
-- The shared sturdy_6_card_arc structure block carries voice-specific language
-- (reassurance, example scripts, "stay sturdy", "repair", "both things can be
-- true") — it's really the Sturdy Leadership arc, yet every tone was forced into
-- it, homogenizing output and seeding "both things can be true" across all tones.
--
-- This adds a NEUTRAL structure (card functions only) and repoints every segment
-- tone currently on sturdy_6_card_arc to it — EXCEPT the Sturdy/Good-Inside tone
-- (identified by its sturdy_leadership voice block), where the sturdy arc belongs.
--
-- Pure DML (no DDL). Applied by the assistant via PostgREST (service role, which
-- bypasses RLS); idempotent (on-conflict no-op + the UPDATE only matches rows
-- still on the sturdy arc). On the 008..015 reconciliation list.
-- ============================================================================

BEGIN;

-- 1. Neutral structure block.
INSERT INTO prompt_blocks (block_type, name, label, content)
VALUES (
  'structure', 'standard_arc', 'Standard arc (neutral)',
$arc$Organize the content as a sequence of cards (6-9), each one self-contained idea:
1) Open: orient the reader to this specific topic in a sentence or two — what it is and why it matters now.
2) Core idea: the central point, in plain language.
3) How it works / what to know: the key facts or reasoning behind it.
4) What to do: concrete, practical steps (bullets or numbered) specific to the segment.
5) Watch-outs: common mistakes, edge cases, or when to seek help.
6) Takeaway: the one thing to remember.
Add cards only if the topic genuinely needs them; keep each card to one idea.$arc$
)
ON CONFLICT (block_type, name) DO NOTHING;

-- 2. Repoint all segment tones on the sturdy arc to the neutral one, except the
--    tone whose voice block is sturdy_leadership (keeps the sturdy arc).
UPDATE prompts
SET    structure_block_id = (SELECT id FROM prompt_blocks WHERE block_type='structure' AND name='standard_arc'),
       updated_at = now()
WHERE  prompt_type = 'segment'
  AND  structure_block_id = (SELECT id FROM prompt_blocks WHERE block_type='structure' AND name='sturdy_6_card_arc')
  AND  tone_block_id IS DISTINCT FROM (SELECT id FROM prompt_blocks WHERE block_type='tone' AND name='sturdy_leadership');

COMMIT;
