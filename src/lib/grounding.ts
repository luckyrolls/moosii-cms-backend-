// Grounded ("informed") segment-content generation — use_source_documents. PURE (no DB, no
// env), unit-tested in src/lib/__tests__/grounding.test.ts. The loader lives in
// src/lib/sourceDocuments.ts.

export type SourceDoc = { id: string; name: string; version_label: string; authority_note: string | null; body: string };

// Total body characters a grounded generation may carry (~50k tokens, well inside gpt-4o's
// 128k window). Over the cap FAILS — never truncate: a cut document would make
// "informed by doc X" false.
export const GROUNDING_MAX_CHARS = 200_000;

// Stable order (name, then id) + zero-docs and size checks. Throws legibly, before any LLM
// call or destructive step.
export function prepareGroundingDocs(lessonId: string, docs: SourceDoc[]): SourceDoc[] {
  if (docs.length === 0) {
    throw new Error(`No source documents linked to lesson ${lessonId} — link at least one or turn off use_source_documents.`);
  }
  const total = docs.reduce((n, d) => n + (d.body ?? "").length, 0);
  if (total > GROUNDING_MAX_CHARS) {
    throw new Error(
      `Linked source documents for lesson ${lessonId} total ${total} characters, over the ${GROUNDING_MAX_CHARS} limit — ` +
      `unlink or shorten a document, or turn off use_source_documents.`
    );
  }
  return [...docs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Body of the ## Reference Documents section. No doc_id (the model echoes labels back into
// card text — see contentContext.ts) and no authority_note (human commentary that could leak
// into copy). Name + version identify each document.
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
