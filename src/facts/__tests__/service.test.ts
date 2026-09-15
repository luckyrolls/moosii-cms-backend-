// recordFacts ordering guarantees with fake deps (api-contract.md §8). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordFacts, UnknownUserError, type FactsDeps, type ExistingObservation } from "../service";
import type { FactRow } from "../validate";

const USER = "0b7c5f4e-9a51-4d8e-8a63-2f1d3c4b5a69";

function fakeDeps(opts: { existing?: ExistingObservation[]; insertThrows?: Error; enqueue?: { enqueued: boolean; coalescedInto?: string } } = {}) {
  const calls = { insert: [] as FactRow[][], enqueue: [] as { userId: string; reason: string; correlationId: string }[], order: [] as string[] };
  // a tiny in-memory user_facts with the real UNIQUE (user_id, fact_key, observed_at) + DO NOTHING
  const table = new Map<string, FactRow>();
  const deps: FactsDeps = {
    async loadVocabulary() {
      calls.order.push("vocab");
      return { values: new Map([["has_direct_deposit", new Set(["true", "false"])], ["saving_for_home", new Set(["true", "false"])]]) };
    },
    async findExisting() {
      calls.order.push("existing");
      return opts.existing ?? [...table.values()].map((r) => ({ fact_key: r.fact_key, value: r.value, observed_at: r.observed_at }));
    },
    async insertRows(rows) {
      calls.order.push("insert");
      calls.insert.push(rows);
      if (opts.insertThrows) throw opts.insertThrows;
      let written = 0;
      for (const r of rows) {
        const k = `${r.user_id}|${r.fact_key}|${r.observed_at}`;
        if (!table.has(k)) { table.set(k, r); written++; }
      }
      return { written };
    },
    async enqueueRebuild(userId, ctx) {
      calls.order.push("enqueue");
      calls.enqueue.push({ userId, ...ctx });
      return opts.enqueue ?? { enqueued: true, jobId: "job-1" };
    },
  };
  return { deps, calls, table };
}

const batch = {
  user_id: USER,
  facts: [
    { key: "has_direct_deposit", value: "true", observed_at: "2026-09-15T14:00:00Z" },
    { key: "saving_for_home", value: "true", observed_at: "2026-09-15T14:00:00Z" },
  ],
};

test("a valid batch is written in ONE insert carrying every row, then the rebuild is enqueued", async () => {
  const { deps, calls } = fakeDeps();
  const out = await recordFacts(batch, deps, "corr-1");
  assert.deepEqual(out, { status: 200, body: { written: 2, rebuild_enqueued: true }, userId: USER, skipped: 0 });
  assert.equal(calls.insert.length, 1, "exactly one write call");
  assert.equal(calls.insert[0].length, 2, "all rows in that call");
  assert.deepEqual(calls.order, ["vocab", "existing", "insert", "enqueue"], "enqueue only after the write");
  assert.deepEqual(calls.enqueue, [{ userId: USER, reason: "facts_intake", correlationId: "corr-1" }]);
});

test("any validation failure writes NOTHING and enqueues NOTHING", async () => {
  const { deps, calls } = fakeDeps();
  const out = await recordFacts({ ...batch, facts: [batch.facts[0], { key: "has_direct_deposit", value: "1200", observed_at: "2026-09-15T15:00:00Z" }] }, deps, "c");
  assert.equal(out.status, 400);
  assert.equal(calls.insert.length, 0);
  assert.equal(calls.enqueue.length, 0);
});

test("redelivery of an identical batch is safe: 200, written 0, no duplicate rows", async () => {
  const { deps, table } = fakeDeps();
  await recordFacts(batch, deps, "c1");
  const again = await recordFacts(batch, deps, "c2");
  assert.equal(again.status, 200);
  if (again.status === 200) {
    assert.deepEqual(again.body, { written: 0, rebuild_enqueued: true });
    assert.equal(again.skipped, 2);
  }
  assert.equal(table.size, 2, "still two rows");
});

test("a DIFFERENT value at an already-recorded instant is a 409 and writes nothing", async () => {
  const { deps, calls } = fakeDeps({
    existing: [{ fact_key: "saving_for_home", value: "false", observed_at: "2026-09-15T14:00:00+00:00" }],
  });
  const out = await recordFacts(batch, deps, "c");
  assert.equal(out.status, 409);
  if (out.status === 409) {
    assert.equal(out.code, "conflicting_observation");
    assert.match(out.message, /facts\[1\]: "saving_for_home" .* already recorded as "false", not "true"/);
  }
  assert.equal(calls.insert.length, 0);
  assert.equal(calls.enqueue.length, 0);
});

test("an unknown user (FK 076) is a 404 and no rebuild is enqueued", async () => {
  const { deps, calls } = fakeDeps({ insertThrows: new UnknownUserError(USER) });
  const out = await recordFacts(batch, deps, "c");
  assert.equal(out.status, 404);
  if (out.status === 404) assert.equal(out.code, "unknown_user");
  assert.equal(calls.enqueue.length, 0);
});

test("any other write error propagates (→ 500 at the route) and no rebuild is enqueued", async () => {
  const { deps, calls } = fakeDeps({ insertThrows: new Error("connection reset") });
  await assert.rejects(recordFacts(batch, deps, "c"), /connection reset/);
  assert.equal(calls.enqueue.length, 0);
});

test("a rebuild coalesced into an already-queued job still reports rebuild_enqueued: true", async () => {
  const { deps } = fakeDeps({ enqueue: { enqueued: false, coalescedInto: "job-queued" } });
  const out = await recordFacts(batch, deps, "c");
  assert.equal(out.status, 200);
  if (out.status === 200) assert.equal(out.body.rebuild_enqueued, true);
});

test("an enqueue that failed is reported honestly as rebuild_enqueued: false (facts stay written)", async () => {
  const { deps, table } = fakeDeps({ enqueue: { enqueued: false } });
  const out = await recordFacts(batch, deps, "c");
  assert.equal(out.status, 200);
  if (out.status === 200) assert.deepEqual(out.body, { written: 2, rebuild_enqueued: false });
  assert.equal(table.size, 2);
});
