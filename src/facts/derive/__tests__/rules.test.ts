// Fact derivation rules on sandbox-shaped fixtures (FINDINGS-mx-sandbox §4.4). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveAll, deriveHasDirectDeposit, deriveHasEmergencyBuffer, deriveNewSubscriptionRecent,
  deriveCreditUtilizationBand, historyDays, type MxAccount, type MxTransaction, type DeriveInput,
} from "../rules";

const AS_OF = new Date("2026-09-27T16:53:12Z");
const day = (d: string) => `${d}T12:00:00Z`;
let n = 0;
const tx = (p: Partial<MxTransaction> & { account_guid: string; transacted_at: string }): MxTransaction => ({
  guid: `TRN-${++n}`, type: "DEBIT", status: "POSTED", amount: 20, is_direct_deposit: false, is_subscription: false,
  merchant_guid: null, description: "x", top_level_category: "Shopping", ...p,
});

// The mxbank shape seen 2026-09-27: 6 accounts, credit card WITHOUT credit_limit.
function sandboxAccounts(): MxAccount[] {
  return [
    { guid: "ACT-chk", type: "CHECKING", balance: 491844.63, available_balance: null },
    { guid: "ACT-sav", type: "SAVINGS", balance: 506398.85, available_balance: null },
    { guid: "ACT-cc", type: "CREDIT_CARD", balance: 8356.55, credit_limit: null, available_credit: 3000 },
    { guid: "ACT-loan", type: "LOAN", balance: 14587.8 },
    { guid: "ACT-mort", type: "MORTGAGE", balance: 10078.13 },
    { guid: "ACT-inv", type: "INVESTMENT", balance: 10000 },
  ];
}

// ~90 days (06-29 → 09-27): paycheck every 5 days, ordinary spend, transfers, Netflix first seen 07-04.
function sandboxTransactions(): MxTransaction[] {
  const out: MxTransaction[] = [];
  const start = Date.parse("2026-06-29T12:00:00Z");
  for (let i = 0; i <= 90; i++) {
    const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    out.push(tx({ account_guid: "ACT-chk", transacted_at: day(d), amount: 35, top_level_category: "Food & Dining" }));
    if (i % 5 === 1) out.push(tx({ account_guid: "ACT-chk", transacted_at: day(d), type: "CREDIT", amount: 60, is_direct_deposit: true, top_level_category: "Income" }));
    if (i % 3 === 0) out.push(tx({ account_guid: "ACT-chk", transacted_at: day(d), amount: 500, top_level_category: "Transfer" }));
  }
  for (const d of ["2026-07-04", "2026-07-09", "2026-09-18"]) {
    out.push(tx({ account_guid: "ACT-chk", transacted_at: day(d), amount: 22.49, is_subscription: true, merchant_guid: "MCH-netflix", top_level_category: "Bills & Utilities" }));
  }
  return out;
}

const sandbox = (): DeriveInput => ({ accounts: sandboxAccounts(), transactions: sandboxTransactions(), asOf: AS_OF });

test("sandbox shape → true / true / false / high (estimated) — the expected demo outcome", () => {
  const r = Object.fromEntries(deriveAll(sandbox()).map((f) => [f.fact_key, f]));
  assert.equal(r.has_direct_deposit.value, "true");
  assert.equal(r.has_emergency_buffer.value, "true");
  assert.equal(r.new_subscription_recent.value, "false");
  assert.equal(r.credit_utilization_band.value, "high");
  assert.equal(r.credit_utilization_band.estimated, true);
  assert.equal(r.credit_utilization_band.reason, "limit_estimated");
  for (const f of Object.values(r)) if (f.fact_key !== "credit_utilization_band") assert.equal(f.estimated, false);
});

test("evidence never carries money: only integer counts and day spans", () => {
  for (const f of deriveAll(sandbox())) {
    for (const [k, v] of Object.entries(f.evidence)) {
      assert.ok(Number.isInteger(v), `${f.fact_key}.${k} = ${v} is not an integer count`);
      assert.doesNotMatch(k, /amount|balance|limit_value|spend|util|ratio|liquid/i, `${f.fact_key}.${k} looks like money`);
    }
  }
});

test("historyDays: span of posted transactions", () => {
  assert.equal(historyDays(sandboxTransactions()), 90);
  assert.equal(historyDays([]), 0);
});

// ---- has_direct_deposit ----
test("direct deposit: one deposit in 60 days → false; two distinct dates → true", () => {
  const base = sandboxTransactions().filter((t) => !t.is_direct_deposit);
  const one = [...base, tx({ account_guid: "ACT-chk", transacted_at: day("2026-09-20"), type: "CREDIT", is_direct_deposit: true })];
  assert.equal(deriveHasDirectDeposit({ ...sandbox(), transactions: one }).value, "false");
  const sameDay = [...one, tx({ account_guid: "ACT-chk", transacted_at: day("2026-09-20"), type: "CREDIT", is_direct_deposit: true })];
  assert.equal(deriveHasDirectDeposit({ ...sandbox(), transactions: sameDay }).value, "false", "two deposits on ONE date are not recurring");
  const two = [...one, tx({ account_guid: "ACT-chk", transacted_at: day("2026-09-06"), type: "CREDIT", is_direct_deposit: true })];
  assert.equal(deriveHasDirectDeposit({ ...sandbox(), transactions: two }).value, "true");
});

test("direct deposit: deposits older than 60 days don't count", () => {
  const base = sandboxTransactions().filter((t) => !t.is_direct_deposit);
  const old = [...base, ...["2026-07-01", "2026-07-15"].map((d) => tx({ account_guid: "ACT-chk", transacted_at: day(d), type: "CREDIT", is_direct_deposit: true }))];
  assert.equal(deriveHasDirectDeposit({ ...sandbox(), transactions: old }).value, "false");
});

test("direct deposit unknown: no deposit account / short history / flag never supplied", () => {
  const noDeposit = { ...sandbox(), accounts: sandboxAccounts().filter((a) => a.type !== "CHECKING" && a.type !== "SAVINGS") };
  assert.deepEqual([deriveHasDirectDeposit(noDeposit).value, deriveHasDirectDeposit(noDeposit).reason], [null, "no_deposit_account"]);
  const short = { ...sandbox(), transactions: sandboxTransactions().filter((t) => t.transacted_at! >= "2026-08-15") };
  assert.equal(deriveHasDirectDeposit(short).reason, "history_too_short");
  const noFlag = { ...sandbox(), transactions: sandboxTransactions().map((t) => ({ ...t, is_direct_deposit: null })) };
  assert.equal(deriveHasDirectDeposit(noFlag).reason, "flag_unavailable");
});

// ---- has_emergency_buffer ----
test("buffer: liquid below one month of spend → false; transfers are excluded from spend", () => {
  // spend ≈ 35/day ≈ 1,050/month; transfers (500 every 3 days) would add ~5,000 if counted.
  const accounts = sandboxAccounts().map((a) => (a.type === "CHECKING" ? { ...a, balance: 1500 } : a.type === "SAVINGS" ? { ...a, balance: 0 } : a));
  assert.equal(deriveHasEmergencyBuffer({ ...sandbox(), accounts }).value, "true", "1,500 covers ~1,050 of real spend");
  const poorer = accounts.map((a) => (a.type === "CHECKING" ? { ...a, balance: 900 } : a));
  assert.equal(deriveHasEmergencyBuffer({ ...sandbox(), accounts: poorer }).value, "false");
});

test("buffer: available_balance is preferred over balance; closed accounts ignored", () => {
  const accounts = sandboxAccounts().map((a) =>
    a.type === "CHECKING" ? { ...a, balance: 999999, available_balance: 100 } : a.type === "SAVINGS" ? { ...a, is_closed: true } : a);
  assert.equal(deriveHasEmergencyBuffer({ ...sandbox(), accounts }).value, "false");
});

test("buffer unknown: no spend to measure / no balances", () => {
  const onlyTransfers = { ...sandbox(), transactions: sandboxTransactions().map((t) => ({ ...t, top_level_category: "Transfer" })) };
  assert.equal(deriveHasEmergencyBuffer(onlyTransfers).reason, "no_spend_to_measure");
  const noBal = { ...sandbox(), accounts: sandboxAccounts().map((a) => (a.type === "CHECKING" || a.type === "SAVINGS" ? { ...a, balance: null } : a)) };
  assert.equal(deriveHasEmergencyBuffer(noBal).reason, "balance_unavailable");
});

// ---- new_subscription_recent ----
test("subscription: a merchant first seen within 30 days → true; seen before → false", () => {
  assert.equal(deriveNewSubscriptionRecent(sandbox()).value, "false", "Netflix first seen 07-04");
  const withNew = [...sandboxTransactions(), tx({ account_guid: "ACT-cc", transacted_at: day("2026-09-10"), is_subscription: true, merchant_guid: "MCH-new" })];
  const r = deriveNewSubscriptionRecent({ ...sandbox(), transactions: withNew });
  assert.equal(r.value, "true");
  assert.equal(r.evidence.new_merchants_30d, 1);
});

test("subscription: falls back to description when merchant_guid is missing", () => {
  const t = [...sandboxTransactions(),
    tx({ account_guid: "ACT-chk", transacted_at: day("2026-07-05"), is_subscription: true, description: "Gym Plus" }),
    tx({ account_guid: "ACT-chk", transacted_at: day("2026-09-05"), is_subscription: true, description: "  gym plus " })];
  assert.equal(deriveNewSubscriptionRecent({ ...sandbox(), transactions: t }).value, "false", "same description = same merchant, first seen 07-05");
});

test("subscription unknown: history under 90 days / flag never supplied", () => {
  const short = { ...sandbox(), transactions: sandboxTransactions().filter((t) => t.transacted_at! >= "2026-07-15") };
  assert.equal(deriveNewSubscriptionRecent(short).reason, "history_too_short");
  const noFlag = { ...sandbox(), transactions: sandboxTransactions().map((t) => ({ ...t, is_subscription: null })) };
  assert.equal(deriveNewSubscriptionRecent(noFlag).reason, "flag_unavailable");
});

// ---- credit_utilization_band ----
const withCard = (cards: MxAccount[]): DeriveInput => ({ ...sandbox(), accounts: [...sandboxAccounts().filter((a) => a.type !== "CREDIT_CARD"), ...cards] });

test("utilization bands at the edges: <20 low, 20–<30 moderate, ≥30 high (reported limit)", () => {
  const band = (bal: number) => deriveCreditUtilizationBand(withCard([{ guid: "c", type: "CREDIT_CARD", balance: bal, credit_limit: 1000 }]));
  assert.equal(band(199.99).value, "low");
  assert.equal(band(200).value, "moderate");
  assert.equal(band(299.99).value, "moderate");
  assert.equal(band(300).value, "high");
  assert.equal(band(300).estimated, false);
  assert.equal(band(300).reason, "limit_reported");
});

test("utilization: credit_limit wins over available_credit; estimate only when absent", () => {
  const reported = deriveCreditUtilizationBand(withCard([{ guid: "c", type: "CREDIT_CARD", balance: 100, credit_limit: 1000, available_credit: 50 }]));
  assert.deepEqual([reported.value, reported.estimated], ["low", false]);
  const est = deriveCreditUtilizationBand(withCard([{ guid: "c", type: "CREDIT_CARD", balance: 100, credit_limit: null, available_credit: 900 }]));
  assert.deepEqual([est.value, est.estimated, est.evidence.estimated_limits], ["low", true, 1]);
});

test("utilization: total across cards; one estimated card marks the fact estimated", () => {
  const r = deriveCreditUtilizationBand(withCard([
    { guid: "a", type: "CREDIT_CARD", balance: 100, credit_limit: 1000 },
    { guid: "b", type: "CREDIT_CARD", balance: 400, credit_limit: 0, available_credit: 600 },
  ]));
  assert.deepEqual([r.value, r.estimated, r.evidence.cards], ["moderate", true, 2]);   // 500 / 2000 = 25%
});

test("utilization: a card in credit counts as zero owed", () => {
  const r = deriveCreditUtilizationBand(withCard([{ guid: "c", type: "CREDIT_CARD", balance: -50, credit_limit: 1000 }]));
  assert.equal(r.value, "low");
});

test("utilization unknown: no card / no balance / no way to find the limit", () => {
  assert.equal(deriveCreditUtilizationBand(withCard([])).reason, "no_credit_card");
  assert.equal(deriveCreditUtilizationBand(withCard([{ guid: "c", type: "CREDIT_CARD", balance: null, credit_limit: 1000 }])).reason, "card_balance_unavailable");
  assert.equal(deriveCreditUtilizationBand(withCard([{ guid: "c", type: "CREDIT_CARD", balance: 10, credit_limit: null, available_credit: null }])).reason, "limit_unavailable");
  assert.equal(deriveCreditUtilizationBand(withCard([{ guid: "c", type: "CREDIT_CARD", balance: 10, credit_limit: 1000, is_closed: true }])).reason, "no_credit_card");
});
