// Tests for the atomic lesson publish/unpublish helpers (migration 068).
// Run: `npm test`.
//
// The two cases that matter most are the ones that caused the incident this fixes:
//   * a MISSING actor must be refused, not silently skipped (the old logApproval path
//     returned early with a warning, so the flip happened with no audit row and a 200);
//   * the missing-RPC detection must be NARROW, because it decides when to fall back to
//     the non-atomic path. Too broad, and a genuine failure silently downgrades.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMissingFunctionError,
  interpretPublishResult,
  resolvePublishActor,
} from "../lessonPublish";

test("missing-function detection: the two codes that mean 'not applied yet'", () => {
  assert.equal(isMissingFunctionError({ code: "PGRST202", message: "..." }), true);
  assert.equal(isMissingFunctionError({ code: "42883", message: "..." }), true);
});

test("missing-function detection: message forms, when no code is supplied", () => {
  assert.equal(
    isMissingFunctionError({ message: "Could not find the function public.set_lesson_published" }),
    true
  );
  assert.equal(
    isMissingFunctionError({ message: 'function set_lesson_published(uuid) does not exist' }),
    true
  );
});

test("missing-function detection is NARROW — real failures must NOT fall back", () => {
  // These are genuine errors. Treating any of them as "not applied yet" would silently
  // downgrade to the non-atomic path and reintroduce the audit gap.
  assert.equal(isMissingFunctionError({ code: "23514", message: "check constraint violated" }), false);
  assert.equal(isMissingFunctionError({ code: "22004", message: "an actor is required" }), false);
  assert.equal(isMissingFunctionError({ code: "42501", message: "permission denied for function" }), false);
  assert.equal(isMissingFunctionError({ code: "PGRST301", message: "JWT expired" }), false);
  assert.equal(isMissingFunctionError(null), false);
  assert.equal(isMissingFunctionError(undefined), false);
});

test("result: a found publish/unpublish is reported with its state", () => {
  assert.deepEqual(interpretPublishResult({ found: true, is_published: true }), {
    found: true,
    isPublished: true,
  });
  assert.deepEqual(interpretPublishResult({ found: true, is_published: false }), {
    found: true,
    isPublished: false,
  });
});

test("result: unknown lesson is not-found", () => {
  assert.deepEqual(interpretPublishResult({ found: false }), { found: false });
});

test("result: a malformed payload is NOT-FOUND, never a guessed success", () => {
  for (const bad of [null, undefined, "ok", 42, {}, { found: true }, { found: "yes", is_published: true }, { found: true, is_published: "true" }]) {
    assert.deepEqual(
      interpretPublishResult(bad),
      { found: false },
      `expected not-found for ${JSON.stringify(bad)}`
    );
  }
});

test("actor: resolved from the verified user, role may be null", () => {
  assert.deepEqual(resolvePublishActor({ id: "u1", role: "super_admin" }), {
    id: "u1",
    role: "super_admin",
  });
  assert.deepEqual(resolvePublishActor({ id: "u1" }), { id: "u1", role: null });
  assert.deepEqual(resolvePublishActor({ id: "u1", role: null }), { id: "u1", role: null });
});

test("actor: NO actor is refused — the case that produced an unaudited publish", () => {
  assert.equal(resolvePublishActor(undefined), null);
  assert.equal(resolvePublishActor({}), null);
  assert.equal(resolvePublishActor({ id: null, role: "super_admin" }), null);
  assert.equal(resolvePublishActor({ id: "", role: "super_admin" }), null);
});
