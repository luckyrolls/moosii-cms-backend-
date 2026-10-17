// Demo reset (pure half): argument parsing, seed protection, persona scoping, moosies (ledger, migration 111). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, rowsToDelete, isProtectedSeed, moosiesAfterReset, DEMO_PERSONAS, RESET_TABLES, SAM_ORIENTATION_LESSON } from "../reset";

const SAM = DEMO_PERSONAS.sam;
const SARAH = DEMO_PERSONAS.sarah;
const OTHER = "00000000-0000-4000-8000-000000000001";
const LESSON = "11111111-1111-4111-8111-111111111111";

test("dry run by default; only lowercase --go applies; anything else is refused", () => {
  assert.deepEqual(parseArgs([]), { go: false });
  assert.deepEqual(parseArgs(["--go"]), { go: true });
  for (const bad of [["--GO"], ["--Go"], ["go"], ["--go", "--force"], ["--dry-run"]]) {
    assert.ok("error" in parseArgs(bad), JSON.stringify(bad));
  }
});

test("Sam's orientation seed is kept in completed_items and user_lesson_progress; nothing else is protected", () => {
  assert.ok(isProtectedSeed("completed_items", { id: 1, user_id: SAM, item_type: "lesson", item_id: SAM_ORIENTATION_LESSON, lesson_id: SAM_ORIENTATION_LESSON }));
  assert.ok(isProtectedSeed("user_lesson_progress", { id: "a", user_id: SAM, lesson_id: SAM_ORIENTATION_LESSON }));
  assert.ok(!isProtectedSeed("user_lesson_progress", { id: "b", user_id: SARAH, lesson_id: SAM_ORIENTATION_LESSON }));
  assert.ok(!isProtectedSeed("completed_items", { id: 2, user_id: SAM, item_type: "questionnaire", item_id: SAM_ORIENTATION_LESSON, lesson_id: null }));
  assert.ok(!isProtectedSeed("user_tracks", { id: 3, user_id: SAM }));
});

test("rowsToDelete: every persona row except the seed, and never another user's row", () => {
  const rows = [
    { id: 1, user_id: SAM, item_type: "lesson", item_id: SAM_ORIENTATION_LESSON, lesson_id: SAM_ORIENTATION_LESSON },
    { id: 2, user_id: SAM, item_type: "lesson", item_id: LESSON, lesson_id: LESSON },
    { id: 3, user_id: SARAH, item_type: "lesson", item_id: LESSON, lesson_id: LESSON },
    { id: 4, user_id: OTHER, item_type: "lesson", item_id: LESSON, lesson_id: LESSON },
  ];
  assert.deepEqual(rowsToDelete("completed_items", rows).map((r) => r.id), [2, 3]);
});

test("moosie_awards: the award Sam's protected seed completion paid is kept; every other persona award goes", () => {
  const seedIds = new Set(["101"]);
  const rows = [
    { id: "a1", user_id: SAM, reason: "completion", source_id: "101", amount: 5 },   // the seed completion's award
    { id: "a2", user_id: SAM, reason: "completion", source_id: "102", amount: 5 },
    { id: "a3", user_id: SARAH, reason: "completion", source_id: "101", amount: 5 }, // same source id, other persona
    { id: "a4", user_id: OTHER, reason: "completion", source_id: "103", amount: 5 }, // never another user's row
  ];
  assert.deepEqual(rowsToDelete("moosie_awards", rows, seedIds).map((r) => r.id), ["a2", "a3"]);
  assert.deepEqual(rowsToDelete("moosie_awards", rows).map((r) => r.id), ["a1", "a2", "a3"]);  // no seed ids → nothing kept
  assert.ok(!isProtectedSeed("moosie_awards", { id: "a5", user_id: SAM, reason: "activity_did_it", source_id: "101" }, seedIds));
});

test("RESET_TABLES clears moosie_awards, after completed_items (the seed's completion id is learned there first)", () => {
  assert.ok(RESET_TABLES.includes("moosie_awards"));
  assert.ok(RESET_TABLES.indexOf("completed_items") < RESET_TABLES.indexOf("moosie_awards"));
});

test("moosies after a reset = the sum of the awards that remain", () => {
  assert.equal(moosiesAfterReset([5]), 5);     // Sam: the seed's award only
  assert.equal(moosiesAfterReset([]), 0);      // Sarah
  assert.equal(moosiesAfterReset([5, 0, 7]), 12);
});

test("RESET_TABLES clears user_activity_followups (no protected seed rows)", () => {
  assert.ok(RESET_TABLES.includes("user_activity_followups"));
  assert.ok(!isProtectedSeed("user_activity_followups", { id: "f1", user_id: SAM }));
  assert.deepEqual(rowsToDelete("user_activity_followups", [{ id: "f1", user_id: SAM }, { id: "f2", user_id: SARAH }, { id: "f3", user_id: OTHER }]).map((r) => r.id), ["f1", "f2"]);
});
