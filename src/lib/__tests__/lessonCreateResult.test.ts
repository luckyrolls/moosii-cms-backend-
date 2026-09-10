// Tests for the create_lessons_with_segments result reader (migration 062).
// Run: `npm test`.
//
// The case that matters most is the LAST one: rows with NO `created` field, which is what
// the pre-062 RPC returns. This code ships before the migration is applied, so getting that
// wrong would silently report "0 lessons created" for every ideation run in the meantime.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCreatedRow,
  summarizeLessonCreate,
  type LessonCreateRow,
} from "../lessonCreateResult";

const row = (id: string, created?: boolean): LessonCreateRow => ({
  id,
  lesson_name: `lesson ${id}`,
  description: null,
  ...(created === undefined ? {} : { created }),
});

test("all newly created", () => {
  const s = summarizeLessonCreate([row("a", true), row("b", true)]);
  assert.equal(s.createdCount, 2);
  assert.equal(s.reusedCount, 0);
  assert.deepEqual(s.ids, ["a", "b"]);
});

test("all reused — ids are still returned, so no caller is left without a reference", () => {
  const s = summarizeLessonCreate([row("a", false), row("b", false)]);
  assert.equal(s.createdCount, 0);
  assert.equal(s.reusedCount, 2);
  assert.deepEqual(s.ids, ["a", "b"], "reused rows must still contribute their id");
  assert.deepEqual(s.reused.map((r) => r.id), ["a", "b"]);
});

test("mixed batch splits correctly", () => {
  const s = summarizeLessonCreate([row("a", true), row("b", false), row("c", true)]);
  assert.equal(s.createdCount, 2);
  assert.equal(s.reusedCount, 1);
  assert.deepEqual(s.created.map((r) => r.id), ["a", "c"]);
  assert.deepEqual(s.reused.map((r) => r.id), ["b"]);
  assert.deepEqual(s.ids, ["a", "b", "c"]);
});

test("PRE-062 RPC: rows with no `created` field count as created", () => {
  const s = summarizeLessonCreate([row("a"), row("b")]);
  assert.equal(s.createdCount, 2, "a missing flag must not read as reused");
  assert.equal(s.reusedCount, 0);
});

test("mixed old/new shapes in one array still add up", () => {
  const s = summarizeLessonCreate([row("a"), row("b", false), row("c", true)]);
  assert.equal(s.createdCount, 2);
  assert.equal(s.reusedCount, 1);
  assert.equal(s.createdCount + s.reusedCount, s.rows.length);
});

test("null / undefined / empty are all empty summaries, not throws", () => {
  for (const input of [null, undefined, []] as const) {
    const s = summarizeLessonCreate(input);
    assert.equal(s.createdCount, 0);
    assert.equal(s.reusedCount, 0);
    assert.deepEqual(s.ids, []);
  }
});

test("isCreatedRow: only an explicit false means reused", () => {
  assert.equal(isCreatedRow(row("a", true)), true);
  assert.equal(isCreatedRow(row("a")), true);
  assert.equal(isCreatedRow(row("a", false)), false);
});
