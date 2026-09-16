-- ============================================================================
-- MIGRATION 084: financial content seed — DATA ONLY — DRAFT (pending apply)   *** FINANCIAL ONLY ***
-- ============================================================================
-- WHAT: everything `generate_lessons` and `generate_segment_content` need on the FINANCIAL project,
-- which today holds no prompt, block, size profile, topic, track or default-track rows at all
-- (checked read-only 2026-09-16). Data only; no schema. Refuses any database whose
-- app_settings.domain is not 'financial' (section 0), and the apply script lists 084 as
-- financial-only, as it does 075.
--
-- SOURCE: docs/drafts/financial-seed/financial-content-seed.md (the content seed brief), plus Mark's
-- decisions below. Brief sections: §1 register/voice, §2 tone block, §3 lesson prompt, §4 topics,
-- §5 tracks + caps, §6 fact→track rules. Every value the brief supplies sits in ONE block
-- (section 1); section 1b refuses an empty or invalid value there.
--
-- DECISIONS (Mark, made):
--   D-C1  generate_lessons is called with min_child_age = 0, max_child_age = 1200 for financial
--         tracks; generated lessons carry NULL ages. The lesson output_schema keeps all fields but
--         types both ages ["integer","null"] and the prompt says to return null. No code change:
--         the handler inserts whatever the model returns, lessons.min/max_child_age are nullable,
--         segment generation omits its age line when both are null, and the MLP age filter treats
--         NULL bounds as open-ended.
--   D-C2  safety_sensitive trigger list — Mark's list (a superset of brief §3: it adds debt
--         collection and consumer rights, and any specific dollar threshold or timeline target).
--   D-C3  Mark holds both review flags on financial — NOT here: financial has no auth users yet.
--         See 085 (run after Mark signs up on the financial project).
--   D-C4  tone display name "Plain Money".
--
-- RECONCILED WITH THE BRIEF (§1–§3):
--   * Voice block = brief §2 verbatim, plus one closing paragraph naming the four anti-patterns
--     that §1 says to "name explicitly in the tone block" (§2's text does not list them).
--   * Segment system_message (technical layer) = the §1 reader + §3's general-education paragraph.
--     Voice specifics stay in the tone block, as on Moosii.
--   * Lesson prompt: §3's paragraph verbatim; band_rationale = §3's relevance rationale ("which
--     reader this lesson is for — the fact or intent that makes it land"); no developmental window;
--     §1's reader in AUDIENCE.
--   * The final card is "one concrete action the reader can take today" everywhere it is described
--     (§1 last voice rule, §2 last paragraph): the card-positions TAKEAWAY rule and step 6 of the
--     financial standard_arc both say so. Moosii's versions ("memorable summary … or one concrete
--     next step" / "the one thing to remember") are untouched.
--
-- REUSE CHECK (Moosii blocks, read 2026-09-16) — financial has none, so they are COPIED:
--   standard_400 (length)          neutral → copied (LF line endings; Moosii's row is CRLF).
--   size profile `standard`        numbers only → copied. 350–450 words ≈ the brief's "two minutes".
--   standard_arc (structure)       no parenting vocabulary → copied, except step 6 (see above).
--   card_positions_v1              ⚠ PARENTING VOCABULARY ("Parents read cards…", "the parent's
--                                  situation", "the infant will exhibit…", "a tired parent") →
--                                  financial wording, same structure and rules.
--   sturdy_6_card_arc (structure)  Good Inside parenting arc → NOT copied.
--   segment system_message         ⚠ "expert in early childhood education … writing for new
--                                  parents" → financial wording. scope + output_schema copied.
--
-- NOT IN THIS FILE:
--   * Q-Onboard (brief §8) — cannot be a seed as specified: questionnaire_answer_actions allows
--     only add_track | add_tag | record_milestone (qaa_payload_matches_type), so an answer cannot
--     write a fact. Needs a schema + code change (a record_fact action). Authoring itself is a CMS /
--     generate_questionnaire action, which also needs a `questionnaire` prompt row.
--   * fact_entry_map (brief §7) — follow-up once lessons exist (targets are lesson/segment ids).
--   * screen_help (brief §9) — lowest priority per the brief; not requested.
--
-- FOR WHOEVER RUNS GENERATION: call generate_lessons per track with
--   { track_id, min_child_age: 0, max_child_age: 1200, max_lessons: <cap> }. Caps (brief §5):
--     Getting Oriented 3 · Credit Health 4 · Subscription Audit 3 · Building a Buffer 4 ·
--     Paycheck Setup 2 · Debt Payoff Plan 4.
--   They are the `max_lessons` column of seed_084_tracks below — NOT stored in the database.
--
-- Idempotent: fixed ids / ON CONFLICT DO NOTHING / WHERE NOT EXISTS throughout.
-- APPLY per migrations/README.md: FINANCIAL ONLY, after 075 and 086.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-CHECK — run FIRST (read-only).
-- 1. This is financial — EXPECT 'financial':
--    SELECT value FROM app_settings WHERE key = 'domain';
-- 2. Nothing to collide with — EXPECT every count 0 on a first apply:
--    SELECT (SELECT count(*) FROM prompts)               AS prompts,
--           (SELECT count(*) FROM prompt_blocks)         AS blocks,
--           (SELECT count(*) FROM content_size_profiles) AS size_profiles,
--           (SELECT count(*) FROM topics)                AS topics,
--           (SELECT count(*) FROM tracks)                AS tracks,
--           (SELECT count(*) FROM new_user_tracks)       AS default_tracks,
--           (SELECT count(*) FROM fact_track_rules)      AS fact_rules;
-- 3. 075's vocabulary is present — EXPECT 6 keys, 13 values:
--    SELECT (SELECT count(*) FROM fact_keys) AS keys, (SELECT count(*) FROM fact_values) AS vals;
-- 4. 086 is applied (lesson creation fails on financial without it) — EXPECT ba31ffd7a734c96ed8065d59eb4b6249:
--    SELECT md5(pg_get_functiondef('public.content_edit_policy_guard()'::regprocedure));
-- ---------------------------------------------------------------------------

BEGIN;

-- ---- 0. Financial only -----------------------------------------------------
DO $$
BEGIN
  IF (SELECT value FROM app_settings WHERE key = 'domain') IS DISTINCT FROM 'financial' THEN
    RAISE EXCEPTION '084 is FINANCIAL ONLY: app_settings.domain is %',
      coalesce((SELECT value FROM app_settings WHERE key = 'domain'), '<unset>');
  END IF;
END $$;

-- ---- 1. BRIEF DATA -------------------------------------------------------------
CREATE TEMP TABLE seed_084_text (key text PRIMARY KEY, value text NOT NULL) ON COMMIT DROP;
INSERT INTO seed_084_text (key, value) VALUES
  -- Brief §2 verbatim (three paragraphs + the closing one), then the §1 anti-patterns.
  ('plain_money_voice', $brief$Write as a calm, competent friend who happens to know money well. Address the reader
directly as "you". Use short sentences and ordinary words. Explain any financial term
the first time it appears, in a half-sentence, without breaking stride.

Assume the reader is an adult managing real money, not a beginner to be protected and
not an expert to be impressed. Never imply they have made a mistake, and never praise
them for reading. State what is true, why it matters to them, and what they can do.

Do not name financial products, institutions, interest rates, or investment returns.
Do not state dollar amounts or balances — you do not know them. Refer to the reader's
own numbers generically ("your balance", "the card with the highest rate").

Each card makes one point and can be read in twenty seconds. The final card is a
single concrete action, phrased as something to do, not something to consider.

Never write:
- cheerleading ("You've got this!");
- scolding, or anything implying the reader failed;
- hypotheticals about people who aren't the reader ("imagine a couple who…");
- numbers you cannot know ("your $4,200 balance").$brief$);

-- Brief §5. slot 1 is the default track (section 7). max_lessons = the brief's generation cap
-- (documentation only — passed as generate_lessons input, never stored).
CREATE TEMP TABLE seed_084_tracks (
  slot        int  PRIMARY KEY,
  id          uuid NOT NULL,
  track_name  text NOT NULL,
  description text NOT NULL,
  track_type  text NOT NULL,
  weight      text NOT NULL,
  max_lessons text NOT NULL
) ON COMMIT DROP;
INSERT INTO seed_084_tracks (slot, id, track_name, description, track_type, weight, max_lessons) VALUES
  (1, 'f0840000-0000-4000-8000-000000000001', 'Getting Oriented',
      'For someone who has just linked their accounts. What the app can now see, how to read a spending summary, and how to pick one thing to work on first. Assumes no prior financial education.',
      'core', '100', '3'),
  (2, 'f0840000-0000-4000-8000-000000000002', 'Credit Health',
      'How credit utilization works, why the 30% guideline exists, what moves a score and what doesn''t, and the difference between a limit and a balance. Practical, not aspirational.',
      'credit', '90', '4'),
  (3, 'f0840000-0000-4000-8000-000000000003', 'Subscription Audit',
      'Finding recurring charges the reader has forgotten, deciding what to keep, cancelling without friction, and the annual-vs-monthly trap. Short and immediately actionable.',
      'spending', '80', '3'),
  (4, 'f0840000-0000-4000-8000-000000000004', 'Building a Buffer',
      'Why one month of expenses comes before anything else, how to automate a transfer, where to keep it so it stays available, and what counts as an emergency.',
      'saving', '90', '4'),
  (5, 'f0840000-0000-4000-8000-000000000005', 'Paycheck Setup',
      'What direct deposit changes about timing and fees, and how splitting a deposit across accounts makes saving automatic. Two lessons only.',
      'income', '70', '2'),
  (6, 'f0840000-0000-4000-8000-000000000006', 'Debt Payoff Plan',
      'Choosing between highest-rate-first and smallest-balance-first, why minimums alone stall, what consolidation does and doesn''t change, and making the first extra payment.',
      'debt', '95', '4');

-- Brief §6. track_slot = 1..6 from the table above.
CREATE TEMP TABLE seed_084_rules (n int PRIMARY KEY, fact_key text NOT NULL, value text NOT NULL, track_slot text NOT NULL) ON COMMIT DROP;
INSERT INTO seed_084_rules (n, fact_key, value, track_slot) VALUES
  (1, 'credit_utilization_band', 'high',     '2'),   -- Credit Health
  (2, 'credit_utilization_band', 'moderate', '2'),   -- Credit Health
  (3, 'new_subscription_recent', 'true',     '3'),   -- Subscription Audit
  (4, 'has_emergency_buffer',    'false',    '4'),   -- Building a Buffer
  (5, 'has_direct_deposit',      'false',    '5'),   -- Paycheck Setup
  (6, 'wants_debt_payoff_plan',  'true',     '6'),   -- Debt Payoff Plan
  (7, 'saving_for_home',         'true',     '4');   -- Building a Buffer

-- ---- 1b. Refuse an empty or invalid brief block ---------------------------------
DO $$
DECLARE
  v_unfilled int;
  v_bad      text;
BEGIN
  SELECT count(*) INTO v_unfilled FROM (
    SELECT value AS v FROM seed_084_text
    UNION ALL SELECT track_name  FROM seed_084_tracks
    UNION ALL SELECT description FROM seed_084_tracks
    UNION ALL SELECT track_type  FROM seed_084_tracks
    UNION ALL SELECT weight      FROM seed_084_tracks
    UNION ALL SELECT max_lessons FROM seed_084_tracks
    UNION ALL SELECT fact_key    FROM seed_084_rules
    UNION ALL SELECT value       FROM seed_084_rules
    UNION ALL SELECT track_slot  FROM seed_084_rules
  ) s WHERE s.v LIKE '%<<BRIEF%' OR btrim(s.v) = '';
  IF v_unfilled > 0 THEN
    RAISE EXCEPTION '084: % brief value(s) in section 1 are empty or unfilled', v_unfilled;
  END IF;

  SELECT string_agg(slot::text, ', ') INTO v_bad FROM seed_084_tracks
   WHERE CASE WHEN weight ~ '^[0-9]{1,5}$' THEN weight::int NOT BETWEEN 1 AND 32767 ELSE true END
      OR CASE WHEN max_lessons ~ '^[0-9]{1,4}$' THEN max_lessons::int < 1 ELSE true END;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '084: track slot(s) % need an integer weight (1..32767) and max_lessons (>= 1)', v_bad;
  END IF;

  IF (SELECT count(DISTINCT lower(btrim(track_name))) FROM seed_084_tracks) <> 6 THEN
    RAISE EXCEPTION '084: the six track names must be distinct';
  END IF;

  SELECT string_agg(n::text, ', ') INTO v_bad FROM seed_084_rules WHERE track_slot !~ '^[1-6]$';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '084: rule(s) % need track_slot 1..6', v_bad;
  END IF;

  SELECT string_agg(format('%s (%s=%s)', r.n, r.fact_key, r.value), ', ') INTO v_bad
    FROM seed_084_rules r
   WHERE NOT EXISTS (SELECT 1 FROM fact_values v WHERE v.fact_key = r.fact_key AND v.value = r.value);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '084: rule(s) % name a fact/value that is not in the 075 vocabulary', v_bad;
  END IF;

  IF (SELECT count(DISTINCT (fact_key, value, track_slot)) FROM seed_084_rules) <> 7 THEN
    RAISE EXCEPTION '084: the seven fact→track mappings must be distinct';
  END IF;
END $$;

-- ---- 2. Segment generation: size, length, structure, card positions, the Plain Money tone ----
INSERT INTO public.content_size_profiles
  (id, name, label, total_words_min, total_words_max, words_per_card_min, words_per_card_max,
   max_sentence_words, max_bullet_words, max_bullets_per_card)
VALUES
  ('f0840000-0000-4000-8000-000000000101', 'standard', 'Standard', 350, 450, 45, 70, 19, 13, 4)
ON CONFLICT DO NOTHING;

INSERT INTO public.prompt_blocks (id, block_type, name, label, content) VALUES
  ('f0840000-0000-4000-8000-000000000201', 'length', 'standard_400', 'Standard (~400 words, tight cards)',
$txt$Target ~400 words total across all cards (acceptable range 350-450).
Keep cards tight (~45-70 words each). Each card stands alone with a clear mini-topic.
- Sentences under 19 words.
- Bullets under 13 words.
- Maximum of 4 bullets or 4 numbered items per card.
If a card topic is too big, split into two cards, ending the first with a line:
"_Continues on next card -->_". Only split when necessary.$txt$),

  -- Moosii's standard_arc, except step 6: the brief ends every lesson on one action.
  ('f0840000-0000-4000-8000-000000000202', 'structure', 'standard_arc', NULL,
$txt$Organize the content as a sequence of cards (6-9), each one
self-contained idea:
1) Open: orient the reader to this specific topic — what it is and why
   it matters now.
2) Core idea: the central point, in plain language.
3) How it works / what to know: the key facts or reasoning behind it.
4) What to do: concrete, practical steps (bullets or numbered) specific
   to the segment.
5) Watch-outs: common mistakes, edge cases, or when to seek help.
6) Takeaway: one concrete action the reader can take today.
Add cards only if the topic genuinely needs them; keep each card to
one idea. Cover the territory in this order, but write each card so it
stands alone — no card may depend on another to be understood.$txt$),

  -- Moosii's card_positions_v1 rules with the audience words changed, and the takeaway rule
  -- aligned to brief §1/§2 (one concrete action, not a summary).
  ('f0840000-0000-4000-8000-000000000203', 'card_positions', 'card_positions_v1', 'Card positions (financial)',
$txt$CARD POSITIONS — how each card's job differs by its place in the lesson:

Every card must be independently understandable. Readers read cards one
at a time, sometimes out of order. Never write a card that needs an
earlier or later card to make sense. Never refer to "the previous card,"
"as we said," or "coming up next."

FIRST CARD
- May spend ONE sentence acknowledging the reader's situation before
  informing. This is the lesson's only budgeted warmth sentence. It never
  praises the reader and never implies they made a mistake.
- Then orient: what this lesson covers and why it matters to them now.

BODY CARDS
- One idea per card, stated economically. No warm-up sentences, no
  wind-down sentences.
- Warmth lives in word choice, not extra words: address the reader
  directly ("you have three cards") rather than abstractly ("consumers
  often hold three cards"). This costs zero words — it is a
  substitution, never an addition.
- Reassuring softeners ("this might feel slow at first") are correct
  voice when the content warrants reassurance. They are not hedging.

TAKEAWAY CARD (always the final card)
- Must be ONE concrete action the reader can take today, phrased as
  something to do, not something to consider.
- Never merely restate earlier cards. If the takeaway says nothing a
  reader couldn't get from re-reading card 2, it has failed.
- Do not spend words on warmth or encouragement here.$txt$)
ON CONFLICT DO NOTHING;

-- The tone's 1:1 voice block (§2g: name = slug of the display name).
INSERT INTO public.prompt_blocks (id, block_type, name, label, content)
SELECT 'f0840000-0000-4000-8000-000000000204', 'tone', 'plain_money', 'Plain Money', t.value
  FROM seed_084_text t WHERE t.key = 'plain_money_voice'
ON CONFLICT DO NOTHING;

-- The tone row (§2g): one segment prompts row, display name "Plain Money" (D-C4). Technical layers:
-- scope + output_schema copied from Moosii's segment rows (all 10 share one technical layer);
-- system_message is the financial version (brief §1 reader + §3 paragraph). model / temperature /
-- max_tokens as Moosii's "Checklist coach" tone; editable later via PATCH /tones/:id.
INSERT INTO public.prompts
  (id, prompt_type, tone, is_active, "default", question_count, model, temperature, max_tokens,
   system_message, scope, output_schema,
   tone_block_id, structure_block_id, length_block_id, size_profile_id, card_positions_block_id)
SELECT
  'f0840000-0000-4000-8000-000000000301', 'segment', 'Plain Money', true, false, 1, 'gpt-4o', 1.0, 3000,
  $txt$You are writing consumer financial education for a personal-finance app. The reader is an adult consumer who linked their bank accounts to a budgeting app and has not come back in a while. They are not a student, not an employee in a benefits program, and not in crisis; they are mildly embarrassed about money and allergic to being lectured. Generate clear, practical educational content. Each piece of content is a "card": a single self-contained idea sized for one mobile screen. Every card must stand on its own with a clear mini-topic. Content is general education, never individualised advice. Never recommend a specific product, institution, or course of action that depends on facts you do not have. Where a decision depends on the reader's circumstances, say what the trade-off is and who to ask, rather than choosing for them.$txt$,
  'Use the lesson title only as background context. The content must focus tightly on the lesson. Do NOT broaden into other lesson topics.',
  $json${"name": "SegmentCards", "strict": true, "schema": {"type": "object", "required": ["cards"], "properties": {"cards": {"type": "array", "items": {"type": "object", "required": ["title", "content"], "properties": {"title": {"type": "string", "description": "Short card title."}, "content": {"type": "string", "description": "Card body in markdown."}}, "additionalProperties": false}, "description": "Ordered cards (sub_segments). The final card is the takeaway."}}, "additionalProperties": false}}$json$::jsonb,
  (SELECT id FROM prompt_blocks WHERE block_type = 'tone'           AND name = 'plain_money'),
  (SELECT id FROM prompt_blocks WHERE block_type = 'structure'      AND name = 'standard_arc'),
  (SELECT id FROM prompt_blocks WHERE block_type = 'length'         AND name = 'standard_400'),
  (SELECT id FROM content_size_profiles WHERE name = 'standard'),
  (SELECT id FROM prompt_blocks WHERE block_type = 'card_positions' AND name = 'card_positions_v1')
ON CONFLICT (id) DO NOTHING;

-- ---- 3. Lesson prompt (generate_lessons) ----------------------------------------
-- Moosii's active `lesson` row with the domain swapped per brief §3. Output contract: the same
-- fields, all required (lesson_name, internal_name, description, topic, min/max_child_age,
-- priority, band_rationale, safety_sensitive, coverage_rationale); the only change is that both
-- ages accept null (D-C1). model/temperature/max_tokens as Moosii's row.
INSERT INTO public.prompts
  (id, prompt_type, tone, is_active, "default", question_count, model, temperature, max_tokens,
   system_message, scope, output_schema)
VALUES (
  'f0840000-0000-4000-8000-000000000302', 'lesson', NULL, true, false, 1, 'gpt-4o', 0.7, 3000,
$sys$You are writing consumer financial education for a personal-finance app. Content is
general education, never individualised advice. Never recommend a specific product,
institution, or course of action that depends on facts you do not have. Where a
decision depends on the reader's circumstances, say what the trade-off is and who to
ask, rather than choosing for them.

You are the curriculum designer. Generate a coherent SET of lesson stubs for ONE
learning track — titles, objectives, and metadata, NOT lesson body content (segment
content is generated downstream).

COVERAGE FIRST — the number of lessons EMERGES from coverage; it is NOT a target.
Work in this order:
1. From the track's name and description, ENUMERATE the DISTINCT topics a reader
   genuinely needs covered to master this track. For each topic write a one-sentence
   existence rationale (coverage_rationale): why this topic belongs AND why it is
   separate from every other. Fewer well-separated topics ALWAYS beat more
   overlapping ones. A redundant, filler, or padded topic is a FAILURE — if you
   cannot justify a topic in one honest sentence that does not restate another
   topic's, it does not belong. A narrow track needs few lessons; that is the
   correct outcome, not a shortfall.
2. Produce EXACTLY ONE lesson per enumerated topic. The lesson count is however
   many distinct topics genuine coverage requires — no more.

GAP-FILL — cover only what is MISSING.
The request lists the lessons ALREADY in this track. Treat them as already
covered: do NOT duplicate them, and do NOT produce a lesson that closely overlaps
one in scope even under a different title. Enumerate only the missing topics and
extend the existing progression. An empty track → enumerate full coverage. A
half-filled track → enumerate ONLY the gaps. If nothing is genuinely missing,
return an empty "classes" array.

COUNT & ORDERING.
There is NO target number of lessons and no maximum is given to you — the count is
however many distinct topics genuine coverage requires, and no more. Never pad. A
downstream SYSTEM may cap the count for a given run and drops lessons from the END
of your list, so order the lessons MOST-ESSENTIAL FIRST (by priority, most critical
first) — that way a cap can only ever remove the least-essential lessons, never the
critical ones. Produce your honest full coverage and let the system handle any cap.

PRIORITY (banded rubric).
Assign each lesson a priority on a 100–2000 scale, in six bands:
  Critical 100–199 · Foundational 200–399 · Important/practical 400–699 ·
  Helpful/situational 700–999 · Enrichment 1000–1499 · Niche 1500–2000
Within a band, assign values in +10 increments from the band's lower bound. You
will be given the priority values already used in this track — treat them as
reference anchors: stay consistent with the track's banding and never collide
with a value already in use. Priority is unique per lesson and determines lesson
order, so there is no separate ordering field.

RELEVANCE RATIONALE (the band_rationale field).
Give each lesson a one-sentence band_rationale saying which reader this lesson is
for — the fact or intent that makes it land (for example: a reader whose cards are
running close to their limits, or a reader who has said they want a payoff plan).
The field name is historical; it is a relevance rationale, not an age or
developmental rationale.

NO DEVELOPMENTAL WINDOW.
This app is not about children, and lessons have no age span. The request may
contain a line "Developmental window: … months"; it is a fixed system placeholder —
ignore it. Always return min_child_age = null and max_child_age = null.

TOPIC.
Assign each lesson exactly one topic from the topic set provided in the request,
spelled exactly as given.

SAFETY_SENSITIVE (the compliance-review trigger).
Set safety_sensitive = true for any lesson whose content touches ANY of:
  - debt consolidation;
  - credit repair or credit-building services;
  - bankruptcy;
  - tax treatment;
  - retirement withdrawal rules;
  - debt collection and consumer rights;
  - any specific dollar threshold or timeline target;
  - anything that could read as individualised advice;
  - anything naming a product category the reader could buy.
When in doubt, set it true — over-flagging costs a closer human review;
under-flagging risks shipping content that needed compliance review. Set it false
only for lessons that are clearly general and conceptual with none of the triggers
above (e.g. how to read a spending summary, finding recurring charges).

AUDIENCE & QUALITY.
The reader is an adult consumer who linked their bank accounts to a budgeting app
and has not come back in three weeks. They are not a student, not an employee in a
benefits program, and not in crisis. They are mildly embarrassed about money and
allergic to being lectured. Titles and descriptions must be plain, concrete, and
specific: never moralising, never cheerleading, never alarmist, never padded, free
of generic AI phrasing or hedging. Speak to the reader as "you". No product names,
institutions, rates or returns. A title names a real, recognizable money moment; a
description states plainly what the reader will understand or be able to do after
the lesson.

AUTHOR INSTRUCTIONS.
The request may include an AUTHOR INSTRUCTIONS block. If present, treat it as
authoritative — it comes from the track author and overrides the guidance above
on any conflict. If absent, follow the guidance above as written.

OUTPUT.
Return ONLY a JSON object matching the provided schema — a "classes" array of
lesson stubs, each with its coverage_rationale. No preamble, no markdown fences,
no commentary.

INTERNAL NAME (a SECOND, DIFFERENT name — a separate task, NOT a second attempt at the same title).
Every lesson carries TWO names with DIFFERENT jobs:
- lesson_name  — READER-FACING. Short, plain, what the app shows the reader.
- internal_name — the CURATOR'S CATALOG HANDLE. Descriptive and searchable: it names what the
  lesson COVERS so a curator scanning the catalog finds it by subject. NOT shown to readers.
These are STRUCTURALLY different writing tasks. Do NOT return two near-identical strings: an
internal_name that merely restates the lesson_name is a FAILURE — the CMS surfaces
internal_name only when it DIFFERS from lesson_name, so a twin makes the field invisible while
appearing to have shipped.
When AUTHOR INSTRUCTIONS supply a SOURCE TITLE for a lesson, that source title goes VERBATIM into
internal_name (unchanged), and lesson_name is the reader-facing REWRITE of it — never the reverse.
When no source title is supplied, write internal_name as an AI-descriptive catalog handle.$sys$,
  NULL,
  $json${"name": "lesson_stubs", "strict": true, "schema": {"type": "object", "required": ["classes"], "properties": {"classes": {"type": "array", "items": {"type": "object", "required": ["lesson_name", "description", "topic", "min_child_age", "max_child_age", "priority", "band_rationale", "safety_sensitive", "coverage_rationale", "internal_name"], "properties": {"topic": {"type": "string"}, "priority": {"type": "integer"}, "description": {"type": "string"}, "lesson_name": {"type": "string"}, "internal_name": {"type": "string"}, "max_child_age": {"type": ["integer", "null"]}, "min_child_age": {"type": ["integer", "null"]}, "band_rationale": {"type": "string"}, "safety_sensitive": {"type": "boolean"}, "coverage_rationale": {"type": "string"}}, "additionalProperties": false}}}, "additionalProperties": false}}$json$::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- ---- 4. Topics (brief §4) --------------------------------------------------------
-- `name` is injected verbatim and is what the model must return (matched case-insensitively);
-- the brief's names are used as-is, including the space in "money mindset". No image overlay
-- exists for these names (prompts/image/topics/), so image jobs fall back to _generic.md.
INSERT INTO public.topics (id, name, label, sort_order) VALUES
  ('f0840000-0000-4000-8000-000000000401', 'credit',        'Credit',        0),
  ('f0840000-0000-4000-8000-000000000402', 'debt',          'Debt',          1),
  ('f0840000-0000-4000-8000-000000000403', 'spending',      'Spending',      2),
  ('f0840000-0000-4000-8000-000000000404', 'saving',        'Saving',        3),
  ('f0840000-0000-4000-8000-000000000405', 'income',        'Income',        4),
  ('f0840000-0000-4000-8000-000000000406', 'accounts',      'Accounts',      5),
  ('f0840000-0000-4000-8000-000000000407', 'planning',      'Planning',      6),
  ('f0840000-0000-4000-8000-000000000408', 'money mindset', 'Money mindset', 7)
ON CONFLICT DO NOTHING;

-- ---- 5. Tracks (brief §5) ------------------------------------------------------------
-- priority / order keep their column defaults (Moosii curates them in the CMS).
INSERT INTO public.tracks (id, track_name, description, track_type, weight, created_by)
SELECT id, btrim(track_name), btrim(description), btrim(track_type), weight::smallint, 'migration_084'
  FROM seed_084_tracks
ON CONFLICT (id) DO NOTHING;

-- ---- 6. Fact → track rules (brief §6) --------------------------------------------------
INSERT INTO public.fact_track_rules (fact_key, value, track_id)
SELECT r.fact_key, r.value, t.id
  FROM seed_084_rules r
  JOIN seed_084_tracks t ON t.slot = r.track_slot::int
ON CONFLICT DO NOTHING;

-- ---- 7. Default track: Getting Oriented (brief §6 note) ---------------------------------
INSERT INTO public.new_user_tracks (track_id)
SELECT t.id FROM seed_084_tracks t
 WHERE t.slot = 1
   AND NOT EXISTS (SELECT 1 FROM public.new_user_tracks n WHERE n.track_id = t.id);

COMMIT;

-- ============================================================================
-- VERIFICATION — run after applying (read-only).
-- 1. Counts — EXPECT prompts 2 (1 lesson active, 1 segment active), blocks 4 (tone, structure,
--    length, card_positions), size_profiles 1, topics 8, tracks 6, fact_rules 7, default_tracks 1:
--    SELECT prompt_type, is_active, count(*) FROM prompts GROUP BY 1, 2 ORDER BY 1;
--    SELECT block_type, name FROM prompt_blocks ORDER BY 1;
--    SELECT (SELECT count(*) FROM content_size_profiles) AS size_profiles,
--           (SELECT count(*) FROM topics) AS topics, (SELECT count(*) FROM tracks) AS tracks,
--           (SELECT count(*) FROM fact_track_rules) AS fact_rules,
--           (SELECT count(*) FROM new_user_tracks) AS default_tracks;
-- 2. generate_lessons will find exactly ONE active lesson row (it uses .single()) — EXPECT 1,
--    and the ages accept null — EXPECT ["integer", "null"] twice:
--    SELECT count(*) FROM prompts WHERE prompt_type = 'lesson' AND is_active;
--    SELECT output_schema #> '{schema,properties,classes,items,properties,min_child_age,type}',
--           output_schema #> '{schema,properties,classes,items,properties,max_child_age,type}'
--      FROM prompts WHERE prompt_type = 'lesson' AND is_active;
-- 3. The tone is fully wired (§2g) — EXPECT one row, every column true:
--    SELECT p.tone = 'Plain Money'  AS name_ok,
--           tb.block_type = 'tone' AND tb.name = 'plain_money' AS voice_ok,
--           sb.block_type = 'structure' AS structure_ok, lb.block_type = 'length' AS length_ok,
--           cb.block_type = 'card_positions' AS card_positions_ok, sp.name = 'standard' AS size_ok,
--           p.system_message !~* 'parent|child|infant|baby' AS no_parenting_system_message,
--           cb.content      !~* 'parent|child|infant|baby' AS no_parenting_card_positions
--      FROM prompts p
--      JOIN prompt_blocks tb ON tb.id = p.tone_block_id
--      JOIN prompt_blocks sb ON sb.id = p.structure_block_id
--      JOIN prompt_blocks lb ON lb.id = p.length_block_id
--      JOIN prompt_blocks cb ON cb.id = p.card_positions_block_id
--      JOIN content_size_profiles sp ON sp.id = p.size_profile_id
--     WHERE p.prompt_type = 'segment';
-- 4. Rules match brief §6 and Getting Oriented is the default — EXPECT 7 rows
--    (Credit Health ×2, Subscription Audit, Building a Buffer ×2, Paycheck Setup, Debt Payoff Plan),
--    then 'Getting Oriented':
--    SELECT r.fact_key, r.value, t.track_name FROM fact_track_rules r JOIN tracks t ON t.id = r.track_id ORDER BY 3, 1, 2;
--    SELECT t.track_name FROM new_user_tracks n JOIN tracks t ON t.id = n.track_id;
-- 5. A fact grants its track (ROLLED BACK; needs any existing auth user — skip while financial has
--    none): insert a matching user_facts row and read user_active_tracks_with_reason for that user,
--    EXPECT the rule's track labelled fact_match; then ROLLBACK.
-- ============================================================================
