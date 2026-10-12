// The review USER message composer — PURE (no DB, no env), golden-tested in
// src/lib/__tests__/reviewPrompt.test.ts. Moved verbatim from reviewLesson.ts.
// NO size cap: the doc_grounded review always sees every linked document in full
// (the grounding cap applies to GENERATION only — src/lib/grounding.ts).
import type { SourceDoc } from "./grounding";

export type ReviewCard = { id: string; title: string | null; content: string | null; sequence: number | null };

// Present each card prefixed with its card_id; the model echoes that id back as
// card_ref (or null for a lesson-level finding). For doc_grounded, the linked authority
// documents are appended, each prefixed with its doc_id (echoed back as source_document_ref).
export function composeReviewUserMessage(lessonName: string, cards: ReviewCard[], docs: SourceDoc[] = []): string {
  const cardText = cards
    .map((c) => `[card_id: ${c.id}] Card ${c.sequence ?? "?"}: ${c.title ?? ""}\n${c.content ?? ""}`)
    .join("\n\n");
  const docSection = docs.length === 0 ? "" :
    `\n\n## Source documents (designated authority — check the cards for CONSISTENCY with these)\n` +
    `Each is prefixed with its doc_id; set source_document_ref to the doc_id a finding concerns.\n\n` +
    docs.map((d) =>
      `[doc_id: ${d.id}] ${d.name} (version: ${d.version_label})` +
      (d.authority_note ? `\nAuthority: ${d.authority_note}` : "") +
      `\n${d.body}`
    ).join("\n\n---\n\n");
  return (
    `## Lesson: ${lessonName}\n\n` +
    `## Cards to review\n` +
    `Each card below is prefixed with its card_id. In each finding, set card_ref to the ` +
    `EXACT card_id it concerns, or null for a lesson-level / cross-card finding.\n\n` +
    cardText +
    docSection
  );
}
