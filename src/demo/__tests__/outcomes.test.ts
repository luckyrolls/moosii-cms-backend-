// GET /demo/outcomes core: refusal paths in gate order, and real/seeded tagging (api-contract §9b). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDemoOutcomes, mergePoints, factProvenance, type OutcomesDeps, type FactRow, type SeriesRow } from "../outcomes";

const CODE = "correct-horse-battery-staple";
const SAM = "19587e0a-bfe0-48e2-94a1-055a5bbc9584";
const SARAH = "ad6910ab-854b-480b-8fbb-df78ac9147d3";

const FACTS: FactRow[] = [
  { user_id: SAM, fact_key: "credit_utilization_band", value: "high", observed_at: "2026-09-28T14:49:18Z", source: "estimated" },
  { user_id: SAM, fact_key: "has_direct_deposit", value: "true", observed_at: "2026-09-28T14:49:18Z", source: "derived" },
  { user_id: SARAH, fact_key: "has_emergency_buffer", value: "false", observed_at: "2026-09-28T21:15:37Z", source: "seed" },
];
const SERIES: SeriesRow[] = [
  { user_id: SAM, fact_key: "credit_utilization_band", value: "moderate", observed_at: "2026-11-12T12:00:00Z", label: "six weeks later (projected, seeded)" },
  { user_id: SARAH, fact_key: "has_emergency_buffer", value: "true", observed_at: "2026-10-22T12:00:00Z", label: "in three weeks (projected, seeded)" },
  { user_id: SARAH, fact_key: "has_emergency_buffer", value: "false", observed_at: "2026-09-01T12:00:00Z", label: "a month ago (seeded)" },
];

function deps(over: Partial<OutcomesDeps> = {}) {
  const calls: string[] = [];
  const d: OutcomesDeps = {
    domain: "financial",
    accessCode: CODE,
    limiter: { allow: () => true },
    async listPersonas() { calls.push("personas"); return [{ persona: "sarah", user_id: SARAH }, { persona: "sam", user_id: SAM }]; },
    async loadFacts(ids) { calls.push("facts"); return FACTS.filter((f) => ids.includes(f.user_id)); },
    async loadSeries(ids) { calls.push("series"); return SERIES.filter((s) => ids.includes(s.user_id)); },
    async loadAggregate() { calls.push("aggregate"); return [{ metric: "started_credit_health", value: 120, label: "seeded" }, { metric: "moved_down_band_30d_pct", value: 41, label: "seeded" }]; },
    ...over,
  };
  return { d, calls };
}

test("404 on any domain but financial — before anything else, no reads", async () => {
  const { d, calls } = deps({ domain: "moosii", accessCode: undefined });
  const out = await getDemoOutcomes(CODE, "ip", d);
  assert.equal(out.status, 404);
  assert.deepEqual(calls, []);
});

test("503 when DEMO_ACCESS_CODE is unset or blank", async () => {
  for (const accessCode of [undefined, "", "   "]) {
    const { d, calls } = deps({ accessCode });
    const out = await getDemoOutcomes(CODE, "ip", d);
    assert.equal(out.status, 503);
    assert.deepEqual(calls, []);
  }
});

test("429 when the per-IP limit is exceeded — checked before the code", async () => {
  const { d, calls } = deps({ limiter: { allow: () => false } });
  const out = await getDemoOutcomes("wrong", "ip", d);
  assert.equal(out.status, 429);
  assert.deepEqual(calls, []);
});

test("400 when code is missing or not a single string", async () => {
  for (const code of [undefined, "", ["a", "b"], 42]) {
    const { d, calls } = deps();
    const out = await getDemoOutcomes(code, "ip", d);
    assert.equal(out.status, 400);
    assert.deepEqual(calls, []);
  }
});

test("401 on a wrong code — no data read", async () => {
  const { d, calls } = deps();
  const out = await getDemoOutcomes(CODE + "x", "ip", d);
  assert.equal(out.status, 401);
  assert.deepEqual(calls, []);
});

test("user_facts rows are real unless written by the demo seed", () => {
  assert.equal(factProvenance("derived"), "real");
  assert.equal(factProvenance("estimated"), "real");
  assert.equal(factProvenance("platform_api"), "real");
  assert.equal(factProvenance("seed"), "seeded");
});

test("mergePoints tags series rows seeded with their label, and orders by fact_key then time", () => {
  const pts = mergePoints(FACTS.filter((f) => f.user_id === SARAH), SERIES.filter((s) => s.user_id === SARAH));
  assert.deepEqual(pts.map((p) => [p.value, p.provenance, p.source, p.label]), [
    ["false", "seeded", "demo_outcome_series", "a month ago (seeded)"],
    ["false", "seeded", "seed", null],
    ["true", "seeded", "demo_outcome_series", "in three weeks (projected, seeded)"],
  ]);
});

test("200: per persona real + seeded points, never mixed across users; aggregate always seeded", async () => {
  const { d } = deps();
  const out = await getDemoOutcomes(CODE, "ip", d);
  assert.equal(out.status, 200);
  if (out.status !== 200) return;
  assert.deepEqual(out.body.personas.map((p) => p.persona), ["sam", "sarah"]);
  const sam = out.body.personas[0];
  assert.deepEqual(
    sam.points.filter((p) => p.fact_key === "credit_utilization_band").map((p) => [p.value, p.provenance]),
    [["high", "real"], ["moderate", "seeded"]],
  );
  assert.equal(sam.points.find((p) => p.fact_key === "has_direct_deposit")?.provenance, "real");
  assert.ok(!sam.points.some((p) => p.fact_key === "has_emergency_buffer"), "Sarah's points leaked into Sam");
  assert.deepEqual(out.body.aggregate, [
    { metric: "moved_down_band_30d_pct", value: 41, provenance: "seeded", label: "seeded" },
    { metric: "started_credit_health", value: 120, provenance: "seeded", label: "seeded" },
  ]);
});

test("200 with no personas still returns the seeded aggregate", async () => {
  const { d, calls } = deps({ async listPersonas() { return []; } });
  const out = await getDemoOutcomes(CODE, "ip", d);
  assert.equal(out.status, 200);
  assert.ok(out.status === 200 && out.body.personas.length === 0 && out.body.aggregate.length === 2);
  assert.ok(!calls.includes("facts") && !calls.includes("series"));
});
