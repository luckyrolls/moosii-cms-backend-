// doc_grounded / review user-message composer (src/lib/reviewPrompt.ts). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeReviewUserMessage, type ReviewCard } from "../reviewPrompt";
import { sortSourceDocs, type SourceDoc } from "../grounding";

const cards: ReviewCard[] = [
  { id: "c1", title: "Back to sleep", content: "Always on the back.", sequence: 1 },
  { id: "c2", title: null, content: "Bare crib.", sequence: null },
];
// Load order as the DB might return it (Zeta first).
const docsAsLoaded: SourceDoc[] = [
  { id: "d2", name: "Zeta guide", version_label: "2021", authority_note: null, body: "Zeta body." },
  { id: "d1", name: "Alpha guide", version_label: "AAP 2022", authority_note: "Designated by the clinical owner", body: "Alpha body." },
];

// Captured from reviewLesson.ts at dd99d1b, BEFORE the composer moved and the loader started
// sorting (2026-10-12). withDocs = the old unsorted order; sorted = the same docs in name order.
const GOLDEN = {
  noDocs: "## Lesson: Safe sleep\n\n## Cards to review\nEach card below is prefixed with its card_id. In each finding, set card_ref to the EXACT card_id it concerns, or null for a lesson-level / cross-card finding.\n\n[card_id: c1] Card 1: Back to sleep\nAlways on the back.\n\n[card_id: c2] Card ?: \nBare crib.",
  withDocs: "## Lesson: Safe sleep\n\n## Cards to review\nEach card below is prefixed with its card_id. In each finding, set card_ref to the EXACT card_id it concerns, or null for a lesson-level / cross-card finding.\n\n[card_id: c1] Card 1: Back to sleep\nAlways on the back.\n\n[card_id: c2] Card ?: \nBare crib.\n\n## Source documents (designated authority — check the cards for CONSISTENCY with these)\nEach is prefixed with its doc_id; set source_document_ref to the doc_id a finding concerns.\n\n[doc_id: d2] Zeta guide (version: 2021)\nZeta body.\n\n---\n\n[doc_id: d1] Alpha guide (version: AAP 2022)\nAuthority: Designated by the clinical owner\nAlpha body.",
  sorted: "## Lesson: Safe sleep\n\n## Cards to review\nEach card below is prefixed with its card_id. In each finding, set card_ref to the EXACT card_id it concerns, or null for a lesson-level / cross-card finding.\n\n[card_id: c1] Card 1: Back to sleep\nAlways on the back.\n\n[card_id: c2] Card ?: \nBare crib.\n\n## Source documents (designated authority — check the cards for CONSISTENCY with these)\nEach is prefixed with its doc_id; set source_document_ref to the doc_id a finding concerns.\n\n[doc_id: d1] Alpha guide (version: AAP 2022)\nAuthority: Designated by the clinical owner\nAlpha body.\n\n---\n\n[doc_id: d2] Zeta guide (version: 2021)\nZeta body.",
};

test("review prompt is byte-identical to the pre-move composer for the same doc order", () => {
  assert.equal(composeReviewUserMessage("Safe sleep", cards), GOLDEN.noDocs);
  assert.equal(composeReviewUserMessage("Safe sleep", cards, docsAsLoaded), GOLDEN.withDocs);
});

test("with the shared loader's sort, the only change is document ORDER", () => {
  const now = composeReviewUserMessage("Safe sleep", cards, sortSourceDocs(docsAsLoaded));
  assert.equal(now, GOLDEN.sorted);
  // Same multiset of lines as before: nothing added, dropped or reworded (authority note kept).
  assert.deepEqual(now.split("\n").sort(), GOLDEN.withDocs.split("\n").sort());
  assert.match(now, /Authority: Designated by the clinical owner/);
});

test("the review has NO size cap: a lesson far over the generation cap renders every document in full", () => {
  const big: SourceDoc[] = [
    { id: "b1", name: "Big A", version_label: "1", authority_note: null, body: "a".repeat(60_000) },
    { id: "b2", name: "Big B", version_label: "1", authority_note: null, body: "b".repeat(60_000) },
  ];
  const out = composeReviewUserMessage("Safe sleep", cards, sortSourceDocs(big));
  assert.ok(out.includes("a".repeat(60_000)) && out.includes("b".repeat(60_000)), "both 60k bodies present, untruncated");
});

test("the review path never touches the generation cap or its guard", () => {
  const src = readFileSync(join(__dirname, "../../jobs/handlers/reviewLesson.ts"), "utf8");
  for (const forbidden of ["grounding_max_chars", "checkGroundingDocs", "parseGroundingMaxChars", "loadGrounding"]) {
    assert.ok(!src.includes(forbidden), `reviewLesson.ts must not reference ${forbidden}`);
  }
  assert.ok(src.includes("loadLinkedDocs(lesson_id)"), "review loads docs via the uncapped shared loader");
  const loader = readFileSync(join(__dirname, "../sourceDocuments.ts"), "utf8");
  const fn = loader.slice(loader.indexOf("export async function loadLinkedDocs"), loader.indexOf("export async function loadGrounding"));
  assert.ok(fn.length > 0 && !/checkGroundingDocs|maxChars|grounding_max_chars/.test(fn), "loadLinkedDocs applies no cap");
});
