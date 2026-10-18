// POST /demo/simulate-fact — the pure core with fake facts deps (api-contract §9d). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateFact, SIMULATED_SOURCE_REF } from "../simulate";
import type { FactsDeps } from "../../facts/service";
import type { FactRow } from "../../facts/validate";

const SAM = { user_id: "19587e0a-bfe0-48e2-94a1-055a5bbc9584", persona: "sam" };
const NOW = new Date("2026-10-17T15:00:00.000Z");

function fake(resolved = 1) {
  const calls = { insert: [] as FactRow[][], order: [] as string[], resolve: [] as string[], enqueue: [] as { reason: string }[] };
  const deps: FactsDeps = {
    async loadVocabulary() {
      return { values: new Map([["credit_utilization_band", new Set(["high", "moderate", "low"])], ["has_emergency_buffer", new Set(["true", "false"])],
                                ["has_direct_deposit", new Set(["true", "false"])]]) };
    },
    async findExisting() { return []; },
    async insertRows(rows) { calls.order.push("insert"); calls.insert.push(rows); return { written: rows.length }; },
    async enqueueRebuild(_u, ctx) { calls.order.push("enqueue"); calls.enqueue.push({ reason: ctx.reason }); return { enqueued: true, jobId: "j" }; },
    async resolveFollowups(userId) { calls.order.push("resolve"); calls.resolve.push(userId); return { resolved }; },
  };
  return { deps, calls };
}

test("records ONE seeded fact for the token's persona, through recordFacts: write → verify follow-ups → rebuild", async () => {
  const { deps, calls } = fake(1);
  const out = await simulateFact(SAM, { fact_key: "credit_utilization_band", value: "low", user_id: "someone-else" },
    { correlationId: "c", now: NOW }, deps);
  assert.deepEqual(out, { status: 200, body: { persona: "sam", user_id: SAM.user_id, fact_key: "credit_utilization_band", value: "low",
    observed_at: NOW.toISOString(), written: 1, rebuild_enqueued: true, followups_verified: 1 } });
  assert.deepEqual(calls.insert, [[{ user_id: SAM.user_id, fact_key: "credit_utilization_band", value: "low",
    observed_at: NOW.toISOString(), source: "seed", source_ref: SIMULATED_SOURCE_REF }]]);
  assert.deepEqual(calls.order, ["insert", "resolve", "enqueue"]);
  assert.deepEqual(calls.resolve, [SAM.user_id]);
  assert.deepEqual(calls.enqueue, [{ reason: "demo_simulate_fact" }]);
});

test("only the two allowlisted fact keys; anything else is refused before any write", async () => {
  const { deps, calls } = fake();
  for (const body of [{ fact_key: "has_direct_deposit", value: "true" }, { fact_key: "saving_for_home", value: "true" }, {}, null]) {
    const out = await simulateFact(SAM, body, { correlationId: "c", now: NOW }, deps);
    assert.equal(out.status, 400);
    assert.equal((out as { code: string }).code, "fact_not_allowed");
  }
  assert.equal(calls.insert.length, 0);
  const ok = await simulateFact(SAM, { fact_key: "has_emergency_buffer", value: "false" }, { correlationId: "c", now: NOW }, deps);
  assert.equal(ok.status, 200);
});

test("the value must be vocabulary (no amounts): unknown or numeric values are refused, nothing written", async () => {
  const { deps, calls } = fake();
  for (const value of ["extreme", "0.9", ""]) {
    const out = await simulateFact(SAM, { fact_key: "credit_utilization_band", value }, { correlationId: "c", now: NOW }, deps);
    assert.equal(out.status, 400, value);
  }
  assert.equal(calls.insert.length, 0);
});

test("followups_verified reports what the hook resolved (0 when nothing matched)", async () => {
  const { deps } = fake(0);
  const out = await simulateFact(SAM, { fact_key: "credit_utilization_band", value: "high" }, { correlationId: "c", now: NOW }, deps);
  assert.equal(out.status, 200);
  assert.equal((out as { body: { followups_verified: number } }).body.followups_verified, 0);
});
