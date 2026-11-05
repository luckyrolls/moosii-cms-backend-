// POST /facts/batch core with fake deps (api-contract.md §8b-batch): members are independent, one
// vocabulary load per batch, and each member goes through the same recordFacts core. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordFactsBatch, MAX_MEMBERS_PER_BATCH } from "../batch";
import { UnknownUserError, type FactsDeps, type LatestFact } from "../service";
import type { FactRow } from "../validate";

const A = "0b7c5f4e-9a51-4d8e-8a63-2f1d3c4b5a69";
const B = "4e1d9c3a-2b7f-4e55-9a01-6d8c7b5e4f32";
const C = "7c2f8e51-3a46-4b9d-8e17-5f0a1b2c3d4e";

const AT = "2026-11-01T09:00:00Z";
const facts = (value: string) => [{ key: "has_direct_deposit", value, observed_at: AT }];

function fakeDeps(opts: { latest?: Record<string, LatestFact[]>; throwFor?: string; unknownUser?: string } = {}) {
  const calls = { vocab: 0, insert: [] as FactRow[][], enqueue: [] as string[], latest: [] as string[] };
  const deps: FactsDeps = {
    async loadVocabulary() {
      calls.vocab++;
      return { values: new Map([["has_direct_deposit", new Set(["true", "false"])]]) };
    },
    async findExisting() { return []; },
    async latestFacts(userId) { calls.latest.push(userId); return opts.latest?.[userId] ?? []; },
    async insertRows(rows) {
      const userId = rows[0]?.user_id ?? "";
      if (opts.throwFor === userId) throw new Error("connection reset");
      if (opts.unknownUser === userId) throw new UnknownUserError(userId);
      calls.insert.push(rows);
      return { written: rows.length };
    },
    async enqueueRebuild(userId) { calls.enqueue.push(userId); return { enqueued: true, jobId: "j" }; },
  };
  return { deps, calls };
}

test("many members in one call: one result each, one rebuild each, and the vocabulary loaded ONCE", async () => {
  const { deps, calls } = fakeDeps();
  const out = await recordFactsBatch({ members: [A, B, C].map((user_id) => ({ user_id, facts: facts("true") })) }, deps, "corr");
  assert.equal(out.status, 200);
  if (out.status !== 200) return;
  assert.deepEqual(out.body.summary, { members: 3, ok: 3, failed: 0, unchanged: 0, written: 3, rebuilds_enqueued: 3 });
  assert.deepEqual(out.body.results.map((r) => r.user_id), [A, B, C]);
  assert.deepEqual(out.body.results[0], { user_id: A, status: "ok", written: 1, unchanged: false, rebuild_enqueued: true });
  assert.deepEqual(calls.enqueue, [A, B, C]);
  assert.equal(calls.vocab, 1, "the vocabulary is the same for every member");
});

test("mixed members: one writes, one is unchanged (D6), one is rejected — each reported on its own", async () => {
  const { deps, calls } = fakeDeps({
    latest: { [B]: [{ fact_key: "has_direct_deposit", value: "true", source: "platform_api" }] },
  });
  const out = await recordFactsBatch({
    members: [
      { user_id: A, facts: facts("true") },                                           // new → written
      { user_id: B, facts: facts("true") },                                           // already true → no-op
      { user_id: C, facts: [{ key: "has_direct_deposit", value: "1200", observed_at: AT }] },  // numeric → 400
    ],
  }, deps, "corr");
  assert.equal(out.status, 200);
  if (out.status !== 200) return;
  assert.deepEqual(out.body.summary, { members: 3, ok: 2, failed: 1, unchanged: 1, written: 1, rebuilds_enqueued: 1 });
  assert.deepEqual(out.body.results[0], { user_id: A, status: "ok", written: 1, unchanged: false, rebuild_enqueued: true });
  assert.deepEqual(out.body.results[1], { user_id: B, status: "ok", written: 0, unchanged: true, rebuild_enqueued: false });
  assert.equal(out.body.results[2].status, "error");
  if (out.body.results[2].status === "error") {
    assert.equal(out.body.results[2].user_id, C);
    assert.equal(out.body.results[2].error.code, "unknown_fact");
  }
  assert.deepEqual(calls.enqueue, [A], "only the member whose facts changed is rebuilt");
  assert.deepEqual(calls.insert.map((rows) => rows[0].user_id), [A]);
});

test("one member's rejection never touches another member's write", async () => {
  const { deps, calls } = fakeDeps({ unknownUser: A });
  const out = await recordFactsBatch({ members: [{ user_id: A, facts: facts("true") }, { user_id: B, facts: facts("true") }] }, deps, "corr");
  assert.equal(out.status, 200);
  if (out.status !== 200) return;
  assert.equal(out.body.results[0].status, "error");
  if (out.body.results[0].status === "error") assert.equal(out.body.results[0].error.code, "unknown_user");
  assert.deepEqual(out.body.results[1], { user_id: B, status: "ok", written: 1, unchanged: false, rebuild_enqueued: true });
  assert.deepEqual(calls.enqueue, [B]);
});

test("a write that THROWS fails that member only, as facts_write_failed", async () => {
  const { deps } = fakeDeps({ throwFor: A });
  const out = await recordFactsBatch({ members: [{ user_id: A, facts: facts("true") }, { user_id: B, facts: facts("true") }] }, deps, "corr");
  assert.equal(out.status, 200);
  if (out.status !== 200) return;
  assert.equal(out.body.summary.failed, 1);
  if (out.body.results[0].status === "error") {
    assert.equal(out.body.results[0].error.code, "facts_write_failed");
    assert.match(out.body.results[0].error.message, /connection reset/);
  }
  assert.equal(out.body.results[1].status, "ok");
});

test("envelope rejections are 400 and write nothing", async () => {
  const cases: [unknown, string][] = [
    [null, "body must be a JSON object"],
    [[], "body must be a JSON object"],
    [{}, "members must be a non-empty array"],
    [{ members: [] }, "members must be a non-empty array"],
    [{ members: [{ user_id: A, facts: facts("true") }, { user_id: A.toUpperCase(), facts: facts("false") }] }, "repeats members[0]"],
    [{ members: [null] }, "members[0] must be an object"],
    [{ members: [{ user_id: A, facts: Array.from({ length: 101 }, () => facts("true")[0]) }] }, "at most 100 facts per member"],
    [{ members: Array.from({ length: MAX_MEMBERS_PER_BATCH + 1 }, () => ({ user_id: A, facts: facts("true") })) }, `at most ${MAX_MEMBERS_PER_BATCH} members per call`],
  ];
  for (const [body, expect] of cases) {
    const { deps, calls } = fakeDeps();
    const out = await recordFactsBatch(body, deps, "corr");
    assert.equal(out.status, 400, JSON.stringify(expect));
    if (out.status === 400) {
      assert.equal(out.code, "invalid_request");
      assert.ok(out.message.includes(expect), `${out.message} should include ${expect}`);
    }
    assert.equal(calls.insert.length, 0);
    assert.equal(calls.enqueue.length, 0);
  }
});

test("a full batch of unchanged members writes nothing and queues nothing — the daily-push case", async () => {
  const latest = Object.fromEntries([A, B, C].map((u) => [u, [{ fact_key: "has_direct_deposit", value: "true", source: "platform_api" }]]));
  const { deps, calls } = fakeDeps({ latest });
  const out = await recordFactsBatch({ members: [A, B, C].map((user_id) => ({ user_id, facts: facts("true") })) }, deps, "corr");
  assert.equal(out.status, 200);
  if (out.status !== 200) return;
  assert.deepEqual(out.body.summary, { members: 3, ok: 3, failed: 0, unchanged: 3, written: 0, rebuilds_enqueued: 0 });
  assert.equal(calls.insert.length, 0);
  assert.equal(calls.enqueue.length, 0);
});
