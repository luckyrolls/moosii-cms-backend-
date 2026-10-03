// Sarah's generated MX data (src/demo/sarahData.ts): deterministic, dated to today, the agreed shape. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sarahPlan, planSummary, TOP_LEVEL, SARAH_HISTORY_DAYS } from "../sarahData";
import { summarizeSpending } from "../partner";

const TODAY = new Date("2026-10-03T15:00:00Z");

test("deterministic: same day + seed → identical plan; another day shifts the dates", () => {
  assert.equal(JSON.stringify(sarahPlan(TODAY)), JSON.stringify(sarahPlan(new Date("2026-10-03T01:00:00Z"))));
  assert.notEqual(sarahPlan(TODAY).transactions.at(-1)!.date, sarahPlan(new Date("2026-11-20T12:00:00Z")).transactions.at(-1)!.date);
});

test("dated within the 120 days ending today; the last-30-days view is populated", () => {
  const p = sarahPlan(TODAY);
  assert.ok(Date.parse(p.transactions[0].date) >= Date.parse("2026-10-03") - (SARAH_HISTORY_DAYS - 1) * 86_400_000);
  assert.ok(Date.parse(p.transactions.at(-1)!.date) <= Date.parse("2026-10-03"));
  const view = summarizeSpending(p.transactions.map((t) => ({ ...t, top_level_category: t.top_level, transacted_at: `${t.date}T12:00:00Z` })), TODAY);
  assert.ok(view.total > 0 && view.categories.length >= 5);
});

test("shape: checking 640 / savings 150, paycheck 1,650 every 14 days, rent 1,400, car 320, insurance 140, no card", () => {
  const p = sarahPlan(TODAY);
  assert.deepEqual(p.accounts.map((a) => [a.account_type, a.balance]), [["CHECKING", 640], ["SAVINGS", 150]]);
  const pay = p.transactions.filter((t) => t.category === "Paycheck");
  assert.ok(pay.length >= 8 && pay.every((t) => t.amount === 1650 && t.type === "CREDIT" && t.account === "checking"));
  for (let i = 1; i < pay.length; i++) assert.equal((Date.parse(pay[i].date) - Date.parse(pay[i - 1].date)) / 86_400_000, 14);
  for (const [cat, amt] of [["Mortgage & Rent", 1400], ["Auto Payment", 320], ["Auto Insurance", 140]] as const) {
    assert.ok(p.transactions.some((t) => t.category === cat && t.amount === amt), cat);
  }
  assert.ok(p.transactions.every((t) => TOP_LEVEL[t.category] === t.top_level));
});

test("monthly spend is roughly 90% of income", () => {
  const s = planSummary(sarahPlan(TODAY));
  assert.ok(s.ratio >= 0.85 && s.ratio <= 0.95, String(s.ratio));
});
