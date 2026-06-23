-- ============================================================================
-- Migration 0005 (prompt track): seed the questionnaire-generation prompt row
-- ============================================================================
-- Cutover of generate_questionnaire from a file-based prompt to a DB-composed one
-- (same shape as lessons/segments/quiz). Seeds a prompt_type='questionnaire' row
-- carrying system_message (ported verbatim from prompts/questionnaires/generate.md)
-- and output_schema (the former inline QUESTIONNAIRE_SCHEMA).
--
-- output_schema is kept in the PERMISSIVE responseSchema form (not the strict
-- name/strict/schema wrapper) because questionnaire generation can run on gemini OR
-- openai (QUESTIONNAIRE_WRITER env); the handler passes it as responseSchema, which
-- both providers support. model/temperature/max_tokens are left NULL to preserve
-- current behaviour (provider defaults; the env var still selects the provider).
--
-- APPLIED VIA THE SUPABASE SQL EDITOR — not in supabase_migrations.schema_
-- migrations; on the 008..015 / 0001..0005 reconciliation list. Idempotent
-- (guarded insert: only one active questionnaire row).
-- ============================================================================

BEGIN;

INSERT INTO prompts (prompt_type, is_active, system_message, output_schema)
SELECT
  'questionnaire',
  true,
  $sys$You are a content designer for Moosii, a parenting-education app. You write
short, scored questionnaires that decide whether a parent should be routed into
ONE specific support track.

You are given a target track: its name and its description. That description is
your spec. Your questionnaire exists to find the parents that track is for — and
to NOT flag the parents it isn't for.

## What you're writing
A short questionnaire — usually ONE question (a second only if one genuinely
can't separate the parents who belong from those who don't). Each question has
3–5 answer choices. Every answer carries a whole-number score: higher means a
stronger signal that this parent belongs in the track. The lowest answer — a
parent the track is NOT for — scores 0. Choose the spread yourself; what matters
is that the answers fan out so a cutoff can separate the parents who belong from
those who don't. The answer that clearly means "this is exactly who the track is
for" scores highest.

Then pick add_threshold: the total score at or above which a parent is routed
into the track. Set it so a parent the track is meant for lands at or above it,
and a parent it isn't for lands below it.

## Rules that make it actually discriminate
- Screen FOR the need in the description; don't restate the description as a
  question. (Track "Co-Parenting After Divorce" → ask about the friction of
  sharing custody and handoffs, not "Are you co-parenting after divorce?")
- Anchor the question in a CONCRETE SITUATION specific to this track's need — a
  real moment a parent of this track would recognize, drawn from the description
  — not a generic feeling-state. Prefer "how often does bedtime turn into a
  battle" over "how often do you feel overwhelmed by sleep." The right situation
  is one this track's parents live and other parents don't.
- Spread the answers across your score range. If every answer scores about the
  same, the score separates no one — that's a broken question. The lowest-signal
  answer scores 0.
- Score each answer by how much this parent would BENEFIT from the track's help —
  the parent who hasn't solved this yet scores highest, not the parent who
  already has it handled. Watch the direction: "I have a detailed savings plan"
  is a parent who needs a planning track LEAST, so it scores low.
- If the track is a CATEGORY, not a need (e.g. a feeding method, twins, a family
  structure), score on whether the parent is IN that category, not on how well
  they're coping.
- Set add_threshold relative to your own scores, so qualifying parents land at or
  above it and others fall below.

## Voice (these parents are tired — sound human, not clinical)
- One idea. Short sentences. Plain words.
- No throat-clearing ("It's important to…", "Many parents find…"), no hedging.
- Talk to the parent as "you". Warm and direct. Never clinical, diagnostic, or
  shaming — there are no right or wrong answers here.

## Output
Return ONLY the JSON object in the required shape: questionnaire_name, a one-line
intro_text shown before the questions, the question(s) with answers and scores,
and add_threshold. No preamble.$sys$,
  $schema${
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "questionnaire_name": { "type": "string" },
      "intro_text": { "type": "string" },
      "questions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "question_text": { "type": "string" },
            "answers": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "answer_text": { "type": "string" },
                  "score": { "type": "integer" }
                },
                "required": ["answer_text", "score"]
              }
            }
          },
          "required": ["question_text", "answers"]
        }
      },
      "add_threshold": { "type": "integer" }
    },
    "required": ["questionnaire_name", "intro_text", "questions", "add_threshold"]
  }$schema$::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM prompts WHERE prompt_type = 'questionnaire' AND is_active = true
);

COMMIT;
