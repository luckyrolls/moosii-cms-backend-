// Demo reset (pure half): argument parsing, seed protection, persona scoping, moosies. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, rowsToDelete, isProtectedSeed, moosiesAfterReset, DEMO_PERSONAS, SAM_ORIENTATION_LESSON } from "../reset";

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

test("moosies are recomputed from the completions that remain; no config leaves them alone", () => {
  assert.equal(moosiesAfterReset(1, 10), 10);   // Sam: the seed only
  assert.equal(moosiesAfterReset(0, 10), 0);    // Sarah
  assert.equal(moosiesAfterReset(3, null), null);
});
