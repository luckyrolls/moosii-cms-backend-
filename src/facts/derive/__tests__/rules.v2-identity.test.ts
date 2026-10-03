// facts-derive/2 vs a FROZEN copy of /1: identical results for aggregated (non-manual) data; the manual Paycheck
// rule applies to is_manual transactions only. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveAll, isDirectDeposit, type MxAccount, type MxTransaction } from "../rules";
import { deriveAll as deriveAllV1 } from "./rules.v1.frozen";
import { rng } from "../../../demo/sarahData";

const CATS: [string, string][] = [
  ["Paycheck", "Income"], ["Groceries", "Food & Dining"], ["Transfer", "Transfer"], ["Television", "Bills & Utilities"], ["Gas", "Auto & Transport"],
];

// Random but deterministic aggregated data — every field the rules read, including CREDITs categorised Paycheck
// WITHOUT the flag (the case /2 must not reinterpret unless is_manual is true).
function aggregated(seed: number, isManual: "absent" | "false" | "null"): { accounts: MxAccount[]; transactions: MxTransaction[]; asOf: Date } {
  const r = rng(seed);
  const asOf = new Date(Date.UTC(2026, 8, 27, 16, 53, 12));
  const accounts: MxAccount[] = [
    { guid: "chk", type: "CHECKING", balance: Math.round(r() * 8000), available_balance: r() < 0.5 ? null : Math.round(r() * 8000) },
    { guid: "sav", type: "SAVINGS", balance: Math.round(r() * 5000), is_closed: r() < 0.1 },
    { guid: "cc", type: "CREDIT_CARD", balance: Math.round(r() * 3000), credit_limit: r() < 0.5 ? null : 5000, available_credit: Math.round(r() * 2000) },
  ];
  const transactions: MxTransaction[] = [];
  for (let i = 0; i < 400; i++) {
    const [category, top] = CATS[Math.floor(r() * CATS.length)];
    const t: MxTransaction = {
      guid: `t${i}`, account_guid: ["chk", "sav", "cc"][Math.floor(r() * 3)], type: r() < 0.3 ? "CREDIT" : "DEBIT",
      status: r() < 0.9 ? "POSTED" : "PENDING", amount: Math.round(r() * 50000) / 100,
      transacted_at: new Date(asOf.getTime() - Math.floor(r() * 120) * 86_400_000).toISOString(),
      is_direct_deposit: r() < 0.1, is_subscription: r() < 0.05, merchant_guid: r() < 0.5 ? `M${Math.floor(r() * 20)}` : null,
      description: `desc ${Math.floor(r() * 30)}`, top_level_category: top, category,
    };
    if (isManual === "false") t.is_manual = false;
    if (isManual === "null") t.is_manual = null;
    transactions.push(t);
  }
  return { accounts, transactions, asOf };
}

test("aggregated data: /2 is byte-identical to the frozen /1 (200 data sets x 3 is_manual shapes)", () => {
  for (let seed = 1; seed <= 200; seed++) {
    for (const shape of ["absent", "false", "null"] as const) {
      const input = aggregated(seed, shape);
      assert.equal(JSON.stringify(deriveAll(input)), JSON.stringify(deriveAllV1(input)), `seed ${seed} ${shape}`);
    }
  }
});

test("the manual Paycheck rule: only is_manual CREDITs categorised Paycheck", () => {
  const base: MxTransaction = { guid: "x", account_guid: "chk", type: "CREDIT", is_direct_deposit: false, category: "Paycheck" };
  assert.equal(isDirectDeposit({ ...base, is_manual: true }), true);
  assert.equal(isDirectDeposit({ ...base }), false);
  assert.equal(isDirectDeposit({ ...base, is_manual: false }), false);
  assert.equal(isDirectDeposit({ ...base, is_manual: true, type: "DEBIT" }), false);
  assert.equal(isDirectDeposit({ ...base, is_manual: true, category: "Transfer" }), false);
  assert.equal(isDirectDeposit({ ...base, is_direct_deposit: true, category: "Groceries" }), true);
});
