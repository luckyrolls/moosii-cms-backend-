// generate_track_content: content units opt in to the activity rule (activities get activity_v1, lessons their tone
// default), exactly like the generate_segment_content job. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planStructure } from "../../../lib/structureChoice";

// The handler module imports the shared Supabase client, which exits without credentials. Every dependency here is a
// fake, so placeholders suffice — nothing connects.
process.env.SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-placeholder-key";

test("a content unit generates with the activity rule on, then recomputes; a quiz unit only regenerates the quiz", async () => {
  const { makeRunUnit, TRACK_CONTENT_GENERATE_OPTS } = await import("../generateTrackContent");
  const calls: unknown[] = [];
  const runUnit = makeRunUnit({
    generate: (async (input: unknown, opts: unknown) => { calls.push(["generate", input, opts]); return {}; }) as never,
    recompute: (async (seg: string) => { calls.push(["recompute", seg]); }) as never,
    quiz: (async (input: unknown) => { calls.push(["quiz", input]); return {}; }) as never,
  });
  await runUnit({ type: "content", seg_id: "seg-1", ref: "L1" }, "tone-1", "corr-1");
  await runUnit({ type: "quiz", seg_id: "seg-2", ref: "L2" }, "tone-1", "corr-1");
  assert.deepEqual(calls, [
    ["generate", { seg_id: "seg-1", tone_id: "tone-1", generate_quiz: false, correlationId: "corr-1" }, { activityStructure: true }],
    ["recompute", "seg-1"],
    ["quiz", { seg_id: "seg-2", correlationId: "corr-1", isRegen: true }],
  ]);
  assert.deepEqual(TRACK_CONTENT_GENERATE_OPTS, { activityStructure: true });
});

test("with the batch's options, an activity plans activity_v1 and a lesson keeps its tone default (unchanged)", async () => {
  const { TRACK_CONTENT_GENERATE_OPTS } = await import("../generateTrackContent");
  const rule = TRACK_CONTENT_GENERATE_OPTS.activityStructure === true;
  assert.deepEqual(planStructure({ kind: "activity", toneBlockId: "tone-structure", activityRule: rule }), { source: "activity" });
  assert.deepEqual(planStructure({ kind: "lesson", toneBlockId: "tone-structure", activityRule: rule }),
    { source: "block", blockId: "tone-structure", reason: "tone_default" });
});
