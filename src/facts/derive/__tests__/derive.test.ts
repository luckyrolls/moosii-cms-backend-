// derive_facts core with a fake MX provider and fake facts deps. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveFactsForUser, DeriveError, type DeriveDeps } from "../derive";
import type { FinancialDataProvider, MxMember } from "../mxProvider";
import type { MxAccount, MxTransaction } from "../rules";
import type { FactsDeps } from "../../service";
import type { FactRow } from "../../validate";
import { validateFactsBody } from "../../validate";

const USER = "19587e0a-bfe0-48e2-94a1-055a5bbc9584";
const AGG = "2026-09-27T16:53:12Z";

const VOCAB = new Map<string, Set<string>>([
  ["has_direct_deposit", new Set(["true", "false"])],
  ["has_emergency_buffer", new Set(["true", "false"])],
  ["new_subscription_recent", new Set(["true", "false"])],
  ["credit_utilization_band", new Set(["low", "moderate", "high"])],
]);

function accounts(): MxAccount[] {
  return [
    { guid: "chk", type: "CHECKING", balance: 5000 },
    { guid: "cc", type: "CREDIT_CARD", balance: 800, credit_limit: null, available_credit: 200 },
  ];
}

function transactions(): MxTransaction[] {
  const out: MxTransaction[] = [];
  const start = Date.parse("2026-06-29T12:00:00Z");
  for (let i = 0; i <= 90; i++) {
    const at = new Date(start + i * 86_400_000).toISOString();
    out.push({ guid: `d${i}`, account_guid: "chk", type: "DEBIT", status: "POSTED", amount: 30, transacted_at: at, is_direct_deposit: false, is_subscription: false, top_level_category: "Shopping" });
    if (i % 7 === 0) out.push({ guid: `p${i}`, account_guid: "chk", type: "CREDIT", status: "POSTED", amount: 900, transacted_at: at, is_direct_deposit: true, is_subscription: false, top_level_category: "Income" });
  }
  return out;
}

function fakeProvider(members: MxMember[], calls: string[] = []): FinancialDataProvider {
  return {
    async getMembers(u) { calls.push(`members:${u}`); return members; },
    async getAccounts(u) { calls.push(`accounts:${u}`); return accounts(); },
    async getTransactions(u, from) { calls.push(`transactions:${u}:${from}`); return transactions(); },
  };
}

function fakeFacts() {
  const table = new Map<string, FactRow>();
  const inserts: FactRow[][] = [];
  const enqueues: { userId: string; reason: string }[] = [];
  const deps: FactsDeps = {
    async loadVocabulary() { return { values: VOCAB }; },
    async findExisting() { return [...table.values()].map((r) => ({ fact_key: r.fact_key, value: r.value, observed_at: r.observed_at })); },
    async insertRows(rows) {
      inserts.push(rows);
      let written = 0;
      for (const r of rows) { const k = `${r.user_id}|${r.fact_key}|${r.observed_at}`; if (!table.has(k)) { table.set(k, r); written++; } }
      return { written };
    },
    async enqueueRebuild(userId, ctx) { enqueues.push({ userId, reason: ctx.reason }); return { enqueued: true, jobId: "rebuild-1" }; },
  };
  return { deps, table, inserts, enqueues };
}

const ctx = { jobId: "job-1", correlationId: "corr-1" };
const done: MxMember[] = [{ guid: "MBR-1", connection_status: "CONNECTED", is_being_aggregated: false, successfully_aggregated_at: AGG }];
const depsWith = (members: MxMember[], facts = fakeFacts(), calls: string[] = []): DeriveDeps => ({ domain: "financial", provider: () => fakeProvider(members, calls), facts: facts.deps });

test("happy path: four facts recorded at the aggregation instant, derived/estimated, source_ref job:<id>, rebuild enqueued", async () => {
  const f = fakeFacts();
  const calls: string[] = [];
  const r = await deriveFactsForUser({ user_id: USER }, ctx, depsWith(done, f, calls));
  assert.equal(r.observed_at, "2026-09-27T16:53:12.000Z");
  assert.equal(r.written, 4);
  assert.equal(r.rebuild_enqueued, true);
  assert.deepEqual(f.enqueues, [{ userId: USER, reason: "derive_facts" }]);
  assert.ok(calls.includes(`transactions:${USER}:2026-05-30`), "fetches 120 days before the aggregation");
  const rows = Object.fromEntries(f.inserts[0].map((x) => [x.fact_key, x]));
  assert.equal(rows.credit_utilization_band.value, "high");          // 800 / (800+200)
  assert.equal(rows.credit_utilization_band.source, "estimated");
  assert.equal(rows.has_direct_deposit.source, "derived");
  for (const x of f.inserts[0]) {
    assert.equal(x.source_ref, "job:job-1");
    assert.equal(x.observed_at, "2026-09-27T16:53:12.000Z");
  }
});

test("idempotent: a second run on the same aggregation writes nothing", async () => {
  const f = fakeFacts();
  await deriveFactsForUser({ user_id: USER }, ctx, depsWith(done, f));
  const again = await deriveFactsForUser({ user_id: USER }, { jobId: "job-2", correlationId: "c2" }, depsWith(done, f));
  assert.equal(again.written, 0);
  assert.equal(f.table.size, 4);
});

test("unknown facts write no row and are reported with a reason", async () => {
  const f = fakeFacts();
  const deps: DeriveDeps = {
    domain: "financial",
    facts: f.deps,
    provider: () => ({
      async getMembers() { return done; },
      async getAccounts() { return accounts().filter((a) => a.type !== "CREDIT_CARD"); },
      async getTransactions() { return transactions(); },
    }),
  };
  const r = await deriveFactsForUser({ user_id: USER }, ctx, deps);
  const cu = r.facts.find((x) => x.fact_key === "credit_utilization_band")!;
  assert.deepEqual([cu.status, cu.value, cu.reason, cu.source], ["unknown", null, "no_credit_card", null]);
  assert.equal(r.written, 3);
  assert.ok(!f.inserts[0].some((x) => x.fact_key === "credit_utilization_band"));
});

test("gates: domain, input, members, aggregation — each fails with a code and writes nothing", async () => {
  const f = fakeFacts();
  const cases: [DeriveDeps, unknown, string][] = [
    [{ ...depsWith(done, f), domain: "moosii" }, { user_id: USER }, "domain_not_supported"],
    [depsWith(done, f), { user_id: "not-a-uuid" }, "invalid_input"],
    [depsWith([], f), { user_id: USER }, "no_mx_members"],
    [depsWith([{ guid: "m", is_being_aggregated: true, successfully_aggregated_at: AGG }], f), { user_id: USER }, "aggregation_in_progress"],
    [depsWith([{ guid: "m", is_being_aggregated: false, successfully_aggregated_at: null }], f), { user_id: USER }, "never_aggregated"],
  ];
  for (const [deps, input, code] of cases) {
    await assert.rejects(deriveFactsForUser(input as { user_id?: unknown }, ctx, deps), (e: unknown) => e instanceof DeriveError && e.code === code, code);
  }
  assert.equal(f.inserts.length, 0);
});

test("observed_at is the LATEST successful aggregation across members", async () => {
  const f = fakeFacts();
  const members: MxMember[] = [
    { guid: "a", is_being_aggregated: false, successfully_aggregated_at: "2026-09-20T00:00:00Z" },
    { guid: "b", is_being_aggregated: false, successfully_aggregated_at: AGG },
  ];
  const r = await deriveFactsForUser({ user_id: USER }, ctx, depsWith(members, f));
  assert.equal(r.observed_at, "2026-09-27T16:53:12.000Z");
});

test("a different value at an already-recorded instant fails the job (409 surfaced), nothing written", async () => {
  const f = fakeFacts();
  f.table.set(`${USER}|credit_utilization_band|2026-09-27T16:53:12.000Z`, {
    user_id: USER, fact_key: "credit_utilization_band", value: "low", observed_at: "2026-09-27T16:53:12.000Z", source: "derived",
  });
  await assert.rejects(deriveFactsForUser({ user_id: USER }, ctx, depsWith(done, f)), (e: unknown) => e instanceof DeriveError && e.code === "conflicting_observation");
  assert.equal(f.inserts.length, 0);
});

test("partner route is unchanged: derived/estimated and source_ref are refused without internal", () => {
  const vocab = { values: VOCAB };
  const entry = { key: "has_direct_deposit", value: "true", observed_at: AGG };
  const derived = validateFactsBody({ user_id: USER, facts: [{ ...entry, source: "derived" }] }, vocab);
  assert.equal(derived.ok, false);
  assert.equal(!derived.ok && derived.code, "invalid_source");
  const ref = validateFactsBody({ user_id: USER, facts: [{ ...entry, source_ref: "job:1" }] }, vocab);
  assert.equal(!ref.ok && ref.code, "invalid_request");
  const internal = validateFactsBody({ user_id: USER, facts: [{ ...entry, source: "estimated", source_ref: "job:1" }] }, vocab, { internal: true });
  assert.ok(internal.ok && internal.rows[0].source === "estimated" && internal.rows[0].source_ref === "job:1");
});
