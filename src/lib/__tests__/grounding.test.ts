// Grounded-generation helpers (src/lib/grounding.ts). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prepareGroundingDocs, renderReferenceDocuments, groundingSnapshot, groundingNote, GROUNDING_MAX_CHARS, type SourceDoc,
} from "../grounding";

const doc = (id: string, name: string, body = "Body text.", authority_note: string | null = "Designated by the clinical owner"): SourceDoc =>
  ({ id, name, version_label: `ver-${name}`, authority_note, body });

test("zero linked docs fails legibly, naming the lesson and the option", () => {
  assert.throws(() => prepareGroundingDocs("L1", []), /No source documents linked to lesson L1 .*use_source_documents/);
});

test("over the size cap fails (never truncates)", () => {
  const big = "x".repeat(GROUNDING_MAX_CHARS);
  assert.doesNotThrow(() => prepareGroundingDocs("L1", [doc("a", "A", big)]));
  assert.throws(() => prepareGroundingDocs("L1", [doc("a", "A", big), doc("b", "B", "y")]), /over the 200000 limit/);
});

test("order is stable: by name, then id, regardless of load order", () => {
  const docs = [doc("2", "Beta"), doc("9", "Alpha"), doc("1", "Beta")];
  assert.deepEqual(prepareGroundingDocs("L1", docs).map((d) => d.id), ["9", "1", "2"]);
  assert.deepEqual(docs.map((d) => d.id), ["2", "9", "1"], "input not mutated");
});

test("renderer shows name + version + body, never doc ids or the authority note", () => {
  const out = renderReferenceDocuments([doc("uuid-1", "NIH Safe to Sleep", "Place baby on back."), doc("uuid-2", "AAP", "Bare crib.")]);
  assert.equal(out, "### NIH Safe to Sleep (version: ver-NIH Safe to Sleep)\n\nPlace baby on back.\n\n---\n\n### AAP (version: ver-AAP)\n\nBare crib.");
  assert.doesNotMatch(out, /uuid-|doc_id|Designated/);
});

test("snapshot + log note carry id and version_label", () => {
  const docs = [doc("a", "A", "12345")];
  assert.deepEqual(groundingSnapshot(docs), { documents: [{ id: "a", name: "A", version_label: "ver-A", chars: 5 }] });
  assert.equal(groundingNote(docs), "grounded: [a@ver-A]");
});
