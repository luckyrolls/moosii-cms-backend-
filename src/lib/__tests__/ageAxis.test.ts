// Tests for the coverage-audit age span (src/lib/ageAxis.ts). Run: `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { domainHasAgeAxis, resolveCoverageAgeSpan } from "../ageAxis";

test("moosii has an age axis; financial does not", () => {
  assert.equal(domainHasAgeAxis("moosii"), true);
  assert.equal(domainHasAgeAxis("financial"), false);
});

test("no age axis → no span, even with no lessons and nothing supplied (the financial failure)", () => {
  const r = resolveCoverageAgeSpan({ hasAgeAxis: false, suppliedMin: undefined, suppliedMax: undefined, existingMins: [], existingMaxs: [] });
  assert.deepEqual(r, { kind: "none" });
});

test("no age axis → a supplied span is IGNORED (the CMS sends 0–1200 for a hidden field)", () => {
  const r = resolveCoverageAgeSpan({ hasAgeAxis: false, suppliedMin: 0, suppliedMax: 1200, existingMins: [3], existingMaxs: [12] });
  assert.deepEqual(r, { kind: "none" });
});

test("age axis: a supplied span wins over existing lessons (operator override, unchanged)", () => {
  const r = resolveCoverageAgeSpan({ hasAgeAxis: true, suppliedMin: 0, suppliedMax: 6, existingMins: [3, 12], existingMaxs: [24, 36] });
  assert.deepEqual(r, { kind: "span", min: 0, max: 6, source: "input" });
});

test("age axis: nothing supplied → derived from existing lessons (min of mins, max of maxes)", () => {
  const r = resolveCoverageAgeSpan({ hasAgeAxis: true, suppliedMin: undefined, suppliedMax: undefined, existingMins: [3, 12], existingMaxs: [24, 36] });
  assert.deepEqual(r, { kind: "span", min: 3, max: 36, source: "existing_lessons" });
});

test("age axis: only half a span supplied → derived, not half-used (unchanged)", () => {
  const r = resolveCoverageAgeSpan({ hasAgeAxis: true, suppliedMin: 0, suppliedMax: undefined, existingMins: [3], existingMaxs: [9] });
  assert.deepEqual(r, { kind: "span", min: 3, max: 9, source: "existing_lessons" });
});

test("age axis: zero-lesson track and nothing supplied → the same error as before, word for word", () => {
  const r = resolveCoverageAgeSpan({ hasAgeAxis: true, suppliedMin: undefined, suppliedMax: undefined, existingMins: [], existingMaxs: [] });
  assert.equal(r.kind, "error");
  if (r.kind === "error") {
    assert.equal(r.message, "No age span available: the track has no existing lessons with age bounds — supply min_child_age and max_child_age in the job input.");
  }
});

test("age axis: a non-number span (e.g. a string from a form) is not treated as supplied", () => {
  const r = resolveCoverageAgeSpan({ hasAgeAxis: true, suppliedMin: "0", suppliedMax: "12", existingMins: [], existingMaxs: [] });
  assert.equal(r.kind, "error");
});
