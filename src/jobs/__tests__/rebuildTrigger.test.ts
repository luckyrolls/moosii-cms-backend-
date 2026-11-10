// The auto-rebuild coalescing guard: fold into a QUEUED rebuild, never a RUNNING one.
// A publish that commits mid-run is invisible to every user that run has already passed, so folding
// into it loses the change. api-contract.md section 3. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enqueueRebuildIfIdle, coalesceTarget, jobInput, describeRebuild,
  type RebuildJobRow, type RebuildScope, type RebuildTriggerDeps,
} from "../rebuildTrigger";

const USER = "19587e0a-bfe0-48e2-94a1-055a5bbc9584";
const CTX = { reason: "lesson_publish", correlationId: "151069ae-0866-43fc-912d-68977d53a167" };

function fakeDeps(open: RebuildJobRow[] | Error) {
  const calls = { listed: [] as RebuildScope[], created: [] as Record<string, unknown>[] };
  let n = 0;
  const deps: RebuildTriggerDeps = {
    async listOpenRebuilds(scope) {
      calls.listed.push(scope);
      if (open instanceof Error) throw open;
      return open;
    },
    async createAndStart(input) { calls.created.push(input); return `job-new-${++n}`; },
  };
  return { deps, calls };
}

test("nothing open: a rebuild is queued, with the scope, reason and correlation id stamped", async () => {
  const { deps, calls } = fakeDeps([]);
  const r = await enqueueRebuildIfIdle({ kind: "all" }, CTX, deps);
  assert.deepEqual(r, { enqueued: true, jobId: "job-new-1" });
  assert.deepEqual(calls.created, [{ scope: "all", triggered_by: "lesson_publish", correlation_id: CTX.correlationId }]);
});

// THE FIX. Before this, scope:all folded into `queued` OR `running`, while the single-user path
// folded into `queued` only. A publish during a running rebuild-all reported "coalesced" and was
// dropped for every user that run had already written.
test("a RUNNING rebuild is never folded into - a fresh rebuild is queued behind it", async () => {
  const { deps, calls } = fakeDeps([{ id: "job-running", status: "running" }]);
  const r = await enqueueRebuildIfIdle({ kind: "all" }, CTX, deps);
  assert.deepEqual(r, { enqueued: true, jobId: "job-new-1" }, "queued a fresh rebuild");
  assert.equal(r.coalescedInto, undefined, "did not fold into the running job");
  assert.equal(calls.created.length, 1);
});

test("a QUEUED rebuild IS folded into - no second job, and the queued one is named", async () => {
  const { deps, calls } = fakeDeps([{ id: "job-queued", status: "queued" }]);
  assert.deepEqual(await enqueueRebuildIfIdle({ kind: "all" }, CTX, deps),
    { enqueued: false, coalescedInto: "job-queued" });
  assert.equal(calls.created.length, 0);
});

test("running AND queued both open: it folds into the queued one, whatever order they arrive in", async () => {
  for (const rows of [
    [{ id: "job-running", status: "running" }, { id: "job-queued", status: "queued" }],
    [{ id: "job-queued", status: "queued" }, { id: "job-running", status: "running" }],
  ]) {
    const { deps, calls } = fakeDeps(rows);
    assert.deepEqual(await enqueueRebuildIfIdle({ kind: "all" }, CTX, deps),
      { enqueued: false, coalescedInto: "job-queued" });
    assert.equal(calls.created.length, 0);
  }
  // the guard itself, directly: only a queued row is ever a target
  assert.equal(coalesceTarget([{ id: "a", status: "running" }]), null);
  assert.equal(coalesceTarget([{ id: "a", status: "succeeded" }, { id: "b", status: "failed" }]), null);
  assert.equal(coalesceTarget([]), null);
  assert.equal(coalesceTarget([{ id: "a", status: "running" }, { id: "b", status: "queued" }])?.id, "b");
});

test("the single-user trigger takes the same path and stamps user_id, not scope", async () => {
  const { deps, calls } = fakeDeps([{ id: "job-running", status: "running" }]);
  const r = await enqueueRebuildIfIdle({ kind: "user", userId: USER }, { reason: "facts_intake" }, deps);
  assert.equal(r.enqueued, true);
  assert.deepEqual(calls.created, [{ user_id: USER, triggered_by: "facts_intake", correlation_id: null }]);
  assert.deepEqual(calls.listed, [{ kind: "user", userId: USER }], "the scope is passed through so the query can filter on it");
  assert.deepEqual(jobInput({ kind: "all" }, { reason: "r" }), { scope: "all", triggered_by: "r", correlation_id: null });
});

test("it fails TOWARD rebuilding: a broken coalescing check still enqueues", async () => {
  const { deps, calls } = fakeDeps(new Error("jobs query failed"));
  assert.deepEqual(await enqueueRebuildIfIdle({ kind: "all" }, CTX, deps), { enqueued: true, jobId: "job-new-1" });
  assert.equal(calls.created.length, 1);
});

test("it NEVER throws - a failed insert is reported, so a publish is never failed by its rebuild", async () => {
  const deps: RebuildTriggerDeps = {
    async listOpenRebuilds() { return []; },
    async createAndStart() { throw new Error("insert failed"); },
  };
  assert.deepEqual(await enqueueRebuildIfIdle({ kind: "all" }, CTX, deps), { enqueued: false });
});

test("describeRebuild maps the result onto the publish response fields", () => {
  assert.deepEqual(describeRebuild({ enqueued: true, jobId: "j1" }), { rebuild: "queued", rebuild_job_id: "j1" });
  assert.deepEqual(describeRebuild({ enqueued: false, coalescedInto: "j0" }), { rebuild: "coalesced", rebuild_job_id: "j0" });
  assert.deepEqual(describeRebuild({ enqueued: false }), { rebuild: "failed", rebuild_job_id: null });
});

// The whole point, end to end: the rebuild that results from a publish must SEE that publish.
// A rebuild reads the published pool as it walks the user base, so a run already in flight carries
// a stale view; the fresh job this guard queues reads the pool again, after the commit.
test("publish during a running rebuild: the queued rebuild includes the lesson, the running one cannot", async () => {
  const pool: string[] = ["old-lesson"];
  const plans = new Map<string, string[]>();
  // a rebuild_mlp run: snapshots the pool when it STARTS, then writes each user's plan from it
  const startRun = (users: string[]) => {
    const snapshot = [...pool];
    return { snapshot, finish: () => { for (const u of users) plans.set(u, [...snapshot]); } };
  };

  const running = startRun(["sam", "sarah"]);        // rebuild-all in flight, pool snapshotted
  running.finish();                                  // ...and it has already written Sam
  pool.push("new-lesson");                           // POST /lessons/:id/publish commits

  const { deps, calls } = fakeDeps([{ id: "job-running", status: "running" }]);
  const r = await enqueueRebuildIfIdle({ kind: "all" }, CTX, deps);

  assert.equal(r.enqueued, true, "a fresh rebuild was queued rather than folded into the running one");
  assert.deepEqual(running.snapshot, ["old-lesson"], "the running job could never have seen the publish");
  assert.deepEqual(plans.get("sam"), ["old-lesson"], "which is why Sam's plan is stale at this point");

  const queued = startRun(["sam", "sarah"]);         // the job this guard created, run after the commit
  queued.finish();
  assert.deepEqual(plans.get("sam"), ["old-lesson", "new-lesson"], "the queued rebuild includes the lesson");
  assert.deepEqual(plans.get("sarah"), ["old-lesson", "new-lesson"]);
  assert.equal(calls.created.length, 1, "exactly one fresh rebuild, not one per user");
});
