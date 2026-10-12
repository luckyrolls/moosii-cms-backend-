// The segment-content USER message composer — PURE (no DB, no env), so the rendered layer
// order is unit-tested (src/lib/__tests__/segmentPrompt.test.ts). Moved verbatim from
// generateSegmentContent.ts, which re-exports it; every content path (generate, regen
// whole_segment + single_card, the track batch via generateSegmentContent) composes here.
import { contentContextLines } from "./contentContext";

export type RegenTarget = {
  sequence: number;
  totalCards: number;
  oldTitle: string;
  prevCard: { sequence: number; title: string; content: string } | null;
  nextCard: { sequence: number; title: string; content: string } | null;
};

// Render the lesson's developmental window for the ## Context block. Null bounds are
// open-ended; both-null → no line (don't assert an age the lesson never recorded).
function formatChildAge(min?: number | null, max?: number | null): string | null {
  const hasMin = typeof min === "number";
  const hasMax = typeof max === "number";
  if (hasMin && hasMax) return `Child age range: ${min}–${max} months`;
  if (hasMin) return `Child age range: ${min} months and older`;
  if (hasMax) return `Child age range: up to ${max} months`;
  return null;
}

// Header + framing for the grounded-generation section. A code constant (like the Author
// Feedback header), not a DB block — pinned while informed mode is proven.
export const REFERENCE_DOCUMENTS_HEADER =
  "## Reference Documents\n\n" +
  "The documents below are the designated sources for this lesson. Use them as the factual basis " +
  "for the cards and never contradict them. Do not cite, name or quote them in the card text, and do " +
  "not copy long passages — write in the voice above. The Tone, Structure, Card Positions and Length " +
  "rules still apply. You may still write supportive or practical content the documents do not cover, " +
  "but any specific fact, number or guideline you state must agree with them.";

export function composeUserMessage(opts: {
  scope: string | null;
  toneContent: string;
  structureContent: string;
  cardPositionsContent?: string;   // per-position card rules — sits BETWEEN structure and length
  lengthContent: string;
  lessonTitle: string;
  minChildAge?: number | null;   // the lesson's developmental window — the SPECIFIC age
  maxChildAge?: number | null;   // band for THIS lesson (voice/examples should fit it)
  segmentName: string;
  segmentDescription: string | null;
  kind?: string | null;      // lessons.kind (107): 'lesson' | 'activity' — the text refers to itself correctly
  avoid?: string;           // error-severity voice-lint bans (prevention layer)
  guidance?: string;         // author feedback from a rejection — steers this regen
  referenceDocuments?: string; // rendered linked source documents (use_source_documents)
  regenTarget?: RegenTarget;
}): string {
  const parts: string[] = [];
  if (opts.scope)            parts.push(opts.scope);
  if (opts.toneContent)      parts.push(`## Tone\n\n${opts.toneContent}`);
  if (opts.structureContent) parts.push(`## Structure\n\n${opts.structureContent}`);
  if (opts.cardPositionsContent) parts.push(`## Card Positions\n\n${opts.cardPositionsContent}`);
  if (opts.lengthContent)    parts.push(`## Length\n\n${opts.lengthContent}`);
  if (opts.avoid)            parts.push(`## Avoid\n\n${opts.avoid}`);
  // Author feedback is authoritative — a human rejected the prior version. Placed
  // high and stated as a directive so the model prioritizes it.
  if (opts.guidance && opts.guidance.trim()) {
    parts.push(`## Author Feedback (a prior version was REJECTED — apply this)\n\n${opts.guidance.trim()}`);
  }

  // The lesson's SPECIFIC age band — accurate per lesson (a toddler lesson says 24–36mo,
  // not a global constant). Keeps age out of the reusable tone: voice belongs to the tone,
  // the age specific belongs to the lesson. Omitted when the lesson has no bounds recorded.
  // Context lines never show the internal word "segment" (src/lib/contentContext.ts); they say
  // whether this is a lesson or an activity (lessons.kind, migration 107).
  const ctx = contentContextLines({
    lessonTitle: opts.lessonTitle,
    ageLine: formatChildAge(opts.minChildAge, opts.maxChildAge),
    kind: opts.kind,
    segmentName: opts.segmentName,
    segmentDescription: opts.segmentDescription,
  });
  parts.push(`## Context\n\n${ctx.join("\n")}`);

  // Grounded ("informed") generation — use_source_documents. Runtime data about THIS lesson,
  // so it sits with Context; Regeneration Target stays last. Informed, not strict: content the
  // documents don't cover may still be written.
  if (opts.referenceDocuments && opts.referenceDocuments.trim()) {
    parts.push(`${REFERENCE_DOCUMENTS_HEADER}\n\n${opts.referenceDocuments}`);
  }

  if (opts.regenTarget) {
    const { sequence, totalCards, oldTitle, prevCard, nextCard } = opts.regenTarget;
    const neighborLines: string[] = [];

    if (prevCard) {
      neighborLines.push(
        `**Card ${prevCard.sequence} (before target) — "${prevCard.title}":**\n${prevCard.content}`
      );
    }
    if (nextCard) {
      neighborLines.push(
        `**Card ${nextCard.sequence} (after target) — "${nextCard.title}":**\n${nextCard.content}`
      );
    }

    const neighborBlock = neighborLines.length > 0
      ? `\nNeighboring cards (do NOT repeat their content):\n\n${neighborLines.join("\n\n")}`
      : "";

    parts.push(
      `## Regeneration Target\n\nRegenerate ONLY card ${sequence} of ${totalCards} (currently titled "${oldTitle}").` +
      `\nOutput a \`cards\` array containing exactly ONE card.` +
      `\nThe replacement must fit coherently into the arc at this position.` +
      neighborBlock
    );
  }

  return parts.join("\n\n");
}
