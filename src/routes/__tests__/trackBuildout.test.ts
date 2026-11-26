// Slice A2 — the plan-preview route's input handling, and the per-lesson report the two
// executors write into jobs.result. No database: _stubEnv points the Supabase client at a
// socket that answers 503 instantly, so every query fails cleanly and nothing real is touched.
// The assembly logic itself is covered pure in src/lib/__tests__/batchReport.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "./_stubEnv";
import express from "express";
import { parsePreviewQuery } from "../trackBuildout";

type Json = { status: number; json: any };

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const { trackBuildoutRouter } = await import("../trackBuildout");
  const app = express();
  app.use(express.json());
  // The admin gate is jwtAuthMiddleware's job and is covered by capabilityGates.test.ts; what
  // is under test here is the ROUTE's own parsing.
  app.use((req, _res, next) => {
    (req as any).user = { id: "11111111-1111-4111-8111-111111111111", role: "admin" };
    next();
  });
  app.use("/tracks", trackBuildoutRouter);

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const get = async (base: string, path: string): Promise<Json> => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, json: await res.json().catch(() => null) };
};

const TRACK = "2076eb8c-4d5b-4b52-86c9-6b22ecc47192";

// ── parsing (pure: no round trip, so the whole matrix is cheap) ─────────────────────────

test("preview query: mode accepts the two batch modes and nothing else", () => {
  for (const mode of ["fill_missing", "replace"]) {
    const r = parsePreviewQuery({ mode });
    assert.equal(r.ok && r.query.mode, mode);
  }
  assert.equal(parsePreviewQuery({}).ok && parsePreviewQuery({}).query.mode, "fill_missing");
  for (const bad of ["replace_all", "REPLACE", "fill", "1"]) {
    const r = parsePreviewQuery({ mode: bad });
    assert.deepEqual(r.ok, false);
    if (!r.ok) assert.equal(r.code, "bad_mode");
  }
});

test("preview query: the two booleans accept true/false/1/0 and refuse anything else", () => {
  for (const key of ["quizzes", "only_editorially_approved"] as const) {
    for (const [v, want] of [["true", true], ["1", true], ["false", false], ["0", false]] as const) {
      const r = parsePreviewQuery({ [key]: v });
      assert.equal(r.ok && r.query[key], want, `${key}=${v}`);
    }
    for (const bad of ["yes", "2", "maybe", "TRUE"]) {
      const r = parsePreviewQuery({ [key]: bad });
      assert.deepEqual(r.ok, false, `${key}=${bad}`);
      if (!r.ok) assert.equal(r.code, "bad_request");
    }
    // absent means false — the default for both (images do NOT require editorial approval)
    assert.equal(parsePreviewQuery({}).ok && parsePreviewQuery({}).query[key], false);
  }
});

test("preview query: window_days is bounded, and defaults to 90 days", () => {
  assert.equal(parsePreviewQuery({}).ok && parsePreviewQuery({}).query.window_days, 90);
  assert.equal(parsePreviewQuery({ window_days: "30" }).ok && parsePreviewQuery({ window_days: "30" }).query.window_days, 30);
  // "" is Number("") === 0, i.e. out of range — refused rather than silently defaulted.
  for (const bad of ["0", "-5", "4000", "abc", ""]) {
    assert.deepEqual(parsePreviewQuery({ window_days: bad }).ok, false, JSON.stringify(bad));
  }
});

// ── the route itself: one refusal, one pass-through (each DB-less call costs ~7s) ─────────

test("preview: a bad query is 400 before any query runs", async () => {
  await withServer(async (base) => {
    const r = await get(base, `/tracks/${TRACK}/plan-preview?mode=replace_all`);
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, "bad_mode");
  });
});

test("preview: a valid query reaches the planners, and a dead database is a clean error", async () => {
  await withServer(async (base) => {
    const r = await get(base, `/tracks/${TRACK}/plan-preview?mode=replace&quizzes=true`);
    assert.notEqual(r.status, 400);
    assert.equal(r.status, 500);
    assert.match(r.json.error.code, /plan_failed|db_error/);
    assert.equal(r.json.per_lesson, undefined);   // never a half-answer
  });
});

// ---------------------------------------------------------------------------
// The executors' per-lesson report, driven with an injected runUnit (no LLM, no images).
// jobs.result writes go to the 503 stub and are ignored, exactly as the progress writer
// already tolerates; what is asserted is the RETURNED result.
// ---------------------------------------------------------------------------

test("content run: per_lesson carries planned/done/failed and the errors, per lesson", async () => {
  const { executeTrackContent } = await import("../../jobs/handlers/generateTrackContent");
  const planned = {
    plan: [
      { type: "content" as const, seg_id: "s1", ref: "content:s1", lesson_id: "L1" },
      { type: "quiz" as const, seg_id: "s1", ref: "quiz:s1", lesson_id: "L1" },
      { type: "content" as const, seg_id: "s2", ref: "content:s2", lesson_id: "L2" },
    ],
    skipped_approved: 1,
    skipped_by_reason: {
      published: 0, archived: 0, approved_images: 1, approved_content: 0,
      resume: 0, no_content: 0, activity: 1, not_editorially_approved: 0,
    },
    lessons: [
      { lesson_id: "L1", lesson_name: "One", kind: "lesson" as const, is_published: false, archived: false },
      { lesson_id: "L2", lesson_name: "Two", kind: "lesson" as const, is_published: false, archived: false },
      { lesson_id: "L3", lesson_name: "An activity", kind: "activity" as const, is_published: false, archived: false },
    ],
    skipped: [
      { kind: "content" as const, ref: "content:s9", lesson_id: "L3", reason: "approved_images" as const },
      { kind: "quiz" as const, ref: "quiz:s9", lesson_id: "L3", reason: "activity" as const },
    ],
  };

  const result = await executeTrackContent("job-1", planned, "tone-1", async (unit) => {
    if (unit.ref === "content:s2") throw new Error("model said no");
  });

  assert.equal(result.total, 3);
  assert.equal(result.done, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.status, "completed_with_errors");

  const byId = new Map(result.per_lesson.map((r) => [r.lesson_id, r]));
  assert.deepEqual(byId.get("L1")!.planned_by_kind, { content: 1, quiz: 1, image: 0 });
  assert.equal(byId.get("L1")!.done, 2);
  assert.equal(byId.get("L1")!.failed, 0);
  assert.equal(byId.get("L2")!.failed, 1);
  assert.deepEqual(byId.get("L2")!.errors, [{ unit: "content:s2", message: "model said no" }]);
  // The refused lesson is reported WITH its reasons, not merely absent.
  assert.deepEqual(byId.get("L3")!.skipped, { approved_images: 1, activity: 1 });
  assert.equal(byId.get("L3")!.planned, 0);
  // findings_count is slice B's field and stays null; tokens resolve to 0 with no log reachable.
  assert.equal(byId.get("L1")!.findings_count, null);
  assert.equal(byId.get("L1")!.tokens, 0);
  // The pre-A2 fields are untouched (backwards compatible).
  assert.equal(result.skipped_approved, 1);
  assert.equal(result.skipped_by_reason.activity, 1);
  assert.equal(result.current_unit, null);
});

test("image run: per_lesson reports image_calls, and tokens stay null on this batch", async () => {
  const { executeTrackImages } = await import("../../jobs/handlers/generateTrackImages");
  const planned = {
    plan: [
      { sub_segment_id: "c1", ref: "image:c1", lesson_id: "L1" },
      { sub_segment_id: "c2", ref: "image:c2", lesson_id: "L1" },
    ],
    skipped_no_content: 1,
    skipped_by_reason: {
      published: 0, archived: 0, approved_images: 0, approved_content: 0,
      resume: 0, no_content: 1, activity: 0, not_editorially_approved: 2,
    },
    lessons: [
      { lesson_id: "L1", lesson_name: "One", kind: "lesson" as const, is_published: false, archived: false },
      { lesson_id: "L2", lesson_name: "Two", kind: "lesson" as const, is_published: false, archived: false },
    ],
    skipped: [
      { kind: "image" as const, ref: "image:c3", lesson_id: "L1", reason: "no_content" as const },
      { kind: "image" as const, ref: "image:c4", lesson_id: "L2", reason: "not_editorially_approved" as const },
      { kind: "image" as const, ref: "image:c5", lesson_id: "L2", reason: "not_editorially_approved" as const },
    ],
    editorial: { lessons_eligible: 2, lessons_without_editorial_approval: 1 },
  };

  const result = await executeTrackImages("job-2", planned, async () => {});

  assert.equal(result.total, 2);
  assert.equal(result.done, 2);
  assert.equal(result.status, "succeeded");
  const byId = new Map(result.per_lesson.map((r) => [r.lesson_id, r]));
  assert.deepEqual(byId.get("L1")!.planned_by_kind, { content: 0, quiz: 0, image: 2 });
  assert.deepEqual(byId.get("L2")!.skipped, { not_editorially_approved: 2 });
  // No log reachable -> 0 calls attributed; tokens stay null because the prompt-writer call
  // logs no entity, so per-lesson tokens would never be honest on this batch.
  assert.equal(byId.get("L1")!.image_calls, 0);
  assert.equal(byId.get("L1")!.tokens, null);
  // Pre-A2 fields unchanged.
  assert.equal(result.skipped_no_content, 1);
  assert.equal(result.skipped_by_reason.not_editorially_approved, 2);
});

test("image handler: only_editorially_approved must be a boolean", async () => {
  const { generateTrackImagesHandler } = await import("../../jobs/handlers/generateTrackImages");
  await assert.rejects(
    () =>
      generateTrackImagesHandler({
        id: "job-3",
        input: { track_id: TRACK, only_editorially_approved: "yes" },
        created_at: new Date().toISOString(),
      } as never),
    /only_editorially_approved must be a boolean/
  );
});
