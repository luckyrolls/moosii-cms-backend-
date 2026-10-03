// derive_facts for MANUAL-ONLY MX users (facts-derive/2). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveFactsForUser, DeriveError, type DeriveDeps } from "../derive";
import type { FinancialDataProvider, MxMember } from "../mxProvider";
import type { FactsDeps } from "../../service";
import type { FactRow } from "../../validate";
import { sarahPlan } from "../../../demo/sarahData";

const USER = "ad6910ab-854b-480b-8fbb-df78ac9147d3";
const VOCAB = new Map<string, Set<string>>([
  ["has_direct_deposit", new Set(["true", "false"])],
  ["has_emergency_buffer", new Set(["true", "false"])],
  ["new_subscription_recent", new Set(["true", "false"])],
  ["credit_utilization_band", new Set(["low", "moderate", "high"])],
]);

function fakeFacts() {
  const table = new Map<string, FactRow>();
  const inserts: FactRow[][] = [];
  const deps: FactsDeps = {
    async loadVocabulary() { return { values: VOCAB }; },
    async findExisting() { return [...table.values()].map((r) => ({ fact_key: r.fact_key, value: r.value, observed_at: r.observed_at })); },
    async insertRows(rows) {
      inserts.push(rows);
      let written = 0;
      for (const r of rows) { const k = `${r.user_id}|${r.fact_key}|${r.observed_at}`; if (!table.has(k)) { table.set(k, r); written++; } }
      return { written };
    },
    async enqueueRebuild() { return { enqueued: true, jobId: "rebuild-1" }; },
  };
  return { deps, inserts };
}

// Sarah's generated plan as MX returns manual data: no members, is_manual, flags forced false, status null.
function manualProvider(opts: { manualAccounts?: boolean; txns?: boolean; members?: MxMember[] } = {}): FinancialDataProvider {
  const plan = sarahPlan(new Date("2026-10-03T15:00:00Z"));
  return {
    async getMembers() { return opts.members ?? []; },
    async getAccounts() {
      return plan.accounts.map((a) => ({ guid: a.key, type: a.account_type, balance: a.balance, is_manual: opts.manualAccounts ?? true }));
    },
    async getTransactions() {
      if (opts.txns === false) return [];
      return plan.transactions.map((t, i) => ({
        guid: `t${i}`, account_guid: t.account, type: t.type, status: null, amount: t.amount, date: t.date,
        transacted_at: `${t.date}T12:00:00Z`, is_direct_deposit: false, is_subscription: false,
        top_level_category: t.top_level, category: t.category, is_manual: true,
      }));
    },
  };
}

const ctx = { jobId: "job-1", correlationId: "corr-1" };
const deps = (f: ReturnType<typeof fakeFacts>, p: FinancialDataProvider): DeriveDeps => ({ domain: "financial", facts: f.deps, provider: () => p });

test("manual-only user is derived anyway; observed_at = latest manual transaction; Sarah's story", async () => {
  const f = fakeFacts();
  const r = await deriveFactsForUser({ user_id: USER }, ctx, deps(f, manualProvider()));
  assert.equal(r.basis, "manual");
  assert.equal(r.members, 0);
  assert.equal(r.observed_at, "2026-10-02T12:00:00.000Z");
  assert.deepEqual(Object.fromEntries(r.facts.map((x) => [x.fact_key, x.value])), {
    has_direct_deposit: "true", has_emergency_buffer: "false", new_subscription_recent: "false", credit_utilization_band: null,
  });
  assert.equal(r.written, 3);
  assert.ok(f.inserts[0].every((x) => x.source === "derived" && x.observed_at === "2026-10-02T12:00:00.000Z"));
});

test("manual-only user: re-running on unchanged data writes nothing", async () => {
  const f = fakeFacts();
  await deriveFactsForUser({ user_id: USER }, ctx, deps(f, manualProvider()));
  const again = await deriveFactsForUser({ user_id: USER }, { jobId: "job-2", correlationId: "c2" }, deps(f, manualProvider()));
  assert.equal(again.written, 0);
});

test("gates: no members and no manual accounts → no_mx_members; manual accounts, no transactions → no_manual_transactions", async () => {
  const f = fakeFacts();
  await assert.rejects(deriveFactsForUser({ user_id: USER }, ctx, deps(f, manualProvider({ manualAccounts: false }))),
    (e: unknown) => e instanceof DeriveError && e.code === "no_mx_members");
  await assert.rejects(deriveFactsForUser({ user_id: USER }, ctx, deps(f, manualProvider({ txns: false }))),
    (e: unknown) => e instanceof DeriveError && e.code === "no_manual_transactions");
  assert.equal(f.inserts.length, 0);
});

test("a user WITH members stays on the aggregation path", async () => {
  const f = fakeFacts();
  const members: MxMember[] = [{ guid: "MBR-1", is_being_aggregated: false, successfully_aggregated_at: "2026-10-02T20:00:00Z" }];
  const r = await deriveFactsForUser({ user_id: USER }, ctx, deps(f, manualProvider({ members })));
  assert.equal(r.basis, "aggregation");
  assert.equal(r.observed_at, "2026-10-02T20:00:00.000Z");
});
