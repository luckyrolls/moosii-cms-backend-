// Slice-2 proof harness for the generateFullMLP hang fix (CHANGE 4). Run: `npm test`.
//
// BEFORE = the frozen, verbatim pre-fix copy (generateFullMLP.before.ts), always executed
// in a CHILD PROCESS under a kill timeout, because on the defect inputs it never returns.
// AFTER  = the live src/mlp/generateFullMLP.ts, in-process.
//
// Cases:
//   (a) zero-weight track ........ BEFORE hangs / AFTER throws MlpInvalidWeights naming it
//   (b) Age track + empty ages ... BEFORE hangs / AFTER completes with the BASE weight
//   (c) normal users ............. BEFORE == AFTER == committed snapshot (byte-identical)
// The snapshot (snapshots/ranking.before.json) was GENERATED FROM THE PRE-FIX COPY, so
// (c) is a real before/after diff, not a self-fulfilling one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cases, identityCases } from "./fixtures";
import { generateFullMLP, MlpInvalidWeights } from "../generateFullMLP";

const RUNNER = path.join(__dirname, "runCase.ts");
const KILL_MS = 10_000;

type ChildResult =
  | { hung: true }
  | { hung: false; ok: true; output: ReturnType<typeof generateFullMLP> }
  | { hung: false; ok: false; error: { name: string; message: string; trackIds: string[] | null } };

// Kill-timeout wrapper: a child that does not print within KILL_MS is "hung".
function runInChild(which: "before" | "after", name: string): ChildResult {
  const r = spawnSync(process.execPath, ["--import", "tsx", RUNNER, which, name], {
    encoding: "utf8",
    timeout: KILL_MS,
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") return { hung: true };
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`runCase ${which}/${name} exited ${r.status}: ${r.stderr}`);
  return { hung: false, ...JSON.parse(r.stdout.trim()) };
}

const snapshot = JSON.parse(
  readFileSync(path.join(__dirname, "snapshots", "ranking.before.json"), "utf8")
) as Record<string, ReturnType<typeof generateFullMLP>>;

test("(a) zero-weight track: BEFORE hangs, AFTER throws MlpInvalidWeights naming the track", () => {
  const before = runInChild("before", "zero_weight_track");
  assert.equal(before.hung, true, "pre-fix copy must hang (killed at timeout)");

  assert.throws(
    () => generateFullMLP(cases.zero_weight_track),
    (e: unknown) => e instanceof MlpInvalidWeights && e.name === "MlpInvalidWeights" && e.trackIds.includes("A"),
    "fixed function must throw a typed error naming track A"
  );
  // Same result when driven through the child runner (what the routes see: an Error).
  const after = runInChild("after", "zero_weight_track");
  assert.equal(after.hung, false);
  assert.equal(after.hung === false && after.ok, false);
  if (after.hung === false && after.ok === false) {
    assert.equal(after.error.name, "MlpInvalidWeights");
    assert.deepEqual(after.error.trackIds, ["A"]);
  }
});

test("(b) Age-typed track + empty ages: BEFORE hangs, AFTER completes with the BASE weight", () => {
  const before = runInChild("before", "age_track_empty_ages");
  assert.equal(before.hung, true, "pre-fix copy must hang (killed at timeout)");

  const out = generateFullMLP(cases.age_track_empty_ages);
  assert.equal(out.finalMLP.length, 2, "both pool items are selected");
  assert.deepEqual(out.debug.trackWeights, { A: 2, B: 1 }, "Age track keeps its base weight — no tilt");
  assert.deepEqual(out.debug.weightedSequence, ["A", "B", "A"]);
  assert.equal(out.debug.ageBracketDebug.totalAgeWeight, 0);
  assert.deepEqual(out.debug.ageFilter, { youngestAgeMonths: null, removedByAge: 0 });
  assert.deepEqual(out.finalMLP.map((i) => i.item_id), ["l1", "l2"]);
});

for (const name of identityCases) {
  test(`(c) ${name}: BEFORE == AFTER == snapshot (ranking byte-identical)`, () => {
    const expected = snapshot[name];
    assert.ok(expected, `snapshot missing case ${name} — regenerate from the pre-fix copy`);

    const before = runInChild("before", name);
    assert.equal(before.hung, false, "identity cases never hang");
    assert.ok(before.hung === false && before.ok, "pre-fix copy must complete");
    if (before.hung === false && before.ok) {
      assert.deepEqual(before.output, expected, "pre-fix output must equal the committed snapshot");
    }

    const after = generateFullMLP(cases[name]);
    // JSON round-trip so undefined-vs-absent cannot mask a difference either way.
    assert.deepEqual(JSON.parse(JSON.stringify(after)), expected, "fixed output must equal the snapshot");
    assert.deepEqual(
      after.finalMLP.map((i) => [i.position, i.item_type, i.item_id, i.track_weight]),
      expected.finalMLP.map((i) => [i.position, i.item_type, i.item_id, i.track_weight]),
      "item sequence and weights unchanged"
    );
  });
}

test("guard is a pure check: no Age track, no ages, all weights > 0 → no throw, base weights", () => {
  const out = generateFullMLP(cases.no_age_track_empty_ages);
  assert.ok(out.finalMLP.length > 0);
  for (const t of cases.no_age_track_empty_ages.tracks) {
    assert.equal(out.debug.trackWeights[t.track_id], t.weight ?? 1);
  }
});
