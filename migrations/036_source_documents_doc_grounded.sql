-- ============================================================================
-- Migration 036: source_documents + doc_grounded review (content review slice 2)
-- ============================================================================
-- Proofing lesson content against designated AUTHORITY documents. Same review
-- discipline as slice 1: read-only, findings-or-silence, no verdicts. New rules for
-- this type:
--   THREE-WAY claim classification — supported / contradicted / not-addressed. ONLY
--   `contradicted` and specific-but-`unsupported` claims (and cross-doc disagreement)
--   become findings. Content merely NOT covered by a source is NOT a finding — that
--   noise rule is the whole point (signal, not coverage-nagging).
--   The AI checks CONSISTENCY with the designated source; it never judges which source
--   is right. Two linked docs disagreeing = a finding for a human, not a resolution.
--   Document AUTHORITY is a human decision (clinically, Michelle's) — source_documents
--   carries an authority_note for exactly that.
--
-- Ingestion is PASTE-ONLY for v1 (source_documents.body holds already-extracted text;
-- there is no PDF/multipart lib in the stack and adding one is out of scope here — PDF
-- deferred). Extraction happens ONCE at ingestion; reviews only ever read stored text.
--
-- RLS: source_documents / lesson_source_documents are internal, content-bearing (may
-- hold licensed guideline text) — NOT app-facing. They belong on the RLS sweep
-- (docs/rls-sweep.md, started with this migration): RLS ENABLED, NO anon/public read.
-- The backend uses the service role and bypasses RLS regardless.
--
-- Flag: regenerate database.types.ts after apply (adds source_documents,
-- lesson_source_documents, and content_findings columns). Handlers/routes use a scoped
-- `supabase as any` bridge meanwhile.
--
-- APPLY VIA THE SUPABASE SQL EDITOR — on the 008..036 reconciliation list.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- source_documents — the authority library. body = extracted text (paste v1).
-- version_label + authority_note are HUMAN-entered. Updating body/version does NOT
-- cascade to existing findings (their recorded version is the staleness signal).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  body           text NOT NULL,                 -- extracted document text
  origin_url     text,                          -- where it came from (optional)
  version_label  text NOT NULL,                 -- human, e.g. '2021' / 'AAP 2022'
  authority_note text,                          -- who designated it and why (free text)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- lesson ↔ document linkage (LESSON-LEVEL by design: a review reads all the lesson's
-- cards against all linked docs). PK on the pair = idempotent linking.
CREATE TABLE IF NOT EXISTS lesson_source_documents (
  lesson_id          uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  source_document_id uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lesson_id, source_document_id)
);
CREATE INDEX IF NOT EXISTS lesson_source_documents_doc_idx ON lesson_source_documents (source_document_id);

-- ---------------------------------------------------------------------------
-- content_findings — doc-grounded additions (all NULL for best_practices/factual_smell).
--   source_document_id     — the doc a finding is about (contradicted / cross-doc).
--   source_version_label   — COPIED snapshot of that doc's version AT REVIEW TIME. This
--                            is the staleness signal: finding says '2021', doc now
--                            '2025' → recompute. NOT a live FK to version.
--   finding_kind           — the three-way outcome that became a finding.
--   claim_quote            — the exact lesson claim.
--   source_passage         — the relevant source passage (or 'no passage found').
-- ON DELETE SET NULL: deleting a doc keeps the finding + its recorded version snapshot.
-- ---------------------------------------------------------------------------
ALTER TABLE content_findings
  ADD COLUMN IF NOT EXISTS source_document_id   uuid REFERENCES source_documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_version_label text,
  ADD COLUMN IF NOT EXISTS finding_kind         text,
  ADD COLUMN IF NOT EXISTS claim_quote          text,
  ADD COLUMN IF NOT EXISTS source_passage       text;

ALTER TABLE content_findings
  DROP CONSTRAINT IF EXISTS content_findings_finding_kind_check;
ALTER TABLE content_findings
  ADD CONSTRAINT content_findings_finding_kind_check
  CHECK (finding_kind IS NULL OR finding_kind IN ('contradicted', 'unsupported', 'cross_doc_disagreement'));

COMMENT ON COLUMN content_findings.source_version_label IS
  'The linked doc''s version_label at REVIEW time (copied snapshot). Staleness signal: '
  'compare to source_documents.version_label live. Migration 036.';

-- ---------------------------------------------------------------------------
-- Seed the doc_grounded review prompt (prompt_type = review_doc_grounded). Draft text —
-- tuned in the CMS afterwards. Richer output_schema than slice-1 types: each finding
-- carries the classification, the claim quote, the source passage, and which doc.
-- ---------------------------------------------------------------------------
INSERT INTO prompts (prompt_type, tone, is_active, model, temperature, max_tokens, system_message, output_schema)
VALUES
(
  'review_doc_grounded',
  'Review: doc-grounded proofing',
  true,
  'gpt-4o',
  0.1,
  6000,
  $sys$You are a careful reviewer for a parenting-education app. You check whether the lesson's cards are CONSISTENT with the DESIGNATED SOURCE DOCUMENT(S) provided below. You do NOT decide which source is correct, you do NOT fact-check against your own knowledge, and you do NOT rewrite anything. You raise specific flags for a human editor.

For every substantive claim in the cards, classify it against the source document(s):
- SUPPORTED — the source backs it. Say NOTHING. Not a finding.
- NOT-ADDRESSED — the source simply doesn't cover it. Say NOTHING. This is NOT a finding. (Do not flag content just because the source is silent on it — that is noise.)
- CONTRADICTED — the source says something incompatible with the card. THIS IS A FINDING (kind="contradicted", severity="issue"). Quote the card claim and the exact source passage it conflicts with.

Also flag, as findings:
- SPECIFIC-BUT-UNSUPPORTED — a confident specific claim (a statistic, a precise number, a named guideline/threshold, a strong causal or medical assertion) that has NO provenance in ANY linked document. (kind="unsupported", severity="warning", source_passage="no passage found"). Do NOT flag ordinary supportive, emotional, or general prose — only confident SPECIFICS that assert fact.
- CROSS-DOCUMENT DISAGREEMENT — two linked documents disagree about a claim the card makes. Flag it for human adjudication; do NOT pick a winner. (kind="cross_doc_disagreement", severity="warning"). Quote both sides in the source_passage.

Hard rules:
- Output ONLY findings of the three kinds above. If nothing qualifies, return an empty findings list. NEVER return a "looks accurate", a score, or a pass/fail — an empty list means nothing was flagged, NOT that the content is endorsed or fully covered.
- You are checking CONSISTENCY WITH THE DESIGNATED SOURCE, not truth. If a card disagrees with the source, that is a finding even if the card might be "right" — the human decides.
- Each finding: set card_ref to the exact card_id (or null for a lesson-level pattern); claim_quote = the exact card text; source_passage = the exact source text (or "no passage found" for unsupported); source_document_ref = the doc_id the finding concerns (for cross-doc, the primary one; null only if truly none applies).$sys$,
  '{"type":"object","properties":{"findings":{"type":"array","items":{"type":"object","properties":{"card_ref":{"type":["string","null"],"description":"exact card_id, or null for a lesson-level finding"},"kind":{"type":"string","enum":["contradicted","unsupported","cross_doc_disagreement"]},"finding":{"type":"string","description":"the specific issue for the human"},"severity":{"type":"string","enum":["info","warning","issue"]},"claim_quote":{"type":"string","description":"the exact card claim"},"source_passage":{"type":"string","description":"the exact source passage, or \"no passage found\""},"source_document_ref":{"type":["string","null"],"description":"the doc_id this finding concerns, or null"}},"required":["card_ref","kind","finding","severity","claim_quote","source_passage","source_document_ref"]}}},"required":["findings"]}'::jsonb
);

COMMIT;
