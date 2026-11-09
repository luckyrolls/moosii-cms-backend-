// GET /plan — the pure shaping (order, reasons, item_count, why-preference) and the route over HTTP with fake deps
// (own user only, read-only). api-contract §11. Run: `npm test`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import { toPlan, pickWhy, WHY_PREFERENCE, REASON_KINDS, type PlanItemRaw, type ReasonRaw } from "../shape";
import { createPlanRouter, type PlanDeps } from "../router";

const USER = "19587e0a-bfe0-48e2-94a1-055a5bbc9584";
const CH = "f0840000-0000-4000-8000-000000000002";
const GO = "f0840000-0000-4000-8000-000000000001";
const SA = "f0840000-0000-4000-8000-000000000003";
const STAMP = "2026-11-09T12:00:00.000Z";

const item = (o: Partial<PlanItemRaw> & { item_id: string; track_id: string }): PlanItemRaw => ({
  item_type: "lesson", position: 1, item_name: o.item_id, item_description: "", with_quiz: false,
  track_name: o.track_id === CH ? "Credit Health" : o.track_id === GO ? "Getting Oriented" : "Subscription Audit",
  updated_at: STAMP, ...o,
});
const reason = (o: Partial<ReasonRaw> & { track_id: string; kind: string }): ReasonRaw => ({
  track_name: null, label: null, fact_key: null, value: null, observed_at: null,
  source: null, source_ref: null, confidence: null, action_at: null, ...o,
});

const FACT_CH = reason({ track_id: CH, track_name: "Credit Health", kind: "fact",
  label: "Because your cards are close to their limits", fact_key: "credit_utilization_band", value: "high",
  observed_at: "2026-11-01T00:00:00.000Z", source: "estimated" });
const DEFAULT_GO = reason({ track_id: GO, track_name: "Getting Oriented", kind: "default",
  label: "A starting point for everyone" });

test("items come back in position order with the track's reason attached; generated_at is the newest stamp", () => {
  const out = toPlan(USER, [
    item({ item_id: "go1", track_id: GO, position: 2, updated_at: STAMP }),
    item({ item_id: "ch1", track_id: CH, position: 1, updated_at: "2026-11-08T00:00:00.000Z" }),
    item({ item_id: "ch2", track_id: CH, position: 3, updated_at: STAMP }),
  ], [FACT_CH, DEFAULT_GO]);

  assert.deepEqual(out.items.map((i) => [i.position, i.item_id]), [[1, "ch1"], [2, "go1"], [3, "ch2"]]);
  assert.equal(out.user_id, USER);
  assert.equal(out.generated_at, STAMP);
  assert.deepEqual(out.items[0].why, { kind: "fact", label: "Because your cards are close to their limits" });
  assert.deepEqual(out.items[1].why, { kind: "default", label: "A starting point for everyone" });
  // the item shape: no weights, no priorities, no Moosies
  assert.deepEqual(Object.keys(out.items[0]).sort(), ["item_description", "item_id", "item_name", "item_type",
    "position", "track_id", "track_name", "why", "with_quiz"]);
});

test("a track's reasons and item_count ride on tracks[]; the full observation is carried for a fact reason", () => {
  const out = toPlan(USER, [item({ item_id: "ch1", track_id: CH, position: 1 }), item({ item_id: "ch2", track_id: CH, position: 2 }),
    item({ item_id: "go1", track_id: GO, position: 3 })], [FACT_CH, DEFAULT_GO]);
  assert.deepEqual(out.tracks.map((t) => [t.track_name, t.item_count]), [["Credit Health", 2], ["Getting Oriented", 1]]);
  assert.deepEqual(out.tracks[0].reasons, [{ kind: "fact", label: "Because your cards are close to their limits",
    fact_key: "credit_utilization_band", value: "high", observed_at: "2026-11-01T00:00:00.000Z",
    source: "estimated", confidence: null, at: null }]);
});

// The diagnostic the demo needs: the fact activated the track but every lesson in it is unpublished, so the pool
// gave the plan nothing. Without item_count this looks identical to "nothing happened".
test("an active track that contributed NO item still appears, with item_count 0", () => {
  const out = toPlan(USER, [item({ item_id: "ch1", track_id: CH, position: 1 })],
    [FACT_CH, reason({ track_id: SA, track_name: "Subscription Audit", kind: "fact",
      label: "Because a new subscription showed up", fact_key: "new_subscription_recent", value: "true" })]);
  assert.deepEqual(out.tracks.map((t) => [t.track_name, t.item_count]), [["Credit Health", 1], ["Subscription Audit", 0]]);
  assert.equal(out.items.length, 1);
});

test("several reasons for one track: all are returned, and why picks the most specific LABELLED one", () => {
  const savingForHome = reason({ track_id: CH, kind: "fact", label: "Because you're saving towards a home",
    fact_key: "saving_for_home", value: "true" });
  const asInsight = reason({ track_id: CH, kind: "insight", source: "mx", confidence: 0.8, action_at: STAMP });
  const out = toPlan(USER, [item({ item_id: "ch1", track_id: CH })], [DEFAULT_GO, savingForHome, asInsight,
    reason({ track_id: CH, kind: "default", label: "A starting point for everyone" })]);
  assert.equal(out.tracks.find((t) => t.track_id === CH)!.reasons.length, 3);
  // fact outranks default; the unlabelled insight is not shown as `why` because it has nothing to display
  assert.deepEqual(out.items[0].why, { kind: "fact", label: "Because you're saving towards a home" });

  assert.deepEqual([...WHY_PREFERENCE], ["fact", "insight", "questionnaire", "demographic", "manual", "default"]);
  assert.deepEqual([...REASON_KINDS].sort(), ["default", "demographic", "fact", "insight", "manual", "questionnaire"]);
  // with no labelled reason at all, why still names the kind and label null — never invented copy
  assert.deepEqual(pickWhy([{ kind: "insight", label: null, fact_key: null, value: null, observed_at: null,
    source: "mx", confidence: 0.8, at: STAMP }]), { kind: "insight", label: null });
  assert.equal(pickWhy([]), null);
});

test("an unknown reason kind is dropped, not guessed; an empty plan is a valid empty answer", () => {
  const out = toPlan(USER, [item({ item_id: "ch1", track_id: CH })],
    [FACT_CH, reason({ track_id: CH, kind: "astrology" })]);
  assert.deepEqual(out.tracks[0].reasons.map((r) => r.kind), ["fact"]);

  const empty = toPlan(USER, [], []);
  assert.deepEqual(empty, { user_id: USER, generated_at: null, items: [], tracks: [] });
});

test("a NULL position sorts last and ties break on item_id, so the order is total", () => {
  const out = toPlan(USER, [
    item({ item_id: "zz", track_id: CH, position: null }),
    item({ item_id: "bb", track_id: CH, position: null }),
    item({ item_id: "aa", track_id: CH, position: 9 }),
  ], []);
  assert.deepEqual(out.items.map((i) => i.item_id), ["aa", "bb", "zz"]);
});

// ---- the route ----
const seen: { plan: string[]; reasons: string[] } = { plan: [], reasons: [] };
const deps: PlanDeps = {
  async listPlan(userId) { seen.plan.push(userId); return [item({ item_id: "ch1", track_id: CH, position: 1 })]; },
  async listReasons(userId) { seen.reasons.push(userId); return [FACT_CH]; },
};
const router = createPlanRouter({
  async verifyUser(t) {
    return t === "sam-demo-session" ? { ok: true, userId: USER } : { ok: false, status: 401, code: "unauthorized", message: "x" };
  },
  deps,
});
const app = express();
app.use("/plan", router);
const server = app.listen(0);
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/plan`;
after(() => server.close());

test("route: the token's user only — a user_id query param is ignored; no token → 401 and no query", async () => {
  const r = await fetch(url + "?user_id=someone-else", { headers: { Authorization: "Bearer sam-demo-session" } });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { user_id: string; items: { item_id: string; why: unknown }[] };
  assert.equal(body.user_id, USER);
  assert.deepEqual(body.items.map((i) => i.item_id), ["ch1"]);
  assert.deepEqual(body.items[0].why, { kind: "fact", label: "Because your cards are close to their limits" });
  assert.deepEqual(seen, { plan: [USER], reasons: [USER] });

  const no = await fetch(url);
  assert.equal(no.status, 401);
  const bad = await fetch(url, { headers: { Authorization: "Bearer nope" } });
  assert.equal(bad.status, 401);
  assert.deepEqual(seen, { plan: [USER], reasons: [USER] }, "no query ran for an unauthenticated caller");
});

test("route: a failing read is a 500 with the plan_failed code, never a partial body", async () => {
  const boom = createPlanRouter({
    async verifyUser() { return { ok: true, userId: USER }; },
    deps: { async listPlan() { return []; }, async listReasons() { throw new Error("rpc missing"); } },
  });
  const a = express();
  a.use("/plan", boom);
  const s = a.listen(0);
  const u = `http://127.0.0.1:${(s.address() as AddressInfo).port}/plan`;
  try {
    const r = await fetch(u, { headers: { Authorization: "Bearer x" } });
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: { code: "plan_failed", message: "could not load the plan" } });
  } finally {
    s.close();
  }
});
