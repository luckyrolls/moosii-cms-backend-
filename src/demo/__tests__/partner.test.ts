// Demo partner page (api-contract §9c): gates, spending summary, insight rules, widget allowlist. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  demoGate, isRefusal, bearerToken, summarizeSpending, insightsFromFacts, allowedWidgetType, type GateDeps,
} from "../partner";

const SAM = "19587e0a-bfe0-48e2-94a1-055a5bbc9584";
const USERS: Record<string, { user_id: string; persona: string | null }> = {
  "tok-sam": { user_id: SAM, persona: "sam" },
  "tok-plain": { user_id: "00000000-0000-4000-8000-000000000009", persona: null },
};

function deps(over: Partial<GateDeps> = {}) {
  const verified: string[] = [];
  const d: GateDeps = {
    domain: "financial",
    limiter: { allow: () => true },
    async verify(t) { verified.push(t); return USERS[t] ?? null; },
    ...over,
  };
  return { d, verified };
}

test("gate: 404 off financial, before the token is even looked at", async () => {
  const { d, verified } = deps({ domain: "moosii" });
  const out = await demoGate("Bearer tok-sam", "ip", d);
  assert.ok(isRefusal(out) && out.status === 404);
  assert.deepEqual(verified, []);
});

test("gate: 429 when rate-limited, before verifying", async () => {
  const { d, verified } = deps({ limiter: { allow: () => false } });
  const out = await demoGate("Bearer tok-sam", "ip", d);
  assert.ok(isRefusal(out) && out.status === 429);
  assert.deepEqual(verified, []);
});

test("gate: 401 without a bearer token or with an invalid one", async () => {
  for (const h of [undefined, "", "tok-sam", "Basic abc", "Bearer"]) {
    const out = await demoGate(h, "ip", deps().d);
    assert.ok(isRefusal(out) && out.status === 401, String(h));
  }
  const bad = await demoGate("Bearer nope", "ip", deps().d);
  assert.ok(isRefusal(bad) && bad.status === 401);
});

test("gate: 403 for a signed-in user who is not a demo persona; identity from the token for a persona", async () => {
  const plain = await demoGate("Bearer tok-plain", "ip", deps().d);
  assert.ok(isRefusal(plain) && plain.status === 403 && plain.code === "not_demo_persona");
  const sam = await demoGate("bearer tok-sam", "ip", deps().d);
  assert.deepEqual(sam, { user_id: SAM, persona: "sam" });
  assert.equal(bearerToken("Bearer  abc "), "abc");
});

test("spending: last-30-day DEBITs by top-level category; credits, transfers and older rows excluded", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const s = summarizeSpending([
    { type: "DEBIT", amount: 60, top_level_category: "Food & Dining", transacted_at: "2026-09-25T00:00:00Z" },
    { type: "DEBIT", amount: 40, top_level_category: "Food & Dining", transacted_at: "2026-09-10T00:00:00Z" },
    { type: "DEBIT", amount: 100, top_level_category: "Bills & Utilities", date: "2026-09-15" },
    { type: "DEBIT", amount: 500, top_level_category: "Transfer", transacted_at: "2026-09-20T00:00:00Z" },
    { type: "CREDIT", amount: 2000, top_level_category: "Income", transacted_at: "2026-09-20T00:00:00Z" },
    { type: "DEBIT", amount: 999, top_level_category: "Shopping", transacted_at: "2026-08-15T00:00:00Z" },
    { type: "DEBIT", amount: 0.333, top_level_category: null, transacted_at: "2026-09-30T00:00:00Z" },
  ], now);
  assert.equal(s.source, "mx");
  assert.equal(s.from, "2026-09-01");
  assert.equal(s.to, "2026-10-01");
  assert.equal(s.transactions, 4);
  assert.equal(s.total, 200.33);
  assert.deepEqual(s.categories.map((c) => [c.category, c.amount]), [
    ["Bills & Utilities", 100], ["Food & Dining", 100], ["Uncategorized", 0.33],
  ]);
  assert.equal(s.categories[0].share, 0.499);
});

test("spending: no transactions → empty categories, total 0", () => {
  const s = summarizeSpending([], new Date("2026-10-01T00:00:00Z"));
  assert.deepEqual([s.total, s.transactions, s.categories.length], [0, 0, 0]);
});

test("insights come from current facts, tagged by provenance; no amounts in the copy", () => {
  const sam = insightsFromFacts([
    { fact_key: "credit_utilization_band", value: "high", source: "estimated" },
    { fact_key: "has_emergency_buffer", value: "true", source: "derived" },
    { fact_key: "new_subscription_recent", value: "false", source: "derived" },
    { fact_key: "has_direct_deposit", value: "true", source: "derived" },
  ]);
  assert.deepEqual(sam.map((i) => [i.key, i.source]), [["CreditCardCloseToLimit", "real"]]);

  const sarah = insightsFromFacts([
    { fact_key: "has_emergency_buffer", value: "false", source: "seed" },
    { fact_key: "has_direct_deposit", value: "true", source: "seed" },
  ]);
  assert.deepEqual(sarah.map((i) => [i.key, i.source]), [["SaveEnoughToLiveOn", "seeded"]]);

  const all = insightsFromFacts([
    { fact_key: "credit_utilization_band", value: "moderate", source: "platform_api" },
    { fact_key: "new_subscription_recent", value: "true", source: "derived" },
  ]);
  assert.deepEqual(all.map((i) => i.key), ["CreditUtilization", "SubscriptionDetected"]);
  for (const i of [...sam, ...sarah, ...all]) assert.doesNotMatch(`${i.title} ${i.body}`, /[0-9$%]/);
  assert.deepEqual(insightsFromFacts([]), []);
});

test("widget allowlist: only connections_widget", () => {
  assert.equal(allowedWidgetType("connections_widget"), "connections_widget");
  for (const t of ["connect_widget", "spending_widget", "pulse_widget", "", undefined, ["connections_widget"]]) {
    assert.equal(allowedWidgetType(t), null, JSON.stringify(t));
  }
});
