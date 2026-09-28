// seed_facts core with fake deps (api-contract §8e). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { seedFactsForUser, SeedError, type SeedDeps, type LatestFact } from "../seed";
import type { FactsDeps } from "../service";
import type { FactRow } from "../validate";

const SARAH = "ad6910ab-854b-480b-8fbb-df78ac9147d3";
const NOW = new Date("2026-09-28T18:00:00Z");
const VOCAB = new Map([
  ["has_direct_deposit", new Set(["true", "false"])],
  ["has_emergency_buffer", new Set(["true", "false"])],
]);
const FACTS = [{ key: "has_direct_deposit", value: "true" }, { key: "has_emergency_buffer", value: "false" }];

function fakes(opts: { persona?: string | null; latest?: LatestFact[] } = {}) {
  const inserts: FactRow[][] = [];
  const enqueues: string[] = [];
  const facts: FactsDeps = {
    async loadVocabulary() { return { values: VOCAB }; },
    async findExisting() { return []; },
    async insertRows(rows) { inserts.push(rows); return { written: rows.length }; },
    async enqueueRebuild(_u, ctx) { enqueues.push(ctx.reason); return { enqueued: true }; },
  };
  const deps: SeedDeps = {
    domain: "financial",
    facts,
    now: () => NOW,
    async demoPersonaOf() { return opts.persona === undefined ? "sarah" : opts.persona; },
    async latestFacts() { return opts.latest ?? []; },
  };
  return { deps, inserts, enqueues };
}

test("seeds with source 'seed' and source_ref 'demo-seed', enqueues the rebuild", async () => {
  const f = fakes();
  const r = await seedFactsForUser({ user_id: SARAH, facts: FACTS }, { correlationId: "c" }, f.deps);
  assert.equal(r.written, 2);
  assert.equal(r.demo_persona, "sarah");
  assert.deepEqual(f.enqueues, ["seed_facts"]);
  for (const row of f.inserts[0]) {
    assert.equal(row.source, "seed");
    assert.equal(row.source_ref, "demo-seed");
    assert.equal(row.observed_at, NOW.toISOString());
  }
});

test("re-run writes nothing: keys already seeded with the same value are skipped", async () => {
  const f = fakes({ latest: [
    { fact_key: "has_direct_deposit", value: "true", source: "seed" },
    { fact_key: "has_emergency_buffer", value: "false", source: "seed" },
  ] });
  const r = await seedFactsForUser({ user_id: SARAH, facts: FACTS }, { correlationId: "c" }, f.deps);
  assert.equal(r.written, 0);
  assert.equal(r.rebuild_enqueued, false);
  assert.equal(f.inserts.length, 0);
  assert.deepEqual(r.facts.map((x) => x.status), ["unchanged", "unchanged"]);
});

test("a changed value, or the same value from a non-seed source, is written", async () => {
  const f = fakes({ latest: [
    { fact_key: "has_direct_deposit", value: "true", source: "derived" },
    { fact_key: "has_emergency_buffer", value: "true", source: "seed" },
  ] });
  const r = await seedFactsForUser({ user_id: SARAH, facts: FACTS }, { correlationId: "c" }, f.deps);
  assert.equal(r.written, 2);
});

test("refuses a user without app_metadata.demo_persona — nothing written", async () => {
  const f = fakes({ persona: null });
  await assert.rejects(seedFactsForUser({ user_id: SARAH, facts: FACTS }, { correlationId: "c" }, f.deps),
    (e: unknown) => e instanceof SeedError && e.code === "not_demo_user");
  assert.equal(f.inserts.length, 0);
});

test("gates: domain, user_id, facts shape", async () => {
  const f = fakes();
  const cases: [SeedDeps, unknown, string][] = [
    [{ ...f.deps, domain: "moosii" }, { user_id: SARAH, facts: FACTS }, "domain_not_supported"],
    [f.deps, { user_id: "nope", facts: FACTS }, "invalid_input"],
    [f.deps, { user_id: SARAH, facts: [] }, "invalid_input"],
    [f.deps, { user_id: SARAH, facts: [{ key: "has_direct_deposit" }] }, "invalid_input"],
  ];
  for (const [deps, input, code] of cases) {
    await assert.rejects(seedFactsForUser(input as never, { correlationId: "c" }, deps), (e: unknown) => e instanceof SeedError && e.code === code, code);
  }
  assert.equal(f.inserts.length, 0);
});

test("vocabulary still applies: an unknown value is refused by recordFacts", async () => {
  const f = fakes();
  await assert.rejects(seedFactsForUser({ user_id: SARAH, facts: [{ key: "has_direct_deposit", value: "maybe" }] }, { correlationId: "c" }, f.deps),
    (e: unknown) => e instanceof SeedError && e.code === "unknown_fact");
});
