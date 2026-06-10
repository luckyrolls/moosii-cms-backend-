-- ============================================================================
-- Migration 0002: Quiz prompt seed (segment quiz generation)
-- ============================================================================
--
-- WHAT THIS DOES
--   1. Adds prompts.question_count (how many questions to generate; default 1).
--   2. Seeds the 'quiz' prompt row, with an ARRAY-shaped output_schema so the
--      count is variable from day one (we launch at 1, but the shape never has
--      to change to scale up).
--
-- WHY THE SCHEMA LOOKS THE WAY IT DOES (important — read before editing)
--   OpenAI strict structured outputs do NOT support minItems/maxItems (and
--   several other keywords). So the schema CANNOT enforce "exactly 4 answers"
--   or "exactly 1 correct". Putting minItems/maxItems in a strict schema makes
--   the API call FAIL. Therefore:
--     - strict:true still buys valid JSON, required fields, correct types,
--       additionalProperties:false  -> keep it.
--     - "exactly 4 answers / exactly 1 correct" is enforced in TWO other places:
--       (a) the prompt TEXT (system_message below), and
--       (b) the HANDLER, which validates each question after parsing and treats
--           a malformed question as invalid (drop + log shortfall — see CC task).
--   Do NOT "fix" this by adding minItems/maxItems. It will break the call.
-- ============================================================================

BEGIN;

ALTER TABLE prompts
  ADD COLUMN IF NOT EXISTS question_count integer NOT NULL DEFAULT 1;

INSERT INTO prompts (
  prompt_type, tone, "default", is_active,
  system_message, scope,
  model, temperature, max_tokens, question_count,
  tone_block_id,
  output_schema
)
SELECT
  'quiz',
  'Sturdy Leadership',          -- match the segment tone so feedback voice is consistent
  false,
  true,
  $sys$You are an expert in early childhood education writing quiz questions for new parents, based STRICTLY on the supplied segment content. Write clear multiple-choice questions that check understanding of the key ideas — never trick questions. Base questions ONLY on facts present in the supplied content; do not introduce information that is not in it (this matters most for safety topics). Each question has EXACTLY 4 answer choices, with EXACTLY ONE correct. For every choice — correct and incorrect — write a short, supportive response explaining why it is right or wrong, in the same warm, non-judgmental voice as the content. Never shame a wrong answer.$sys$,
  $scope$Create quiz question(s) for the supplied segment content. Generate exactly the number of questions requested. Each question must have exactly 4 answers, exactly one marked correct, and a response for every answer.$scope$,
  'gpt-5.1',                    -- match the model you verified for segment gen
  1.0,
  3000,
  1,                            -- launch count; co-founder can raise this in the CMS
  (SELECT id FROM prompt_blocks WHERE block_type='tone' AND name='sturdy_leadership'),
  $schema${
    "name": "SegmentQuiz",
    "strict": true,
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "questions": {
          "type": "array",
          "description": "Quiz questions generated from the segment content.",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "question_text": {
                "type": "string",
                "description": "The multiple-choice question."
              },
              "answers": {
                "type": "array",
                "description": "Answer choices. Must be exactly 4, exactly one correct (enforced in the prompt + handler, not the schema).",
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "answer_text": { "type": "string", "description": "The answer choice text." },
                    "is_correct":  { "type": "boolean", "description": "True if this choice is correct." },
                    "response":    { "type": "string", "description": "Supportive feedback explaining why this choice is correct or incorrect." }
                  },
                  "required": ["answer_text", "is_correct", "response"]
                }
              }
            },
            "required": ["question_text", "answers"]
          }
        }
      },
      "required": ["questions"]
    }
  }$schema$::jsonb;

COMMIT;
