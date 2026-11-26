// batchUsage / batchEstimate import src/supabase (their loaders), which exits the process when
// SUPABASE_URL is unset — so the env stub must load FIRST. Nothing here contacts a database:
// every function under test is pure and is called with its rows supplied directly.
import "../../routes/__tests__/_stubEnv";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPerLesson,
  attachTokens,
  attachImageCalls,
  tallyPerLesson,
  type LessonRow,
  type PlannedUnit,
  type SkippedUnit,
  type UnitOutcome,
} from "../batchReport";
import { extractUsage, sumUsage, addUsage, ZERO_USAGE } from "../aiUsage";
import { contentTokensByLesson, imageCallsByLesson, runUsageFrom, type LogRow } from "../batchUsage";
import { estimateFor, CALLS_PER_UNIT, type EstimateBasis } from "../batchEstimate";

// ---------------------------------------------------------------------------
// 1. buildPerLesson
// ---------------------------------------------------------------------------

const L = (id: string, over: Partial<LessonRow> = {}): LessonRow => ({
  lesson_id: id,
  lesson_name: `lesson ${id}`,
  kind: "lesson",
  is_published: false,
  archived: false,
  ...over,
});

const p = (kind: PlannedUnit["kind"], ref: string, lesson_id: string | null): PlannedUnit => ({
  kind, ref, lesson_id,
});
const s = (kind: SkippedUnit["kind"], ref: string, lesson_id: string | null, reason: SkippedUnit["reason"]): SkippedUnit => ({
  kind, ref, lesson_id, reason,
});

test("per_lesson: one row per lesson the plan touched, with units split by kind", () => {
  const rows = buildPerLesson({
    lessons: [L("a"), L("b")],
    planned: [p("content", "content:1", "a"), p("quiz", "quiz:1", "a"), p("image", "image:9", "b")],
    skipped: [],
  });
  assert.equal(rows.length, 2);
  const a = rows.find((r) => r.lesson_id === "a")!;
  assert.equal(a.planned, 2);
  assert.deepEqual(a.planned_by_kind, { content: 1, quiz: 1, image: 0 });
  assert.deepEqual(rows.find((r) => r.lesson_id === "b")!.planned_by_kind, { content: 0, quiz: 0, image: 1 });
});

test("per_lesson: a lesson the plan never looked at is ABSENT, not a zero row", () => {
  // A 156-lesson project must not render 156 rows to preview 29 eligible lessons.
  const rows = buildPerLesson({
    lessons: [L("a"), L("b"), L("c")],
    planned: [p("content", "content:1", "a")],
    skipped: [],
  });
  assert.deepEqual(rows.map((r) => r.lesson_id), ["a"]);
});

test("per_lesson: skips are counted per reason, and only the reasons that fired appear", () => {
  const rows = buildPerLesson({
    lessons: [L("a")],
    planned: [],
    skipped: [
      s("content", "content:1", "a", "published"),
      s("quiz", "quiz:1", "a", "published"),
      s("image", "image:1", "a", "published"),
      s("quiz", "quiz:2", "a", "activity"),
    ],
  });
  assert.deepEqual(rows[0].skipped, { published: 3, activity: 1 });
  assert.equal(rows[0].skipped_total, 4);
  assert.equal(rows[0].planned, 0);
});

test("per_lesson: outcomes decide done/failed, and a unit that never ran is neither", () => {
  const outcomes = new Map<string, UnitOutcome>([
    ["content:1", "done"],
    ["content:2", "failed"],
  ]);
  const rows = buildPerLesson({
    lessons: [L("a")],
    planned: [
      p("content", "content:1", "a"),
      p("content", "content:2", "a"),
      p("content", "content:3", "a"),   // killed batch: never started
    ],
    skipped: [],
    outcomes,
    errors: [{ unit: "content:2", message: "boom" }],
  });
  assert.equal(rows[0].planned, 3);
  assert.equal(rows[0].done, 1);
  assert.equal(rows[0].failed, 1);
  assert.deepEqual(rows[0].errors, [{ unit: "content:2", message: "boom" }]);
});

test("per_lesson: units with no lesson land in the orphan row, last", () => {
  const rows = buildPerLesson({
    lessons: [L("a")],
    planned: [p("image", "image:x", null), p("content", "content:1", "a")],
    skipped: [s("image", "image:y", null, "no_content")],
  });
  assert.deepEqual(rows.map((r) => r.lesson_id), ["a", null]);
  const orphan = rows[1];
  assert.equal(orphan.lesson_name, null);
  assert.equal(orphan.planned, 1);
  assert.deepEqual(orphan.skipped, { no_content: 1 });
});

test("per_lesson: published lessons sort first, then by name", () => {
  const rows = buildPerLesson({
    lessons: [L("a", { lesson_name: "Zebra" }), L("b", { lesson_name: "Apple", is_published: true }), L("c", { lesson_name: "Mango" })],
    planned: [p("content", "1", "a"), p("content", "2", "b"), p("content", "3", "c")],
    skipped: [],
  });
  assert.deepEqual(rows.map((r) => r.lesson_name), ["Apple", "Mango", "Zebra"]);
});

test("per_lesson: findings_count is always null (slice B fills it)", () => {
  const rows = buildPerLesson({ lessons: [L("a")], planned: [p("content", "1", "a")], skipped: [] });
  assert.equal(rows[0].findings_count, null);
  assert.equal(rows[0].tokens, null);
  assert.equal(rows[0].image_calls, null);
});

test("attachTokens / attachImageCalls fill the lesson rows, 0 for a lesson with none", () => {
  const rows = buildPerLesson({
    lessons: [L("a"), L("b")],
    planned: [p("content", "1", "a"), p("content", "2", "b"), p("image", "3", null)],
    skipped: [],
  });
  attachTokens(rows, new Map([["a", 2234]]));
  assert.equal(rows.find((r) => r.lesson_id === "a")!.tokens, 2234);
  assert.equal(rows.find((r) => r.lesson_id === "b")!.tokens, 0);
  assert.equal(rows.find((r) => r.lesson_id === null)!.tokens, null);  // orphan stays null

  attachImageCalls(rows, new Map([["b", 4]]));
  assert.equal(rows.find((r) => r.lesson_id === "b")!.image_calls, 4);
});

test("tallyPerLesson: totals reconcile with the rows, every reason present", () => {
  const rows = buildPerLesson({
    lessons: [L("a"), L("b")],
    planned: [p("content", "1", "a"), p("quiz", "2", "a"), p("image", "3", "b")],
    skipped: [s("image", "4", "b", "no_content"), s("content", "5", "a", "approved_images")],
    outcomes: new Map<string, UnitOutcome>([["1", "done"], ["3", "failed"]]),
  });
  const t = tallyPerLesson(rows);
  assert.equal(t.lessons, 2);
  assert.equal(t.planned, 3);
  assert.deepEqual(t.planned_by_kind, { content: 1, quiz: 1, image: 1 });
  assert.equal(t.done, 1);
  assert.equal(t.failed, 1);
  assert.equal(t.skipped_total, 2);
  assert.equal(t.skipped.no_content, 1);
  assert.equal(t.skipped.approved_images, 1);
  assert.equal(t.skipped.published, 0);
});

// ---------------------------------------------------------------------------
// 2. extractUsage — both provider shapes
// ---------------------------------------------------------------------------

test("usage: the OpenAI shape", () => {
  assert.deepEqual(
    extractUsage({ usage: { prompt_tokens: 744, completion_tokens: 373, total_tokens: 1117 } }),
    { tokens_in: 744, tokens_out: 373, tokens_total: 1117 }
  );
});

test("usage: the GEMINI shape — image_generate DOES report tokens", () => {
  // A real row from Moosii's ai_generation_log (gemini-3.1-flash-image). The findings doc's
  // "image models record no usage" is true of the `usage` key only; this is the other shape.
  assert.deepEqual(
    extractUsage({
      usageMetadata: { promptTokenCount: 178, candidatesTokenCount: 1371, totalTokenCount: 1549 },
    }),
    { tokens_in: 178, tokens_out: 1371, tokens_total: 1549 }
  );
});

test("usage: no usage block at all → null, never a zero that looks measured", () => {
  assert.equal(extractUsage(null), null);
  assert.equal(extractUsage({}), null);
  assert.equal(extractUsage({ usage: {} }), null);
  assert.equal(extractUsage("text"), null);
});

test("usage: a missing total is derived from in+out rather than dropped", () => {
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
    tokens_in: 10, tokens_out: 5, tokens_total: 15,
  });
});

test("usage: numeric strings are accepted (jsonb round-trips)", () => {
  assert.deepEqual(extractUsage({ usage: { total_tokens: "1117" } }), {
    tokens_in: 0, tokens_out: 0, tokens_total: 1117,
  });
});

test("usage: sum/add ignore the rows that reported nothing", () => {
  assert.deepEqual(addUsage(ZERO_USAGE, null), ZERO_USAGE);
  assert.deepEqual(
    sumUsage([{ usage: { total_tokens: 100 } }, {}, { usageMetadata: { totalTokenCount: 50 } }]),
    { tokens_in: 0, tokens_out: 0, tokens_total: 150 }
  );
});

// ---------------------------------------------------------------------------
// 3. Attribution of a run's calls to lessons
// ---------------------------------------------------------------------------

const log = (over: Partial<LogRow>): LogRow => ({
  operation: "segment_content",
  related_entity_type: "segment",
  related_entity_id: "seg1",
  response: { usage: { prompt_tokens: 700, completion_tokens: 300, total_tokens: 1000 } },
  ...over,
});

test("content attribution: segment rows map to their lesson through the plan", () => {
  const { byLesson, usage } = contentTokensByLesson(
    [log({}), log({ related_entity_id: "seg2", operation: "quiz" })],
    new Map([["seg1", "lessonA"], ["seg2", "lessonA"]])
  );
  assert.equal(byLesson.get("lessonA"), 2000);
  assert.equal(usage.ai_calls, 2);
  assert.equal(usage.tokens_total, 2000);
  assert.equal(usage.unattributed_calls, 0);
});

test("content attribution: a row with no mappable entity counts as unattributed, not lost", () => {
  const { byLesson, usage } = contentTokensByLesson(
    [log({}), log({ related_entity_type: null, related_entity_id: null })],
    new Map([["seg1", "lessonA"]])
  );
  assert.equal(byLesson.get("lessonA"), 1000);
  assert.equal(usage.ai_calls, 2);
  assert.equal(usage.tokens_total, 2000);          // the run total still counts it
  assert.equal(usage.unattributed_calls, 1);
});

test("content attribution: a sub_segment-scoped row maps through cardToLesson when given", () => {
  const rows = [log({ related_entity_type: "sub_segment", related_entity_id: "card1" })];
  assert.equal(contentTokensByLesson(rows, new Map()).usage.unattributed_calls, 1);
  const { byLesson } = contentTokensByLesson(rows, new Map(), new Map([["card1", "lessonB"]]));
  assert.equal(byLesson.get("lessonB"), 1000);
});

test("image attribution: two calls per slot, counted from the image_generate row", () => {
  // generateSubSegmentImage makes exactly image_prompt_generate + image_generate per slot;
  // only the second records an entity, so the first shows up as unattributed.
  const rows = [
    log({ operation: "image_prompt_generate", related_entity_type: null, related_entity_id: null }),
    log({
      operation: "image_generate",
      related_entity_type: "content_image",
      related_entity_id: "img1",
      response: { usageMetadata: { totalTokenCount: 1549 } },
    }),
  ];
  const { byLesson, usage } = imageCallsByLesson(rows, new Map([["img1", "lessonA"]]));
  assert.equal(byLesson.get("lessonA"), 2);
  assert.equal(usage.ai_calls, 2);
  assert.equal(usage.unattributed_calls, 1);
  assert.equal(usage.tokens_total, 1000 + 1549);   // BOTH halves count in the run total
});

test("runUsageFrom: a run with no log rows is all zeros, not a crash", () => {
  assert.deepEqual(runUsageFrom([], () => true), {
    ai_calls: 0, tokens_in: 0, tokens_out: 0, tokens_total: 0, unattributed_calls: 0,
  });
});

// ---------------------------------------------------------------------------
// 4. Estimates
// ---------------------------------------------------------------------------

const basis: EstimateBasis = {
  window_days: 90,
  window_from: "2026-08-27T00:00:00.000Z",
  operations: {
    segment_content: { operation: "segment_content", calls: 13, avg_tokens_in: 1177, avg_tokens_out: 359, avg_tokens_total: 1536, window: "window" },
    segment_content_regen: { operation: "segment_content_regen", calls: 3, avg_tokens_in: 1245, avg_tokens_out: 182, avg_tokens_total: 1427, window: "window" },
    quiz: { operation: "quiz", calls: 11, avg_tokens_in: 873, avg_tokens_out: 375, avg_tokens_total: 1247, window: "window" },
    image_prompt_generate: { operation: "image_prompt_generate", calls: 43, avg_tokens_in: 1710, avg_tokens_out: 193, avg_tokens_total: 1903, window: "window" },
    image_generate: { operation: "image_generate", calls: 40, avg_tokens_in: 170, avg_tokens_out: 1380, avg_tokens_total: 1550, window: "window" },
  },
  cards_per_segment: { segments: 78, avg: 7.47, min: 4, max: 10 },
  notes: [],
};

test("estimate: calls per unit are a property of the code path, not a measurement", () => {
  assert.deepEqual(CALLS_PER_UNIT, { content: 1, quiz: 1, image: 2 });
  const e = estimateFor({ content: 3, quiz: 2, image: 5 }, basis);
  assert.equal(e.ai_calls, 3 * 1 + 2 * 1 + 5 * 2);
});

test("estimate: tokens are the measured averages multiplied out", () => {
  const e = estimateFor({ content: 2, quiz: 1, image: 1 }, basis);
  assert.equal(e.by_unit.content.tokens_total, 2 * 1536);
  assert.equal(e.by_unit.quiz.tokens_total, 1247);
  assert.equal(e.by_unit.image.tokens_total, 1903 + 1550);   // both calls of the slot
  assert.equal(e.tokens_total, 2 * 1536 + 1247 + 1903 + 1550);
});

test("estimate: the image slots CONTENT will create are quoted as a band, not a promise", () => {
  const e = estimateFor({ content: 4, quiz: 0, image: 0 }, basis);
  assert.deepEqual(e.image_slots_content_will_create, {
    expected: Math.round(4 * 7.47), low: 16, high: 40,
  });
  // and they are NOT folded into this run's calls — they do not exist yet
  assert.equal(e.ai_calls, 4);
});

test("estimate: no content planned → no created-slot band", () => {
  assert.equal(estimateFor({ content: 0, quiz: 0, image: 3 }, basis).image_slots_content_will_create, null);
});

test("estimate: a missing measured average contributes 0 rather than NaN", () => {
  const thin: EstimateBasis = { ...basis, operations: {}, cards_per_segment: null };
  const e = estimateFor({ content: 2, quiz: 2, image: 2 }, thin);
  assert.equal(e.tokens_total, 0);
  assert.equal(e.ai_calls, 8);                 // 2 content + 2 quiz + 2x2 image, known exactly
  assert.equal(e.image_slots_content_will_create, null);
});
