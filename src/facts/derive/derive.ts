import { recordFacts, type FactsDeps } from "../service";
import { isUuid } from "../validate";
import { deriveAll, historyDays, RULE_VERSION, type FactResult, type MxAccount, type MxTransaction } from "./rules";
import type { FinancialDataProvider } from "./mxProvider";

// derive_facts core (FINDINGS-fact-derivation §4). Everything external is INJECTED so the gates and
// the write path are unit-tested with fakes; the job handler wires the real deps.
//
// observed_at = the latest successfully_aggregated_at across the user's MX members: the instant the
// data describes, and the idempotency key — re-running on the same aggregation writes nothing, and a
// rule change that yields a DIFFERENT value for the same aggregation is refused (409 → job fails).
//
// MANUAL-ONLY users (2026-10-03, facts-derive/2): accounts we created via the MX API have no member that
// GET /members lists and no aggregation time. Such a user is derived anyway when it has manual accounts;
// observed_at = the latest manual transaction's date, so re-running on unchanged data writes nothing.

export const HISTORY_FETCH_DAYS = 120;
export const MANUAL_LOOKBACK_DAYS = 365;   // how far back to look for the latest manual transaction

const DAY_MS = 86_400_000;

function txTime(t: MxTransaction): number | null {
  const raw = t.transacted_at ?? t.posted_at ?? t.date ?? null;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

export type DeriveDeps = {
  domain: string;
  provider: () => FinancialDataProvider;   // lazy: a missing MX key fails the job, not the import
  facts: FactsDeps;
};

export type DerivedFactReport = FactResult & { status: "recorded" | "unknown"; source: "derived" | "estimated" | null };

export type DeriveFactsResult = {
  rule_version: string;
  user_id: string;
  observed_at: string;
  basis: "aggregation" | "manual";
  members: number;
  accounts: number;
  transactions: number;
  history_days: number;
  facts: DerivedFactReport[];
  written: number;
  rebuild_enqueued: boolean;
};

export class DeriveError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "DeriveError";
  }
}

export async function deriveFactsForUser(
  input: { user_id?: unknown },
  ctx: { jobId: string; correlationId: string },
  deps: DeriveDeps,
): Promise<DeriveFactsResult> {
  if (deps.domain !== "financial") throw new DeriveError("domain_not_supported", `derive_facts runs on the financial deployment only (DOMAIN=${deps.domain})`);
  if (!isUuid(input.user_id)) throw new DeriveError("invalid_input", "input.user_id is required and must be a uuid");
  const userId = input.user_id;
  const provider = deps.provider();

  const members = await provider.getMembers(userId);
  let observedMs: number;
  let accounts: MxAccount[];
  let transactions: MxTransaction[];
  let basis: "aggregation" | "manual";
  if (members.length === 0) {
    // Manual-only user: derive from the accounts/transactions we created, if any.
    accounts = await provider.getAccounts(userId);
    if (!accounts.some((a) => a.is_manual === true)) throw new DeriveError("no_mx_members", `MX user ${userId} has no connected institutions`);
    const fetched = await provider.getTransactions(userId, new Date(Date.now() - MANUAL_LOOKBACK_DAYS * DAY_MS));
    const manualTimes = fetched.filter((t) => t.is_manual === true).map(txTime).filter((x): x is number => x !== null);
    if (manualTimes.length === 0) throw new DeriveError("no_manual_transactions", `MX user ${userId} has manual accounts but no dated manual transactions`);
    observedMs = Math.max(...manualTimes);
    const from = observedMs - HISTORY_FETCH_DAYS * DAY_MS;
    transactions = fetched.filter((t) => { const ms = txTime(t); return ms !== null && ms >= from && ms <= observedMs; });
    basis = "manual";
  } else {
    if (members.some((m) => m.is_being_aggregated)) throw new DeriveError("aggregation_in_progress", "an MX member is still aggregating — retry when it finishes");
    const stamps = members.map((m) => m.successfully_aggregated_at).filter((s): s is string => !!s && !Number.isNaN(Date.parse(s)));
    if (stamps.length === 0) throw new DeriveError("never_aggregated", "no member has a successful aggregation yet");
    observedMs = Math.max(...stamps.map((s) => Date.parse(s)));
    const from = new Date(observedMs - HISTORY_FETCH_DAYS * DAY_MS);
    [accounts, transactions] = await Promise.all([provider.getAccounts(userId), provider.getTransactions(userId, from)]);
    basis = "aggregation";
  }
  const observedAt = new Date(observedMs).toISOString();

  const results = deriveAll({ accounts, transactions, asOf: new Date(observedMs) });
  const toWrite = results.filter((r) => r.value !== null);

  let written = 0;
  let rebuildEnqueued = false;
  if (toWrite.length > 0) {
    const outcome = await recordFacts(
      {
        user_id: userId,
        facts: toWrite.map((r) => ({
          key: r.fact_key,
          value: r.value,
          observed_at: observedAt,
          source: r.estimated ? "estimated" : "derived",
          source_ref: `job:${ctx.jobId}`,
        })),
      },
      deps.facts,
      ctx.correlationId,
      { internal: true, reason: "derive_facts" },
    );
    if (outcome.status !== 200) throw new DeriveError(outcome.code, outcome.message);
    written = outcome.body.written;
    rebuildEnqueued = outcome.body.rebuild_enqueued;
  }

  return {
    rule_version: RULE_VERSION,
    user_id: userId,
    observed_at: observedAt,
    basis,
    members: members.length,
    accounts: accounts.length,
    transactions: transactions.length,
    history_days: historyDays(transactions),
    facts: results.map((r) => ({
      ...r,
      status: r.value === null ? "unknown" : "recorded",
      source: r.value === null ? null : r.estimated ? "estimated" : "derived",
    })),
    written,
    rebuild_enqueued: rebuildEnqueued,
  };
}
