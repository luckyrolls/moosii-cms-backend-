// Slice A1: the POST /jobs preconditions — the 409 that stops a content regenerate destroying an
// approved image, and the 400 that retires include_approved.
//
// The DB read is injected, so the refusals are exact rather than "whatever the stub origin does".
// The last two tests drive the REAL router over HTTP, so the wiring (apiError shape, status, and
// "a job with no precondition still gets its 202 attempt") is proven and not just the predicate.
import { stubServer } from "./_stubEnv";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import { checkJobPrecondition, type PreconditionDeps } from "../../lib/jobPreconditions";
import jobs from "../jobs";

const SEG = "11111111-1111-4111-8111-111111111111";
const C1 = "aaaaaaaa-1111-4111-8111-111111111111";
const C2 = "bbbbbbbb-1111-4111-8111-111111111111";

const deps = (ids: string[]): PreconditionDeps => ({ approvedImageCardIds: async () => ids });

// ---------------------------------------------------------------- include_approved

test("generate_track_content with include_approved is a 400 and reads no database", async () => {
  let called = false;
  const r = await checkJobPrecondition(
    "generate_track_content",
    { track_id: "t", tone_id: "x", mode: "replace", include_approved: true },
    { approvedImageCardIds: async () => { called = true; return []; } }
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 400);
  assert.equal(r.code, "include_approved_removed");
  assert.equal(called, false, "the 400 must not need a query");
});

test("generate_track_content without include_approved passes", async () => {
  const r = await checkJobPrecondition("generate_track_content", { track_id: "t", tone_id: "x" }, deps([C1]));
  assert.equal(r.ok, true, "the batch's own plan does the skipping; the route only kills the override");
});

test("include_approved: false is not a refusal", async () => {
  const r = await checkJobPrecondition(
    "generate_track_content",
    { track_id: "t", tone_id: "x", include_approved: false },
    deps([])
  );
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------- the approved-image 409

test("regen whole_segment over an approved image is 409 segment_has_approved_images", async () => {
  const r = await checkJobPrecondition(
    "regen_segment_content",
    { seg_id: SEG, tone_id: "x", scope: "whole_segment" },
    deps([C1, C2])
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 409);
  assert.equal(r.code, "segment_has_approved_images");
  assert.match(r.message, /2 card\(s\)/);
  assert.match(r.message, new RegExp(C1));
});

test("regen whole_segment with no approved image passes", async () => {
  const r = await checkJobPrecondition(
    "regen_segment_content",
    { seg_id: SEG, tone_id: "x", scope: "whole_segment" },
    deps([])
  );
  assert.equal(r.ok, true);
});

test("regen single_card is refused only when THAT card holds the approved image", async () => {
  const blocked = await checkJobPrecondition(
    "regen_segment_content",
    { seg_id: SEG, tone_id: "x", scope: "single_card", card_id: C1 },
    deps([C1, C2])
  );
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, "segment_has_approved_images");

  const allowed = await checkJobPrecondition(
    "regen_segment_content",
    { seg_id: SEG, tone_id: "x", scope: "single_card", card_id: "cccccccc-1111-4111-8111-111111111111" },
    deps([C1, C2])
  );
  assert.equal(allowed.ok, true, "a sibling's approved image is not this card's problem");
});

test("regen with no scope is treated as whole_segment (the destructive default)", async () => {
  const r = await checkJobPrecondition("regen_segment_content", { seg_id: SEG, tone_id: "x" }, deps([C1]));
  assert.equal(r.ok, false, "an absent scope must not be the permissive case");
});

test("generate_segment_content is guarded too — it replaces the whole segment and purges first", async () => {
  const r = await checkJobPrecondition("generate_segment_content", { seg_id: SEG, tone_id: "x" }, deps([C1]));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "segment_has_approved_images");
});

test("generate_segment_content ignores scope/card_id — it is always the whole segment", async () => {
  // A caller cannot narrow this job type's blast radius by passing single_card.
  const r = await checkJobPrecondition(
    "generate_segment_content",
    { seg_id: SEG, tone_id: "x", scope: "single_card", card_id: "zzzzzzzz-1111-4111-8111-111111111111" },
    deps([C1])
  );
  assert.equal(r.ok, false, "generate_segment_content must not honour a narrowing scope");
});

test("a regen with no seg_id is left to the handler's own validation", async () => {
  const r = await checkJobPrecondition("regen_segment_content", { tone_id: "x" }, deps([C1]));
  assert.equal(r.ok, true);
});

test("unrelated job types are never blocked", async () => {
  for (const type of ["generate_sub_segment_image", "generate_track_images", "rebuild_mlp", "review_lesson", "dummy"]) {
    const r = await checkJobPrecondition(type, { seg_id: SEG, include_approved: true }, deps([C1, C2]));
    assert.equal(r.ok, true, `${type} must pass`);
  }
});

// ---------------------------------------------------------------- over real HTTP

const app = express();
app.use(express.json());
app.use("/jobs", jobs);
// Port captured eagerly, exactly as capabilityGates.test.ts does: libuv binds synchronously for
// port 0, and a lazy `address()` read came back null once the suite's `after` had fired.
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); stubServer.close(); });

test("POST /jobs refuses include_approved with the standard error shape", async () => {
  const res = await fetch(`${base}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "generate_track_content", input: { track_id: "t", tone_id: "x", include_approved: true } }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: { code?: string; message?: string } };
  assert.equal(body.error?.code, "include_approved_removed");
  assert.match(body.error?.message ?? "", /Unapprove the segments/);
});

test("POST /jobs still creates a job that has no precondition (it fails at the stub DB, not at the gate)", async () => {
  const res = await fetch(`${base}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "dummy", input: {} }),
  });
  // No database here, so the insert fails and the route 500s. The point is that it got PAST the
  // precondition — a 400/409 would mean the gate had caught something it should not.
  assert.notEqual(res.status, 400);
  assert.notEqual(res.status, 409);
});

test("POST /jobs still requires a type", async () => {
  const res = await fetch(`${base}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: {} }),
  });
  assert.equal(res.status, 400);
});
