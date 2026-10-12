// Segment-content user-message composer (src/lib/segmentPrompt.ts). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeUserMessage } from "../segmentPrompt";

const base = {
  scope: "SCOPE TEXT", toneContent: "TONE", structureContent: "STRUCT", cardPositionsContent: "CP", lengthContent: "LEN",
  lessonTitle: "Safe sleep", minChildAge: 0, maxChildAge: 6, segmentName: "Safe sleep", segmentDescription: "Desc", kind: "lesson", avoid: "AVOID",
};
const sparse = { scope: null, toneContent: "", structureContent: "", lengthContent: "", lessonTitle: "T", segmentName: "Other", segmentDescription: null };
const regen = {
  ...base, guidance: " fix it ",
  regenTarget: { sequence: 2, totalCards: 3, oldTitle: "Old", prevCard: { sequence: 1, title: "A", content: "a" }, nextCard: { sequence: 3, title: "C", content: "c" } },
};

// Captured from the composer BEFORE use_source_documents existed (2026-10-12). Without the
// option the rendered prompt must stay byte-identical.
const GOLDEN = {
  full: "SCOPE TEXT\n\n## Tone\n\nTONE\n\n## Structure\n\nSTRUCT\n\n## Card Positions\n\nCP\n\n## Length\n\nLEN\n\n## Avoid\n\nAVOID\n\n## Context\n\nLesson title: Safe sleep\nChild age range: 0–6 months\nThis is a lesson. Refer to it as \"this lesson\", never as a segment.\nDescription: Desc",
  sparse: "## Context\n\nLesson title: T\nThis is a lesson. Refer to it as \"this lesson\", never as a segment.\nLesson part: Other",
  regen: "SCOPE TEXT\n\n## Tone\n\nTONE\n\n## Structure\n\nSTRUCT\n\n## Card Positions\n\nCP\n\n## Length\n\nLEN\n\n## Avoid\n\nAVOID\n\n## Author Feedback (a prior version was REJECTED — apply this)\n\nfix it\n\n## Context\n\nLesson title: Safe sleep\nChild age range: 0–6 months\nThis is a lesson. Refer to it as \"this lesson\", never as a segment.\nDescription: Desc\n\n## Regeneration Target\n\nRegenerate ONLY card 2 of 3 (currently titled \"Old\").\nOutput a `cards` array containing exactly ONE card.\nThe replacement must fit coherently into the arc at this position.\nNeighboring cards (do NOT repeat their content):\n\n**Card 1 (before target) — \"A\":**\na\n\n**Card 3 (after target) — \"C\":**\nc",
};

test("without referenceDocuments the prompt is byte-identical to the pre-grounding composer", () => {
  assert.equal(composeUserMessage(base), GOLDEN.full);
  assert.equal(composeUserMessage(sparse), GOLDEN.sparse);
  assert.equal(composeUserMessage(regen), GOLDEN.regen);
  assert.equal(composeUserMessage({ ...base, referenceDocuments: "   " }), GOLDEN.full);
});

// The instructions text is the DB block (migration 110); the composer only adds the heading.
const INSTR = "BLOCK INSTRUCTIONS FROM prompt_blocks";
const SECTION = `## Reference Documents\n\n${INSTR}\n\nDOCS BODY`;

test("Reference Documents sits after Context and before Regeneration Target", () => {
  const out = composeUserMessage({ ...regen, referenceInstructions: INSTR, referenceDocuments: "DOCS BODY" });
  const ctx = out.indexOf("## Context"), ref = out.indexOf("## Reference Documents"), tgt = out.indexOf("## Regeneration Target");
  assert.ok(ctx >= 0 && ref > ctx && tgt > ref, `order: ctx=${ctx} ref=${ref} tgt=${tgt}`);
  assert.ok(out.includes(SECTION));
  // Inserting the section changes nothing else.
  assert.equal(out.replace(`\n\n${SECTION}`, ""), GOLDEN.regen);
});

test("Reference Documents is the last section when there is no regen target", () => {
  const out = composeUserMessage({ ...base, referenceInstructions: INSTR, referenceDocuments: "DOCS BODY" });
  assert.equal(out, `${GOLDEN.full}\n\n${SECTION}`);
});

test("the composer carries no grounding instruction text of its own", () => {
  // Without the block's text the section is only the heading + documents — no fallback prose.
  const out = composeUserMessage({ ...base, referenceDocuments: "DOCS BODY" });
  assert.equal(out, `${GOLDEN.full}\n\n## Reference Documents\n\nDOCS BODY`);
  // Instructions alone (no documents) render nothing.
  assert.equal(composeUserMessage({ ...base, referenceInstructions: INSTR }), GOLDEN.full);
});
