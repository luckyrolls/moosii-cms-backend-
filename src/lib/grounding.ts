// Grounded ("informed") segment-content generation — use_source_documents. PURE (no DB, no
// env), unit-tested in src/lib/__tests__/grounding.test.ts. The DB reads live in
// src/lib/sourceDocuments.ts. The instructions TEXT and the size CAP are both DB-owned
// (migration 110): there is deliberately no fallback text or literal cap here.

// authority_note is carried because the doc_grounded review renders it; generation ignores it.
export type SourceDoc = { id: string; name: string; version_label: string; authority_note: string | null; body: string };

// Composition keys (not text). The block is a shared singleton resolved by (block_type, name),
// like card_positions' immutable name; the cap is an app_settings row.
export const GROUNDING_BLOCK_TYPE = "grounding";
export const GROUNDING_BLOCK_NAME = "grounding_v1";
export const GROUNDING_MAX_CHARS_KEY = "grounding_max_chars";

// Deterministic order for every reader of linked documents: name, then id (code-point
// compare, so it doesn't depend on the server locale). Returns a new array.
export function sortSourceDocs<T extends { id: string; name: string }>(docs: T[]): T[] {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...docs].sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));
}

// The grounding block must exist, be active and have content. Missing → FAIL before the
// model call; never fall back to text in code.
export function requireGroundingInstructions(
  block: { content: string | null; is_active: boolean | null } | null | undefined
): string {
  if (!block) {
    throw new Error(
      `Grounding instructions block (prompt_blocks ${GROUNDING_BLOCK_TYPE}/${GROUNDING_BLOCK_NAME}) not found — ` +
      `apply migration 110 or turn off use_source_documents.`
    );
  }
  if (!block.is_active) {
    throw new Error(`Grounding instructions block ${GROUNDING_BLOCK_TYPE}/${GROUNDING_BLOCK_NAME} is inactive — reactivate it or turn off use_source_documents.`);
  }
  if (!block.content || !block.content.trim()) {
    throw new Error(`Grounding instructions block ${GROUNDING_BLOCK_TYPE}/${GROUNDING_BLOCK_NAME} is empty — use_source_documents cannot run without it.`);
  }
  return block.content;
}

// app_settings.grounding_max_chars → a positive integer. Missing or malformed → FAIL (no
// literal default).
export function parseGroundingMaxChars(value: string | null | undefined): number {
  const v = (value ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(v)) {
    throw new Error(
      `app_settings.${GROUNDING_MAX_CHARS_KEY} is ${value == null ? "missing" : `invalid ("${value}")`} — ` +
      `apply migration 110 or set a positive integer, or turn off use_source_documents.`
    );
  }
  return Number(v);
}

// Zero-docs and size checks for GENERATION (the review has no cap). Throws legibly, before
// any LLM call or destructive step. Never truncates: a cut document would make "informed
// by doc X" false.
export function checkGroundingDocs<T extends { body: string }>(lessonId: string, docs: T[], maxChars: number): T[] {
  if (docs.length === 0) {
    throw new Error(`No source documents linked to lesson ${lessonId} — link at least one or turn off use_source_documents.`);
  }
  const total = docs.reduce((n, d) => n + (d.body ?? "").length, 0);
  if (total > maxChars) {
    throw new Error(
      `Linked source documents for lesson ${lessonId} total ${total} characters, over the ${maxChars} limit ` +
      `(app_settings.${GROUNDING_MAX_CHARS_KEY}) — unlink or shorten a document, or turn off use_source_documents.`
    );
  }
  return docs;
}

// Body of the ## Reference Documents section (after the block's instructions). No doc_id
// (the model echoes labels back into card text — see contentContext.ts) and no
// authority_note (human commentary that could leak into copy).
export function renderReferenceDocuments(docs: SourceDoc[]): string {
  return docs.map((d) => `### ${d.name} (version: ${d.version_label})\n\n${d.body}`).join("\n\n---\n\n");
}

// Provenance snapshot returned in jobs.result.grounding (version_label copied at generation
// time — same staleness model as content_findings.source_version_label).
export function groundingSnapshot(docs: SourceDoc[]): { documents: { id: string; name: string; version_label: string; chars: number }[] } {
  return { documents: docs.map((d) => ({ id: d.id, name: d.name, version_label: d.version_label, chars: (d.body ?? "").length })) };
}

// Suffix for ai_generation_log.notes.
export function groundingNote(docs: SourceDoc[]): string {
  return `grounded: [${docs.map((d) => `${d.id}@${d.version_label}`).join(", ")}]`;
}
