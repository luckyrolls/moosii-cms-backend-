// GET /activity-followups/recent — the pure shaping (window, order, provenance) and the route over HTTP with fake deps
// (own rows only, the 14-day cutoff passed to the query). Run: `npm test`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import { toRecent, verifiedSource, recentSince, RECENT_WINDOW_DAYS, type RecentRaw } from "../recent";
import { createActivitiesRouters, type ActivitiesDeps } from "../router";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const base = { lesson_id: "L", asks: 0, due_at: null, committed_at: null, resolved_by: null, verified_at: null,
               lesson: { lesson_name: "Set a Statement-Date Reminder" }, fact: null } as const;
const row = (o: Partial<RecentRaw> & { id: string; status: string; created_at: string }): RecentRaw =>
  ({ ...base, resolved_at: null, ...o }) as RecentRaw;

test("verified_source: demo-simulated / seeded / derived from the evidence row; null without one", () => {
  assert.equal(verifiedSource({ source: "seed", source_ref: "demo-simulate" }), "demo-simulated");
  assert.equal(verifiedSource({ source: "seed", source_ref: "demo-seed" }), "seeded");
  for (const s of ["derived", "estimated", "platform_api", "cms", "manual"]) assert.equal(verifiedSource({ source: s, source_ref: "job:1" }), "derived");
  assert.equal(verifiedSource(null), null);
});

test("committed rows (due or not) + rows resolved within 14 days, newest first; older resolved rows are excluded", () => {
  const rows: RecentRaw[] = [
    row({ id: "old-done", status: "done", created_at: days(40), resolved_at: days(15), resolved_by: "self" }),
    row({ id: "edge-done", status: "done", created_at: days(20), resolved_at: days(RECENT_WINDOW_DAYS), resolved_by: "self" }),
    row({ id: "committed-old", status: "committed", created_at: days(60), committed_at: days(60), due_at: days(53) }),
    row({ id: "skipped", status: "skipped", created_at: days(2), resolved_at: days(2) }),
    row({ id: "data", status: "done", created_at: days(5), committed_at: days(5), resolved_at: days(0.01), resolved_by: "data",
          verified_at: days(0.01), fact: { source: "seed", source_ref: "demo-simulate" } }),
    row({ id: "committed-new", status: "committed", created_at: days(1), committed_at: days(1), due_at: days(-6) }),
  ];
  const out = toRecent(rows, NOW);
  assert.deepEqual(out.map((r) => r.id), ["data", "committed-new", "skipped", "edge-done", "committed-old"]);
  const data = out[0];
  assert.deepEqual(data, { id: "data", lesson_id: "L", lesson_name: "Set a Statement-Date Reminder", status: "done", asks: 0,
    due_at: null, resolved_at: days(0.01), resolved_by: "data", verified_at: days(0.01), verified_source: "demo-simulated" });
  // no amounts / Moosies fields in the shape
  assert.deepEqual(Object.keys(data).sort(), ["asks", "due_at", "id", "lesson_id", "lesson_name", "resolved_at", "resolved_by",
    "status", "verified_at", "verified_source"]);
  assert.equal(recentSince(NOW), days(14));
});

test("an unverified row reports verified_source null even if a fact is attached; a deleted evidence row → null", () => {
  const out = toRecent([
    row({ id: "a", status: "done", created_at: days(1), resolved_at: days(1), resolved_by: "self", fact: { source: "derived", source_ref: null } }),
    row({ id: "b", status: "done", created_at: days(1), resolved_at: days(1), resolved_by: "data", verified_at: days(1), fact: null }),
  ], NOW);
  assert.deepEqual(out.map((r) => [r.id, r.verified_source]), [["a", null], ["b", null]]);
});

// ---- the route ----
const USER = "0b7c5f4e-9a51-4d8e-8a63-2f1d3c4b5a69";
const seen: { userId: string; since: string }[] = [];
const deps: ActivitiesDeps = {
  async finish() { return {}; }, async answer() { return {}; }, async listDue() { return []; },
  async listRecent(userId, since) {
    seen.push({ userId, since });
    return [row({ id: "r1", status: "committed", created_at: days(1), committed_at: days(1), due_at: days(-6) })];
  },
};
const { followups } = createActivitiesRouters({
  async verifyUser(t) { return t === "sam-demo-session" ? { ok: true, userId: USER } : { ok: false, status: 401, code: "unauthorized", message: "x" }; },
  deps, now: () => NOW,
});
const app = express();
app.use("/activity-followups", followups);
const server = app.listen(0);
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/activity-followups/recent`;
after(() => server.close());

test("route: the token's user only, the 14-day cutoff passed to the query; no token → 401, no query", async () => {
  const r = await fetch(url + "?user_id=someone-else", { headers: { Authorization: "Bearer sam-demo-session" } });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { followups: { id: string }[] };
  assert.deepEqual(body.followups.map((f) => f.id), ["r1"]);
  assert.deepEqual(seen, [{ userId: USER, since: days(14) }]);
  const no = await fetch(url);
  assert.equal(no.status, 401);
  assert.equal(seen.length, 1);
});
