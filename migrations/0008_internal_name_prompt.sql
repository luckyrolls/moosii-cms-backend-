-- ============================================================================
-- Migration 0008: internal_name in the lesson + coverage_audit prompts (DRAFT)
-- ============================================================================
-- DRAFT — NOT applied by the agent. APPLY VIA THE SUPABASE SQL EDITOR after review;
-- prompt-track migration on the 0001..0008 reconciliation list.
--
-- WHAT CHANGES. Both lesson-emitting prompt rows now generate a SECOND name (internal_name)
-- per lesson:
--   - prompt_type='lesson'          (classes[].items)
--   - prompt_type='coverage_audit'  (proposals[].items)   (seeded in 0006)
-- Each row's output_schema gains an `internal_name` string property, and its system_message
-- gains the TWO-NAMES rule (below). Pairs with migration 047 (the RPC that persists it).
--
-- SCHEMA-WRAPPER / PROVIDER FINDING (verified against the live rows before writing this):
--   - BOTH rows: model=gpt-4o → route to OPENAI (providerForModel derives provider from model).
--   - BOTH rows: output_schema is the WRAPPED form {name, schema, strict:true} with
--     items.additionalProperties=false. (The review-path Gemini UNWRAP trap does NOT apply
--     here — these are OpenAI, and OpenAI wants the wrapped strict form.)
--   - OPENAI STRICT MODE requires EVERY property to appear in `required`. So internal_name is
--     added to BOTH items.properties AND items.required. Omitting it from `required` would make
--     OpenAI reject the schema (400). additionalProperties stays false.
-- Implemented with jsonb_set so nothing else in the schema is disturbed. Idempotent: guarded on
-- internal_name already being present in items.properties, so a re-run is a no-op.
--
-- NOTE on system_message: the TWO-NAMES block is APPENDED to each system_message (the exact
-- current prose is not reproduced here). Placement is not load-bearing for the model; Mark may
-- reposition it on review.
-- ============================================================================

BEGIN;

-- ---- coverage_audit (proposals[].items) --------------------------------------------------
UPDATE prompts
SET output_schema = jsonb_set(
      jsonb_set(
        output_schema,
        '{schema,properties,proposals,items,properties,internal_name}',
        '{"type":"string"}'::jsonb,
        true
      ),
      '{schema,properties,proposals,items,required}',
      (output_schema #> '{schema,properties,proposals,items,required}') || '["internal_name"]'::jsonb
    ),
    system_message = system_message || E'\n\n' || $names$INTERNAL NAME (a SECOND, DIFFERENT name — a separate task, NOT a second attempt at the same title).
Every lesson carries TWO names with DIFFERENT jobs:
- lesson_name  — PARENT-FACING. Short, warm, what the app shows a tired parent.
- internal_name — the CURATOR'S CATALOG HANDLE. Descriptive and searchable: it names what the
  lesson COVERS so a curator scanning ~140 lessons finds it by subject. NOT shown to parents.
These are STRUCTURALLY different writing tasks. Do NOT return two near-identical strings: an
internal_name that merely restates the warm lesson_name is a FAILURE — the CMS surfaces
internal_name only when it DIFFERS from lesson_name, so a twin makes the field invisible while
appearing to have shipped.
When AUTHOR INSTRUCTIONS supply a SOURCE TITLE for a lesson, that source title goes VERBATIM into
internal_name (unchanged), and lesson_name is the parent-facing REWRITE of it — never the reverse.
When no source title is supplied, write internal_name as an AI-descriptive catalog handle.$names$
WHERE prompt_type = 'coverage_audit'
  AND NOT ((output_schema #> '{schema,properties,proposals,items,properties}') ? 'internal_name');

-- ---- lesson (classes[].items) ------------------------------------------------------------
UPDATE prompts
SET output_schema = jsonb_set(
      jsonb_set(
        output_schema,
        '{schema,properties,classes,items,properties,internal_name}',
        '{"type":"string"}'::jsonb,
        true
      ),
      '{schema,properties,classes,items,required}',
      (output_schema #> '{schema,properties,classes,items,required}') || '["internal_name"]'::jsonb
    ),
    system_message = system_message || E'\n\n' || $names$INTERNAL NAME (a SECOND, DIFFERENT name — a separate task, NOT a second attempt at the same title).
Every lesson carries TWO names with DIFFERENT jobs:
- lesson_name  — PARENT-FACING. Short, warm, what the app shows a tired parent.
- internal_name — the CURATOR'S CATALOG HANDLE. Descriptive and searchable: it names what the
  lesson COVERS so a curator scanning ~140 lessons finds it by subject. NOT shown to parents.
These are STRUCTURALLY different writing tasks. Do NOT return two near-identical strings: an
internal_name that merely restates the warm lesson_name is a FAILURE — the CMS surfaces
internal_name only when it DIFFERS from lesson_name, so a twin makes the field invisible while
appearing to have shipped.
When AUTHOR INSTRUCTIONS supply a SOURCE TITLE for a lesson, that source title goes VERBATIM into
internal_name (unchanged), and lesson_name is the parent-facing REWRITE of it — never the reverse.
When no source title is supplied, write internal_name as an AI-descriptive catalog handle.$names$
WHERE prompt_type = 'lesson'
  AND NOT ((output_schema #> '{schema,properties,classes,items,properties}') ? 'internal_name');

COMMIT;
