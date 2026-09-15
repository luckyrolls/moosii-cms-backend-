// POST /facts body validation (api-contract.md §8). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFactsBody, MAX_FACTS_PER_CALL, type Vocabulary } from "../validate";

const USER = "0b7c5f4e-9a51-4d8e-8a63-2f1d3c4b5a69";
const vocab: Vocabulary = {
  values: new Map([
    ["credit_utilization_band", new Set(["low", "moderate", "high"])],
    ["has_direct_deposit", new Set(["true", "false"])],
  ]),
};
const fact = (over: Record<string, unknown> = {}) => ({
  key: "has_direct_deposit", value: "true", observed_at: "2026-09-15T14:00:00Z", ...over,
});
const body = (facts: unknown[], over: Record<string, unknown> = {}) => ({ user_id: USER, facts, ...over });

function rejects(b: unknown, code: string, pattern: RegExp) {
  const r = validateFactsBody(b, vocab);
  assert.equal(r.ok, false, "expected a rejection");
  if (!r.ok) {
    assert.equal(r.status, 400);
    assert.equal(r.code, code);
    assert.match(r.message, pattern);
  }
}

test("a valid batch normalizes observed_at to UTC and defaults source to platform_api", () => {
  const r = validateFactsBody(body([fact(), fact({ key: "credit_utilization_band", value: "high", observed_at: "2026-09-15T10:00:00-04:00", source: "manual" })]), vocab);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.userId, USER);
    assert.deepEqual(r.rows, [
      { user_id: USER, fact_key: "has_direct_deposit", value: "true", observed_at: "2026-09-15T14:00:00.000Z", source: "platform_api" },
      { user_id: USER, fact_key: "credit_utilization_band", value: "high", observed_at: "2026-09-15T14:00:00.000Z", source: "manual" },
    ]);
  }
});

test("unknown key is rejected, naming the offender", () => {
  rejects(body([fact(), fact({ key: "net_worth_band" })]), "unknown_fact", /facts\[1\]: unknown key "net_worth_band"/);
});

test("unknown value is rejected, naming the key and value", () => {
  rejects(body([fact({ key: "credit_utilization_band", value: "extreme" })]), "unknown_fact", /facts\[0\]: unknown value "extreme" for key "credit_utilization_band"/);
});

test("numeric-looking values are rejected as amounts, before the vocabulary check", () => {
  for (const v of ["1200", "$40", "0.82", " 12", "-5", "+3"]) {
    rejects(body([fact({ key: "credit_utilization_band", value: v })]), "unknown_fact", /looks numeric — .*never an amount/);
  }
});

test("missing observed_at is rejected with its own code", () => {
  for (const missing of [undefined, null, ""]) {
    const f: Record<string, unknown> = fact();
    if (missing === undefined) delete f.observed_at; else f.observed_at = missing;
    rejects(body([f]), "missing_observed_at", /facts\[0\]\.observed_at is required/);
  }
});

test("observed_at must be a full ISO 8601 instant with a zone", () => {
  for (const badTs of ["2026-09-15", "2026-09-15T14:00:00", "yesterday", "2026-13-45T99:00:00Z", 1726408800000]) {
    rejects(body([fact({ observed_at: badTs })]), "invalid_observed_at", /facts\[0\]\.observed_at must be ISO 8601/);
  }
});

test("the FIRST offender is the one named", () => {
  rejects(body([fact(), fact({ value: "maybe" }), fact({ key: "nope" })]), "unknown_fact", /^facts\[1\]/);
});

test("an unknown source is rejected", () => {
  rejects(body([fact({ source: "partner_x" })]), "invalid_source", /facts\[0\]\.source must be one of platform_api \| cms \| manual/);
});

test("the same key twice at the same instant is rejected, even written in different zones", () => {
  rejects(body([fact(), fact({ value: "false", observed_at: "2026-09-15T10:00:00-04:00" })]), "duplicate_fact", /facts\[1\] repeats facts\[0\]/);
});

test("the same key at different instants is fine (history)", () => {
  const r = validateFactsBody(body([fact(), fact({ value: "false", observed_at: "2026-09-16T14:00:00Z" })]), vocab);
  assert.equal(r.ok, true);
});

test("body shape: user_id, facts array, size cap, external_user_id", () => {
  rejects(null, "invalid_request", /JSON object/);
  rejects([], "invalid_request", /JSON object/);
  rejects(body([fact()], { user_id: "not-a-uuid" }), "invalid_request", /user_id is required and must be a uuid/);
  rejects({ facts: [fact()] }, "invalid_request", /user_id is required/);
  rejects(body([]), "invalid_request", /non-empty array/);
  rejects({ user_id: USER, facts: "x" }, "invalid_request", /non-empty array/);
  rejects(body(Array.from({ length: MAX_FACTS_PER_CALL + 1 }, (_, i) => fact({ observed_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }))), "invalid_request", /at most 100 facts/);
  rejects(body([fact()], { external_user_id: "p-1" }), "invalid_request", /external_user_id is not supported/);
});

test("entry shape: object, key, string value", () => {
  rejects(body(["x"]), "invalid_request", /facts\[0\] must be an object/);
  rejects(body([fact({ key: "" })]), "invalid_request", /facts\[0\]\.key is required/);
  rejects(body([fact({ value: true })]), "invalid_request", /facts\[0\]\.value is required and must be a string/);
});
