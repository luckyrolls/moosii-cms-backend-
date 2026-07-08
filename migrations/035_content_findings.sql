-- ============================================================================
-- Migration 035: content_findings + two review prompt rows (AI content review, slice 1)
-- ============================================================================
-- A READ-ONLY AI reviewer for lesson content. It produces FINDINGS for human judgment
-- — it never edits content, never approves/rejects, never emits a verdict/score.
-- Two structural rules:
--   1. Read-only by construction: the review job writes ONLY content_findings (+ the
--      ai_generation_log, like every AI call). No content-table writes exist in its path.
--   2. Findings-or-silence: output is a list of specific flagged issues (possibly empty).
--      There is NO pass/verdict/score field anywhere. An empty list means nothing was
--      flagged — NOT that the content is endorsed.
--
-- Findings anchor to a CARD (sub_segments) or to the LESSON (sub_segment_id NULL =
-- cross-card / lesson-level). correlation_id ties one run's findings together (= the
-- review job id; also the ai_generation_log correlation_id) and distinguishes re-runs:
-- a re-run INSERTS new rows, the previous run's rows remain. Deduplication /
-- fingerprinting across runs is DEFERRED (slice 3).
--
-- severity + status are HUMAN-workflow fields the CMS renders: severity is
-- reviewer-assigned advice (humans may ignore it); status tracks what a human did with
-- the finding. review_type is left unconstrained text — slice 2 adds doc-grounded types.
--
-- Flag: regenerate database.types.ts after apply (adds content_findings). The handler
-- uses a scoped `supabase as any` bridge meanwhile.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..035 reconciliation list.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS content_findings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id uuid NOT NULL,                                  -- the review run (= job id)
  review_type    text NOT NULL,                                  -- best_practices | factual_smell | (slice 2 …)
  lesson_id      uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  sub_segment_id uuid REFERENCES sub_segments(id) ON DELETE CASCADE,  -- NULL = lesson-level finding
  finding        text NOT NULL,
  severity       text NOT NULL DEFAULT 'info'
                   CHECK (severity IN ('info', 'warning', 'issue')),   -- reviewer-assigned; humans may ignore
  status         text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'dismissed', 'addressed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  dismissed_at   timestamptz,
  dismissed_by   uuid,
  addressed_at   timestamptz,
  addressed_by   uuid
);

CREATE INDEX IF NOT EXISTS content_findings_lesson_idx      ON content_findings (lesson_id);
CREATE INDEX IF NOT EXISTS content_findings_sub_segment_idx ON content_findings (sub_segment_id);
CREATE INDEX IF NOT EXISTS content_findings_correlation_idx ON content_findings (correlation_id);
CREATE INDEX IF NOT EXISTS content_findings_open_idx        ON content_findings (lesson_id, status) WHERE status = 'open';

COMMENT ON TABLE content_findings IS
  'AI content-review findings for human judgment (read-only reviewer). One row per '
  'flagged issue. sub_segment_id NULL = lesson-level. correlation_id = the review run '
  '(job id). No verdict/score column by design — findings-or-silence. Migration 035.';

-- ---------------------------------------------------------------------------
-- Seed the two slice-1 review prompts (prompt_type = review_<type>). Draft text —
-- tuned in the CMS afterwards. The output_schema is the BARE findings schema (passed
-- as responseSchema; the provider adapts it). NOTE: no pass/verdict field exists in
-- the schema — findings-or-silence is enforced by shape.
-- ---------------------------------------------------------------------------
INSERT INTO prompts (prompt_type, tone, is_active, model, temperature, max_tokens, system_message, output_schema)
VALUES
(
  'review_best_practices',
  'Review: best practices',
  true,
  'gpt-4o',
  0.2,
  4000,
  $sys$You are a meticulous content reviewer for a parenting-education app. You review lesson cards for VOICE and CRAFT and flag specific issues for a human editor to judge. You do NOT edit, rewrite, score, or approve. You only flag.

Flag issues such as:
- AI-tells and generic filler: throat-clearing openers ("It's important to", "In today's world", "As a parent"), hedging ("might", "could", "may help"), empty transitions, listy sameness, over-balanced "on one hand / on the other".
- Voice problems: not warm/direct, corporate or clinical tone, talking down, vagueness where a concrete image is needed.
- Reading level too high for a tired new parent (aim ~7th grade, short sentences, fragments OK).
- Structure problems: a card that buries its point, two ideas crammed in one card, a weak or missing takeaway, cards that don't build.

Rules:
- Output ONLY specific flagged issues. If a card is fine, say nothing about it. If the whole lesson is fine, return an empty findings list. NEVER return a "looks good", a score, or a pass/fail — an empty list already means "nothing flagged".
- Each finding: name the exact problem and where it is. Reference a specific card by its card_id when the issue is in one card; use null card_ref for a cross-card / whole-lesson issue (e.g. cards don't build, tone drifts across the lesson).
- Assign severity: info (minor/stylistic), warning (notable, worth a look), issue (likely should change). This is advice for the human, not a verdict.
- You are flagging for HUMAN judgment. Do not be exhaustive for its own sake; flag what genuinely matters.$sys$,
  '{"type":"object","properties":{"findings":{"type":"array","items":{"type":"object","properties":{"card_ref":{"type":["string","null"],"description":"the exact card_id this finding is about, or null for a lesson-level / cross-card finding"},"finding":{"type":"string","description":"the specific issue, and where it is"},"severity":{"type":"string","enum":["info","warning","issue"]}},"required":["card_ref","finding","severity"]}}},"required":["findings"]}'::jsonb
),
(
  'review_factual_smell',
  'Review: factual smell test',
  true,
  'gpt-4o',
  0.2,
  4000,
  $sys$You are a careful reviewer for a parenting-education app. Your ONLY job is to flag confident, specific claims that a HUMAN should verify before publishing. You are NOT a fact-checker. You do NOT decide whether a claim is true or false, and you do NOT correct it. You raise a hand and say "a human should check this".

Flag things like:
- Specific statistics or numbers presented as fact ("70% of babies", "reduces risk by half", "within 3 weeks").
- Appeals to authority or evidence ("studies show", "experts agree", "the AAP recommends", "research proves").
- Precise medical, safety, or developmental specifics stated confidently (dosages, ages/milestones as hard cutoffs, cause-and-effect health claims).
- Named products, guidelines, or organizations attributed a specific position.

Do NOT flag:
- Ordinary supportive, emotional, or opinion prose ("you're doing better than you think", "it's okay to feel overwhelmed").
- Soft, hedged, or general guidance that makes no specific factual claim.
- Common-sense statements no reasonable person would need to verify.

Rules:
- Output ONLY the specific claims to verify. If nothing warrants a check, return an empty findings list. NEVER return a "looks accurate", a score, or a pass/fail — an empty list already means "nothing flagged". You are not endorsing anything you don't flag.
- Each finding: quote or name the exact claim and say what a human should verify. Reference the specific card by its card_id; use null card_ref only for a lesson-wide pattern.
- Severity: info (minor specific), warning (specific claim worth checking), issue (a strong medical/safety claim that really should be verified). Advice, not a verdict.$sys$,
  '{"type":"object","properties":{"findings":{"type":"array","items":{"type":"object","properties":{"card_ref":{"type":["string","null"],"description":"the exact card_id this finding is about, or null for a lesson-level / cross-card finding"},"finding":{"type":"string","description":"the specific claim to verify, and what to check"},"severity":{"type":"string","enum":["info","warning","issue"]}},"required":["card_ref","finding","severity"]}}},"required":["findings"]}'::jsonb
);

COMMIT;
