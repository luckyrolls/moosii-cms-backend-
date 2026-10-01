// Context lines for segment-content prompts (src/lib/contentContext.ts). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentContextLines, kindLine } from "../contentContext";

const base = { lessonTitle: "Set a Statement-Date Reminder", segmentName: "Set a Statement-Date Reminder", segmentDescription: "Why and how." };

test("never shows the internal word 'segment' as a label", () => {
  for (const kind of ["lesson", "activity", null, undefined]) {
    const lines = contentContextLines({ ...base, kind });
    for (const l of lines) assert.doesNotMatch(l, /^(Sub-)?segment\s*:/i, l);
  }
});

test("says activity vs lesson from lessons.kind (default lesson)", () => {
  assert.match(contentContextLines({ ...base, kind: "activity" }).join("\n"), /This is an activity: the reader will DO it/);
  assert.match(contentContextLines({ ...base, kind: "lesson" }).join("\n"), /^This is a lesson\./m);
  assert.match(contentContextLines({ ...base, kind: null }).join("\n"), /^This is a lesson\./m);
  assert.equal(kindLine("bogus"), kindLine("lesson"));
});

test("the segment's name is shown only when it differs from the lesson title, labeled 'Lesson part'", () => {
  assert.ok(!contentContextLines({ ...base }).some((l) => l.startsWith("Lesson part:")));
  const lines = contentContextLines({ ...base, segmentName: "Week one" });
  assert.ok(lines.includes("Lesson part: Week one"));
});

test("keeps title, age line and description in order", () => {
  const lines = contentContextLines({ ...base, ageLine: "Child age range: 0–3 months", kind: "lesson" });
  assert.deepEqual(lines, [
    "Lesson title: Set a Statement-Date Reminder",
    "Child age range: 0–3 months",
    'This is a lesson. Refer to it as "this lesson", never as a segment.',
    "Description: Why and how.",
  ]);
});
