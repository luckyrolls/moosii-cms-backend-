-- ============================================================================
-- Migration 0003: Populate the 9 `segment` prompt rows for the new (0001) schema
-- ============================================================================
--
-- WHY
--   The CMS-created segment prompts (prompt_type='segment') only ever had the
--   legacy `prompt` blob. The post-0001 handler reads system_message +
--   output_schema + model + block FKs, so generation failed ("... has no
--   system_message"). This migrates all 9 tones onto the new structure.
--
-- APPROACH (per product decision)
--   - SHARED system_message, scope, output_schema, and the structure/length
--     blocks (sturdy_6_card_arc / standard_400, seeded in 0001) across all rows.
--   - PER-TONE `tone` blocks, lifted from each row's legacy blob TONE section.
--   - model = 'gpt-4o' (what the handlers actually run).
--   Structure/length are intentionally shared for now; tune per-tone later in
--   the CMS. (Note: 'Short' / 'With Image' originally specified a shorter length
--   and 'Calm clinician' / 'Checklist coach' / 'Myth buster' distinct arcs —
--   those nuances are dropped by the shared-block choice and can be restored
--   with dedicated blocks later.)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Per-tone TONE blocks (sturdy_leadership already exists from 0001 and is
--    reused for the "Good inside inspired" tone).
-- ----------------------------------------------------------------------------
INSERT INTO prompt_blocks (block_type, name, label, content) VALUES
('tone', 'calm_clinician', 'Calm clinician (reassuring + authoritative)',
$t$Write like a calm, experienced pediatric clinician or postpartum nurse educator.
- Warm, steady, and matter-of-fact. Reassure briefly, then explain clearly.
- Use plain language; define any necessary terms in-line.
- Avoid absolutes ("always/never/should") and avoid fear-based language.
- Use "often/can/may" when appropriate; be precise about what is known vs helpful.
- If relevant, include a brief "when to reach out for help" note in neutral language.$t$),
('tone', 'crisp_action_first', 'Checklist coach (crisp + action-first)',
$t$Keep the intro minimal (1-2 sentences max), then get to steps.
- Optimize for scanning: short headings, bullets, and numbered steps.
- Use concrete, specific actions and examples (what to do, when, how).
- Neutral and supportive (no shame, no fear).
- Avoid fluff, stories, or long explanations.$t$),
('tone', 'harried_parent', 'Harried parent (warm then practical)',
$t$Warm and reassuring (1-2 sentences max), then practical.
- Skimmable: short headings + bullets; no long paragraphs.
- Offer 2-4 realistic options (not exhaustive).
- Avoid shamey language ("should/always/never"); calm, non-alarmist.$t$),
('tone', 'lightly_humorous', 'Lightly humorous friend (calm + practical)',
$t$Warm, steady, and relatable with a *light* touch of humor (small parent-life nods), then get practical.
- Humor should be gentle and inclusive—never sarcastic, mean, or at the child's expense.
- Keep it skimmable: short headings + bullets; no long paragraphs.
- Use simple language and short sentences. One mini-topic per card.
- Include 0-1 humor "beat" per card (often just a phrase), and 1-2 total "you're not alone" moments per segment.
- Offer 2-4 realistic options (not exhaustive).
- Avoid shamey language ("should/always/never"); stay calm, non-alarmist.
- If the topic is high-stakes (choking, car seats, poisoning, fever red flags), keep humor minimal or skip it entirely.$t$),
('tone', 'myth_buster', 'Myth buster (gentle + clarifying)',
$t$Assume the parent encountered confusing advice online or from friends/family.
- Be calm, respectful, and non-judgmental. No dunking, no "obviously."
- Use plain language and explain *why* the myth persists (briefly).
- Avoid absolutes ("always/never/should") and avoid fear-based language.
- Emphasize practical next steps and "what's safe / what's helpful."$t$),
('tone', 'supportive_friend', 'Supportive friend (warm + relatable)',
$t$Write like a trusted friend who's been through it and is well-informed.
- Warm, encouraging, lightly conversational—NOT cheesy, NOT overly chatty.
- Use simple language, short sentences, and gentle reassurance.
- Include 1-2 "you're not alone" moments max (don't overdo it).
- Avoid shame, absolutes ("always/never/should"), and fear-based language.$t$)
ON CONFLICT (block_type, name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 2. Populate each segment row's technical fields + block FKs.
--    Keyed by row id (tone strings carry stray whitespace, so id is safer).
-- ----------------------------------------------------------------------------
WITH shared AS (
  SELECT
    $sys$You are an expert in early childhood education and safety, writing for new parents who are often tired, overwhelmed, and emotionally raw. Generate clear, supportive, engaging educational content. Each piece of content is a "card": a single self-contained idea sized for one mobile screen. Use friendly, accessible language; avoid jargon and excessive technical detail. Every card must stand on its own with a clear mini-topic.$sys$ AS system_message,
    $scope$Use the lesson title only as background context. The content must focus tightly on the lesson. Do NOT broaden into other lesson topics.$scope$ AS scope,
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
    }$schema$::jsonb AS output_schema,
    (SELECT id FROM prompt_blocks WHERE block_type='structure' AND name='sturdy_6_card_arc') AS structure_id,
    (SELECT id FROM prompt_blocks WHERE block_type='length'    AND name='standard_400')      AS length_id
),
mapping (row_id, tone_block) AS (VALUES
  ('367538e6-55b3-4924-94dc-1c7d2f69c189'::uuid, 'calm_clinician'),
  ('cc607d5f-603a-4c5f-a395-73cbc7ceaa13'::uuid, 'crisp_action_first'),
  ('27b19324-b8a8-4c04-8e76-627a072d18c7'::uuid, 'sturdy_leadership'),
  ('64ac0e1d-efed-4b90-b1b5-957f91033388'::uuid, 'harried_parent'),
  ('53eebfc9-2972-4b6b-a84e-edee5c508932'::uuid, 'lightly_humorous'),
  ('a3ae738c-f812-4d8b-9daf-35cf176e5c06'::uuid, 'myth_buster'),
  ('3c710f2d-3741-431e-b5d9-2e2009c23dfb'::uuid, 'crisp_action_first'),
  ('02fdb22c-2059-4493-ab5a-5e13b05d2867'::uuid, 'supportive_friend'),
  ('2790e19b-207a-4cfa-a2be-e9e5df85405b'::uuid, 'crisp_action_first')
)
UPDATE prompts p SET
  system_message     = shared.system_message,
  scope              = shared.scope,
  output_schema      = shared.output_schema,
  model              = 'gpt-4o',
  temperature        = 1.0,
  max_tokens         = 3000,
  structure_block_id = shared.structure_id,
  length_block_id    = shared.length_id,
  tone_block_id      = tb.id,
  is_active          = true
FROM shared, mapping m
JOIN prompt_blocks tb ON tb.block_type = 'tone' AND tb.name = m.tone_block
WHERE p.id = m.row_id;

COMMIT;
