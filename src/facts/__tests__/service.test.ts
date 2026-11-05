// recordFacts ordering guarantees with fake deps (api-contract.md §8). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordFacts, UnknownUserError, type FactsDeps, type ExistingObservation, type LatestFact } from "../service";
import type { FactRow } from "../validate";

const USER = "0b7c5f4e-9a51-4d8e-8a63-2f1d3c4b5a69";

function fakeDeps(opts: { existing?: ExistingObservation[]; latest?: LatestFact[]; insertThrows?: Error; enqueue?: { enqueued: boolean; coalescedInto?: string } } = {}) {
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
    // user_facts_latest: one row per key, latest observed_at wins (071)
    async latestFacts() {
      calls.order.push("latest");
      if (opts.latest) return opts.latest;
      const latest = new Map<string, FactRow>();
      for (const r of table.values()) {
        const cur = latest.get(r.fact_key);
        if (!cur || Date.parse(r.observed_at) >= Date.parse(cur.observed_at)) latest.set(r.fact_key, r);
      }
      return [...latest.values()].map((r) => ({ fact_key: r.fact_key, value: r.value, source: r.source }));
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
  assert.deepEqual(out, { status: 200, body: { written: 2, rebuild_enqueued: true, unchanged: false }, userId: USER, skipped: 0 });
  assert.equal(calls.insert.length, 1, "exactly one write call");
  assert.equal(calls.insert[0].length, 2, "all rows in that call");
  assert.deepEqual(calls.order, ["vocab", "existing", "latest", "insert", "enqueue"], "enqueue only after the write");
  assert.deepEqual(calls.enqueue, [{ userId: USER, reason: "facts_intake", correlationId: "corr-1" }]);
});

test("any validation failure writes NOTHING and enqueues NOTHING", async () => {
  const { deps, calls } = fakeDeps();
  const out = await recordFacts({ ...batch, facts: [batch.facts[0], { key: "has_direct_deposit", value: "1200", observed_at: "2026-09-15T15:00:00Z" }] }, deps, "c");
  assert.equal(out.status, 400);
  assert.equal(calls.insert.length, 0);
  assert.equal(calls.enqueue.length, 0);
});

test("redelivery of an identical batch is safe: 200, written 0, no duplicate rows — and since D6, no rebuild", async () => {
  const { deps, table, calls } = fakeDeps();
  await recordFacts(batch, deps, "c1");
  calls.insert.length = 0;
  calls.enqueue.length = 0;
  const again = await recordFacts(batch, deps, "c2");
  assert.equal(again.status, 200);
  if (again.status === 200) {
    assert.deepEqual(again.body, { written: 0, rebuild_enqueued: false, unchanged: true });
    assert.equal(again.skipped, 2);
  }
  assert.equal(table.size, 2, "still two rows");
  assert.equal(calls.insert.length, 0, "the no-op path does not even write");
  assert.equal(calls.enqueue.length, 0, "and queues no rebuild");
});

// ---- D6: a push that tells us nothing new (2026-11-05) ----

test("every fact already at the member's CURRENT value: no insert, no rebuild, 200 written 0 unchanged true", async () => {
  const { deps, calls } = fakeDeps({ latest: [
    { fact_key: "has_direct_deposit", value: "true", source: "platform_api" },
    { fact_key: "saving_for_home", value: "true", source: "platform_api" },
  ] });
  // a LATER observed_at than anything recorded — today this wrote two rows and queued a rebuild
  const out = await recordFacts({ ...batch, facts: batch.facts.map((f) => ({ ...f, observed_at: "2026-10-01T09:00:00Z" })) }, deps, "c");
  assert.equal(out.status, 200);
  if (out.status === 200) {
    assert.deepEqual(out.body, { written: 0, rebuild_enqueued: false, unchanged: true });
    assert.equal(out.skipped, 2);
  }
  assert.deepEqual(calls.order, ["vocab", "existing", "latest"], "stops before the write");
  assert.equal(calls.insert.length, 0);
  assert.equal(calls.enqueue.length, 0);
});

test("ONE fact that differs writes the whole batch, exactly as before (all-or-nothing is unchanged)", async () => {
  const { deps, calls } = fakeDeps({ latest: [
    { fact_key: "has_direct_deposit", value: "true", source: "platform_api" },
    { fact_key: "saving_for_home", value: "false", source: "platform_api" },
  ] });
  const out = await recordFacts(batch, deps, "c");
  assert.equal(out.status, 200);
  if (out.status === 200) assert.deepEqual(out.body, { written: 2, rebuild_enqueued: true, unchanged: false });
  assert.equal(calls.insert.length, 1);
  assert.equal(calls.insert[0].length, 2, "the matching fact is written too — the batch is one observation");
  assert.equal(calls.enqueue.length, 1);
});

test("a key with no current value at all is new, so it is written", async () => {
  const { deps, calls } = fakeDeps({ latest: [{ fact_key: "has_direct_deposit", value: "true", source: "platform_api" }] });
  const out = await recordFacts(batch, deps, "c");
  assert.equal(out.status, 200);
  if (out.status === 200) assert.equal(out.body.written, 2);
  assert.equal(calls.enqueue.length, 1);
});

test("unchanged but EARLIER than the current value is still a no-op (latest wins, so it could not change the plan)", async () => {
  const { deps, calls } = fakeDeps({ latest: [
    { fact_key: "has_direct_deposit", value: "true", source: "derived" },
    { fact_key: "saving_for_home", value: "true", source: "derived" },
  ] });
  const out = await recordFacts({ ...batch, facts: batch.facts.map((f) => ({ ...f, observed_at: "2026-01-02T03:04:00Z" })) }, deps, "c");
  assert.equal(out.status, 200);
  if (out.status === 200) assert.equal(out.body.unchanged, true);
  assert.equal(calls.insert.length, 0);
});

test("a contradiction is still a 409, even when the value equals the member's current one", async () => {
  const { deps, calls } = fakeDeps({
    existing: [{ fact_key: "saving_for_home", value: "false", observed_at: "2026-09-15T14:00:00+00:00" }],
    latest: [
      { fact_key: "has_direct_deposit", value: "true", source: "platform_api" },
      { fact_key: "saving_for_home", value: "true", source: "platform_api" },
    ],
  });
  const out = await recordFacts(batch, deps, "c");
  assert.equal(out.status, 409, "the conflict check runs before the no-op check");
  assert.equal(calls.insert.length, 0);
  assert.equal(calls.enqueue.length, 0);
});

test("the no-op path runs no follow-up verification (nothing was written — exactly as a redelivery today)", async () => {
  const { deps, calls } = fakeDeps({ latest: [
    { fact_key: "has_direct_deposit", value: "true", source: "platform_api" },
    { fact_key: "saving_for_home", value: "true", source: "platform_api" },
  ] });
  let hit = 0;
  deps.resolveFollowups = async () => { hit++; return { resolved: 0 }; };
  await recordFacts(batch, deps, "c");
  assert.equal(hit, 0);
  assert.equal(calls.enqueue.length, 0);
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
  if (out.status === 200) assert.deepEqual(out.body, { written: 2, rebuild_enqueued: false, unchanged: false });
  assert.equal(table.size, 2);
});

// ---- activity follow-ups hook (migration 113) ----

test("follow-ups are verified AFTER the write and BEFORE the rebuild, only when something new was written", async () => {
  const { deps, calls } = fakeDeps();
  const resolved: string[] = [];
  deps.resolveFollowups = async (userId) => { calls.order.push("resolve"); resolved.push(userId); return { resolved: 1 }; };
  const first = await recordFacts(batch, deps, "corr-f1");
  assert.equal(first.status, 200);
  assert.deepEqual(calls.order, ["vocab", "existing", "latest", "insert", "resolve", "enqueue"]);
  assert.deepEqual(resolved, [USER]);
  calls.order.length = 0;
  await recordFacts(batch, deps, "corr-f2");                       // identical redelivery: the D6 no-op path
  assert.deepEqual(calls.order, ["vocab", "existing", "latest"], "no evidence added → no verification");
});

test("a follow-up verification failure never fails the facts write (the rebuild still runs)", async () => {
  const { deps, calls } = fakeDeps();
  deps.resolveFollowups = async () => { throw new Error("rpc down"); };
  const out = await recordFacts(batch, deps, "corr-f3");
  assert.deepEqual(out, { status: 200, body: { written: 2, rebuild_enqueued: true, unchanged: false }, userId: USER, skipped: 0 });
  assert.equal(calls.enqueue.length, 1);
});

test("a rejected batch never reaches follow-up verification", async () => {
  const { deps } = fakeDeps();
  let hit = 0;
  deps.resolveFollowups = async () => { hit++; return { resolved: 0 }; };
  const out = await recordFacts({ user_id: USER, facts: [{ key: "has_direct_deposit", value: "maybe", observed_at: "2026-09-15T14:00:00Z" }] }, deps, "corr-f4");
  assert.equal(out.status, 400);
  assert.equal(hit, 0);
});
