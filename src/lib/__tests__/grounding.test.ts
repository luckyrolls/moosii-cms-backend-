// Grounded-generation helpers (src/lib/grounding.ts). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sortSourceDocs, requireGroundingInstructions, parseGroundingMaxChars, checkGroundingDocs,
  renderReferenceDocuments, groundingSnapshot, groundingNote, type SourceDoc,
} from "../grounding";

const doc = (id: string, name: string, body = "Body text.", authority_note: string | null = "Designated by the clinical owner"): SourceDoc =>
  ({ id, name, version_label: `ver-${name}`, authority_note, body });

// ---- missing / inactive block → fail before the model call, no fallback text ----
test("grounding block missing fails legibly", () => {
  assert.throws(() => requireGroundingInstructions(null), /grounding\/grounding_v1\) not found .*migration 110/);
  assert.throws(() => requireGroundingInstructions(undefined), /not found/);
});

test("grounding block inactive or empty fails legibly", () => {
  assert.throws(() => requireGroundingInstructions({ content: "Rules.", is_active: false }), /is inactive/);
  assert.throws(() => requireGroundingInstructions({ content: "   ", is_active: true }), /is empty/);
  assert.throws(() => requireGroundingInstructions({ content: null, is_active: true }), /is empty/);
});

test("an active block's content is returned as is", () => {
  assert.equal(requireGroundingInstructions({ content: "Use the documents.", is_active: true }), "Use the documents.");
});

// ---- the cap comes from app_settings.grounding_max_chars (seeded 30000), never a literal ----
test("cap parses the app_settings value; missing or malformed fails (no default)", () => {
  assert.equal(parseGroundingMaxChars("30000"), 30000);
  assert.equal(parseGroundingMaxChars(" 30000 "), 30000);
  for (const bad of [null, undefined, "", "0", "-5", "30k", "3e4", "1.5"]) {
    assert.throws(() => parseGroundingMaxChars(bad), /app_settings\.grounding_max_chars is (missing|invalid)/, String(bad));
  }
});

test("the seeded 30,000 cap: exactly 30,000 passes, 30,001 fails (never truncates)", () => {
  const cap = parseGroundingMaxChars("30000");
  const at = [doc("a", "A", "x".repeat(20_000)), doc("b", "B", "y".repeat(10_000))];
  assert.equal(checkGroundingDocs("L1", at, cap), at);
  assert.throws(
    () => checkGroundingDocs("L1", [...at, doc("c", "C", "z")], cap),
    /total 30001 characters, over the 30000 limit \(app_settings\.grounding_max_chars\)/
  );
  // The cap is whatever the setting says — not a constant.
  assert.throws(() => checkGroundingDocs("L1", at, parseGroundingMaxChars("29999")), /over the 29999 limit/);
});

test("zero linked docs fails legibly, naming the lesson and the option", () => {
  assert.throws(() => checkGroundingDocs("L1", [], 30000), /No source documents linked to lesson L1 .*use_source_documents/);
});

// ---- deterministic order (the shared loader sorts with this) ----
test("order is name, then id, regardless of load order; input not mutated", () => {
  const docs = [doc("2", "Beta"), doc("9", "Alpha"), doc("1", "Beta"), doc("0", "alpha")];
  const expected = ["9", "1", "2", "0"]; // code-point compare: "Alpha" < "Beta" < "alpha"
  assert.deepEqual(sortSourceDocs(docs).map((d) => d.id), expected);
  assert.deepEqual(docs.map((d) => d.id), ["2", "9", "1", "0"]);
  for (const p of [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) {
    assert.deepEqual(sortSourceDocs(p.map((i) => docs[i])).map((d) => d.id), expected);
  }
});

// ---- rendering + provenance ----
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
