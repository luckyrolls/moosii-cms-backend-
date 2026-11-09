// POST /demo/simulate-fact — the pure core with fake facts deps (api-contract §9d). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateFact, SIMULATED_SOURCE_REF, SIMULATE_FACT_KEYS } from "../simulate";
import type { FactsDeps } from "../../facts/service";
import type { FactRow } from "../../facts/validate";

const SAM = { user_id: "19587e0a-bfe0-48e2-94a1-055a5bbc9584", persona: "sam" };
const NOW = new Date("2026-10-17T15:00:00.000Z");

function fake(resolved = 1, latest: { fact_key: string; value: string; source?: string | null }[] = []) {
  const calls = { insert: [] as FactRow[][], order: [] as string[], resolve: [] as string[], enqueue: [] as { reason: string }[] };
  const deps: FactsDeps = {
    async loadVocabulary() {
      return { values: new Map([["credit_utilization_band", new Set(["high", "moderate", "low"])], ["has_emergency_buffer", new Set(["true", "false"])],
                                ["has_direct_deposit", new Set(["true", "false"])],
                                ["new_subscription_recent", new Set(["true", "false"])]]) };
    },
    async findExisting() { return []; },
    async latestFacts() { return latest; },
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

test("only the three allowlisted fact keys; anything else is refused before any write", async () => {
  const { deps, calls } = fake();
  assert.deepEqual([...SIMULATE_FACT_KEYS], ["credit_utilization_band", "has_emergency_buffer", "new_subscription_recent"]);
  for (const body of [{ fact_key: "has_direct_deposit", value: "true" }, { fact_key: "saving_for_home", value: "true" }, {}, null]) {
    const out = await simulateFact(SAM, body, { correlationId: "c", now: NOW }, deps);
    assert.equal(out.status, 400);
    assert.equal((out as { code: string }).code, "fact_not_allowed");
  }
  assert.equal(calls.insert.length, 0);
  for (const body of [{ fact_key: "has_emergency_buffer", value: "false" }, { fact_key: "new_subscription_recent", value: "true" }]) {
    const ok = await simulateFact(SAM, body, { correlationId: "c", now: NOW }, deps);
    assert.equal(ok.status, 200, body.fact_key);
  }
});

// F83: the key that routes Subscription Audit (fact_track_rules new_subscription_recent=true). Sam's derived value is
// false, so simulating true is a real change — one seeded row, rebuild enqueued, follow-ups checked.
test("new_subscription_recent=true writes one seeded observation and enqueues the rebuild", async () => {
  const { deps, calls } = fake(0, [{ fact_key: "new_subscription_recent", value: "false", source: "derived" }]);
  const out = await simulateFact(SAM, { fact_key: "new_subscription_recent", value: "true" }, { correlationId: "c", now: NOW }, deps);
  assert.equal(out.status, 200);
  if (out.status === 200) assert.deepEqual(out.body, { persona: "sam", user_id: SAM.user_id, fact_key: "new_subscription_recent",
    value: "true", observed_at: NOW.toISOString(), written: 1, rebuild_enqueued: true, followups_verified: 0 });
  assert.deepEqual(calls.insert, [[{ user_id: SAM.user_id, fact_key: "new_subscription_recent", value: "true",
    observed_at: NOW.toISOString(), source: "seed", source_ref: SIMULATED_SOURCE_REF }]]);
  assert.deepEqual(calls.order, ["insert", "resolve", "enqueue"]);
});

test("the value must be vocabulary (no amounts): unknown or numeric values are refused, nothing written", async () => {
  const { deps, calls } = fake();
  for (const value of ["extreme", "0.9", ""]) {
    const out = await simulateFact(SAM, { fact_key: "credit_utilization_band", value }, { correlationId: "c", now: NOW }, deps);
    assert.equal(out.status, 400, value);
  }
  assert.equal(calls.insert.length, 0);
});

test("D6: simulating the value the persona ALREADY has changes nothing — no row, no rebuild, nothing verified", async () => {
  const { deps, calls } = fake(1, [{ fact_key: "credit_utilization_band", value: "low", source: "seed" }]);
  const out = await simulateFact(SAM, { fact_key: "credit_utilization_band", value: "low" }, { correlationId: "c", now: NOW }, deps);
  assert.equal(out.status, 200);
  if (out.status === 200) assert.deepEqual(out.body, { persona: "sam", user_id: SAM.user_id, fact_key: "credit_utilization_band", value: "low",
    observed_at: NOW.toISOString(), written: 0, rebuild_enqueued: false, followups_verified: 0 });
  assert.deepEqual(calls.order, [], "no write, no verification, no rebuild");
});

test("a simulated value that DIFFERS from the current one still writes and verifies (the demo path)", async () => {
  const { deps, calls } = fake(1, [{ fact_key: "credit_utilization_band", value: "high", source: "derived" }]);
  const out = await simulateFact(SAM, { fact_key: "credit_utilization_band", value: "low" }, { correlationId: "c", now: NOW }, deps);
  assert.equal(out.status, 200);
  if (out.status === 200) assert.equal(out.body.followups_verified, 1);
  assert.deepEqual(calls.order, ["insert", "resolve", "enqueue"]);
});

test("followups_verified reports what the hook resolved (0 when nothing matched)", async () => {
  const { deps } = fake(0);
  const out = await simulateFact(SAM, { fact_key: "credit_utilization_band", value: "high" }, { correlationId: "c", now: NOW }, deps);
  assert.equal(out.status, 200);
  assert.equal((out as { body: { followups_verified: number } }).body.followups_verified, 0);
});
