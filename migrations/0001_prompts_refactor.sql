-- ============================================================================
-- Migration 0001: Prompts refactor to Level 1.5 (blocks + composed prompt rows)
-- ============================================================================
--
-- WHAT THIS DOES
--   1. Creates `prompt_blocks`        — reusable, user-editable fragments
--                                       (tone / structure / length).
--   2. Creates `prompt_block_versions`— append-only edit history (revert safety).
--   3. EXTENDS the existing `prompts` table ADDITIVELY with the technical fields
--      (system_message, scope, output_schema, params, block FKs).
--   4. Seeds ONE worked example: the "Sturdy Leadership" segment_content prompt,
--      decomposed into blocks, so you can see the shape with real content.
--
-- WHY ADDITIVE, NOT A REWRITE
--   The old CMS + BuildShip still read prompts.prompt (the blob) today. Adding
--   columns lets the NEW backend read composed fields while the OLD path keeps
--   working. After CMS cutover, drop prompts.prompt (see teardown note at end).
--
-- THE EDITABLE / TECHNICAL SPLIT (your "don't let users break it" requirement)
--   EDITABLE  -> prompt_blocks (tone/structure/length). CMS exposes these.
--   TECHNICAL -> prompts.system_message / scope / output_schema / params.
--                CMS hides these. A bad edit cannot reach the card contract,
--                because output shape lives ONLY in output_schema, which is
--                not on the edit screen.
--
-- NOTE: the old REMINDER / "Output format (JSON)" / <!-- card:start --> prose is
--       DELETED in this decomposition. Output shape is output_schema, full stop.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. prompt_blocks : the editable, frequently-tuned fragments
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prompt_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_type  text NOT NULL CHECK (block_type IN ('tone', 'structure', 'length')),
  name        text NOT NULL,            -- stable machine handle, e.g. 'sturdy_leadership'
  label       text,                     -- human label for the CMS picker
  content     text NOT NULL,            -- the text injected into the composed prompt
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (block_type, name)
);

-- ----------------------------------------------------------------------------
-- 2. prompt_block_versions : append a row on every block edit, for revert
--    (cheap insurance on the one thing you said you're nervous about)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prompt_block_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id   uuid NOT NULL REFERENCES prompt_blocks(id) ON DELETE CASCADE,
  content    text NOT NULL,             -- snapshot of content AT save time
  edited_by  text,                      -- co-founder identifier, if you have one
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pbv_block ON prompt_block_versions (block_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 3. Extend existing `prompts` (ADDITIVE — old `prompt` blob column untouched)
-- ----------------------------------------------------------------------------
ALTER TABLE prompts
  ADD COLUMN IF NOT EXISTS system_message     text,
  ADD COLUMN IF NOT EXISTS scope              text,
  ADD COLUMN IF NOT EXISTS output_schema      jsonb,
  ADD COLUMN IF NOT EXISTS model              text,
  ADD COLUMN IF NOT EXISTS temperature        numeric,
  ADD COLUMN IF NOT EXISTS max_tokens         integer,
  ADD COLUMN IF NOT EXISTS tone_block_id      uuid REFERENCES prompt_blocks(id),
  ADD COLUMN IF NOT EXISTS structure_block_id uuid REFERENCES prompt_blocks(id),
  ADD COLUMN IF NOT EXISTS length_block_id    uuid REFERENCES prompt_blocks(id),
  ADD COLUMN IF NOT EXISTS is_active          boolean NOT NULL DEFAULT true;

-- ============================================================================
-- SEED: decompose the real "Sturdy Leadership" segment prompt into rows
-- ============================================================================

-- --- TONE block ------------------------------------------------------------
INSERT INTO prompt_blocks (block_type, name, label, content) VALUES
('tone', 'sturdy_leadership', 'Sturdy Leadership (Good Inside-inspired)',
$tone$Write like a calm, connected, confident parent-leader: warm + steady + boundaried.
- Prioritize connection and skill-building over punishment.
- Use "both/and" language (e.g., "You're upset, and it's still time to stop.") / "two things are true."
- Validate feelings without changing the boundary. Avoid lecturing, shaming, or fear-based language.
- Include at least 1 short "script" parents can say out loud (1-2 sentences), tailored to the segment.
- Emphasize co-regulation: parent stays calm and grounded; the child can have big feelings safely.
- If relevant, include a brief "repair" step (what to say/do after everyone calms down).$tone$)
ON CONFLICT (block_type, name) DO NOTHING;

-- --- STRUCTURE block -------------------------------------------------------
INSERT INTO prompt_blocks (block_type, name, label, content) VALUES
('structure', 'sturdy_6_card_arc', 'Sturdy 6-card arc',
$structure$Organize the cards along this arc (6-9 cards):
1) Connection + frame: reassurance + what you're leading toward (1-2 sentences)
2) What's true: the key idea in plain language ("both things can be true...")
3) What to say: 1-2 example scripts (short, repeatable)
4) What to do: practical steps (bullets/numbered) that match the segment
5) When it's hard: common pushback + how to stay sturdy (and what not to do)
6) Repair + recap: quick repair language (if relevant) + the closing takeaway$structure$)
ON CONFLICT (block_type, name) DO NOTHING;

-- --- LENGTH block ----------------------------------------------------------
-- NOTE: this block straddles editable/technical (see chat). The word targets
-- are editorial; the rigid caps (sentence/bullet length, max bullets) are
-- closer to machine constraints. Left together for now per "just get it working".
INSERT INTO prompt_blocks (block_type, name, label, content) VALUES
('length', 'standard_400', 'Standard (~400 words, tight cards)',
$length$Target ~400 words total across all cards (acceptable range 350-450).
Keep cards tight (~45-70 words each). Each card stands alone with a clear mini-topic.
- Sentences under 19 words.
- Bullets under 13 words.
- Maximum of 4 bullets or 4 numbered items per card.
If a card topic is too big, split into two cards, ending the first with a line:
"_Continues on next card -->_". Only split when necessary.$length$)
ON CONFLICT (block_type, name) DO NOTHING;

-- --- The composed prompt row ------------------------------------------------
-- system_message: stable per-operation framing, with ALL output-shape prose
--                 removed (that now lives in output_schema).
-- scope:          mild plumbing, inlined.
-- output_schema:  THE source of truth for response_format. Cards array of
--                 {title, content}. Takeaway is just the final card (no special
--                 field). References deliberately EXCLUDED from generator output
--                 (fabrication risk) — tell me if you want them back.
INSERT INTO prompts (
  prompt_type, tone, "default", is_active,
  system_message, scope,
  model, temperature, max_tokens,
  tone_block_id, structure_block_id, length_block_id,
  output_schema
)
SELECT
  'segment_content',
  'Sturdy Leadership',          -- keep your existing tone selector value
  false,
  true,
  $sys$You are an expert in early childhood education and safety, writing for new parents who are often tired, overwhelmed, and emotionally raw. Generate clear, supportive, engaging educational content. Each piece of content is a "card": a single self-contained idea sized for one mobile screen. Use friendly, accessible language; avoid jargon and excessive technical detail. Every card must stand on its own with a clear mini-topic.$sys$,
  $scope$Use the lesson title only as background context. The content must focus tightly on the lesson. Do NOT broaden into other lesson topics.$scope$,
  'gpt-5.1',                    -- TODO: set to your real model string
  1.0,                          -- TODO: verify model accepts this
  3000,
  (SELECT id FROM prompt_blocks WHERE block_type='tone'      AND name='sturdy_leadership'),
  (SELECT id FROM prompt_blocks WHERE block_type='structure' AND name='sturdy_6_card_arc'),
  (SELECT id FROM prompt_blocks WHERE block_type='length'    AND name='standard_400'),
  $schema${
    "name": "SegmentCards",
    "strict": true,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "cards": {
          "type": "array",
          "description": "Ordered cards (sub_segments). The final card is the takeaway.",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "title":   { "type": "string", "description": "Short card title." },
              "content": { "type": "string", "description": "Card body in markdown." }
            },
            "required": ["title", "content"]
          }
        }
      },
      "required": ["cards"]
    }
  }$schema$::jsonb;

COMMIT;

-- ============================================================================
-- POST-CUTOVER TEARDOWN (run later, NOT now — after the new CMS is live):
--   ALTER TABLE prompts DROP COLUMN prompt;     -- retire the old blob
-- ============================================================================
