// Activity follow-up routes over real HTTP with fake deps (api-contract.md §10): auth, own-user scoping, validation,
// error mapping. The SQL behaviour is proven in src/lib/__tests__/activityFollowups.db.test.ts. Run: `npm test`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import { createActivitiesRouters, mapActivityError, ActivityDbError, type ActivitiesDeps } from "../router";

const USER = "0b7c5f4e-9a51-4d8e-8a63-2f1d3c4b5a69";
const LESSON = "11111111-1111-4111-8111-111111111111";
const FOLLOWUP = "22222222-2222-4222-8222-222222222222";

const calls: { fn: string; args: unknown[] }[] = [];
let failWith: Error | null = null;
const deps: ActivitiesDeps = {
  async finish(...args) { calls.push({ fn: "finish", args }); if (failWith) throw failWith; return { followup: { id: FOLLOWUP }, created: true, awarded: 5 }; },
  async answer(...args) { calls.push({ fn: "answer", args }); if (failWith) throw failWith; return { followup: { id: FOLLOWUP }, awarded: 0 }; },
  async listDue(...args) { calls.push({ fn: "listDue", args }); return [{ id: FOLLOWUP, lesson_name: "Set a reminder" }]; },
  async listRecent(...args) { calls.push({ fn: "listRecent", args }); return []; },
};
const { activities, followups } = createActivitiesRouters({
  async verifyUser(token) {
    return token === "good" ? { ok: true, userId: USER } : { ok: false, status: 401, code: "unauthorized", message: "Invalid or expired token" };
  },
  deps,
});
const app = express();
app.use(express.json());
app.use("/activities", activities);
app.use("/activity-followups", followups);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

async function call(method: string, path: string, body?: unknown, token: string | null = "good") {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
const reset = () => { calls.length = 0; failWith = null; };

test("no / bad token → 401 and no database call", async () => {
  reset();
  assert.equal((await call("POST", `/activities/${LESSON}/finish`, { choice: "did_it" }, null)).status, 401);
  assert.equal((await call("POST", `/activities/${LESSON}/finish`, { choice: "did_it" }, "bad")).status, 401);
  assert.equal((await call("GET", "/activity-followups/due", undefined, "bad")).status, 401);
  assert.equal(calls.length, 0);
});

test("finish: the user id comes from the token, never the body; each choice is passed through", async () => {
  for (const choice of ["did_it", "later", "not_for_me"]) {
    reset();
    const r = await call("POST", `/activities/${LESSON}/finish`, { choice, user_id: "00000000-0000-4000-8000-000000000999" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { followup: { id: FOLLOWUP }, created: true, awarded: 5 });
    assert.deepEqual(calls, [{ fn: "finish", args: [USER, LESSON, choice] }]);
  }
});

test("finish validates before touching the database", async () => {
  reset();
  assert.deepEqual((await call("POST", `/activities/${LESSON}/finish`, { choice: "maybe" })).body.error.code, "invalid_choice");
  assert.deepEqual((await call("POST", `/activities/${LESSON}/finish`, {})).body.error.code, "invalid_choice");
  assert.deepEqual((await call("POST", `/activities/not-a-uuid/finish`, { choice: "did_it" })).body.error.code, "invalid_request");
  assert.equal(calls.length, 0);
});

test("answer and due: scoped to the token's user", async () => {
  reset();
  assert.equal((await call("POST", `/activity-followups/${FOLLOWUP}/answer`, { answer: "not_yet" })).status, 200);
  assert.equal((await call("POST", `/activity-followups/${FOLLOWUP}/answer`, { answer: "nope" })).body.error.code, "invalid_answer");
  const due = await call("GET", "/activity-followups/due");
  assert.deepEqual(due.body, { followups: [{ id: FOLLOWUP, lesson_name: "Set a reminder" }] });
  assert.deepEqual(calls, [{ fn: "answer", args: [USER, FOLLOWUP, "not_yet"] }, { fn: "listDue", args: [USER] }]);
});

test("SQL function errors map to statuses", async () => {
  const cases: [string, number, string][] = [
    ["activity:not_activity: lesson x is not an activity", 400, "not_activity"],
    ["activity:no_followup_configured: activity x has no followup_after_days", 400, "no_followup_configured"],
    ["activity:lesson_not_found: lesson x not found", 404, "lesson_not_found"],
    ["activity:followup_not_found: follow-up x not found", 404, "followup_not_found"],
    ["activity:not_committed: follow-up x is done, not committed", 409, "not_committed"],
    ["activity:followup_lapsed: follow-up x has lapsed", 409, "followup_lapsed"],
  ];
  for (const [msg, status, code] of cases) {
    reset();
    failWith = new ActivityDbError("P0001", msg);
    const r = await call("POST", `/activities/${LESSON}/finish`, { choice: "later" });
    assert.equal(r.status, status, msg);
    assert.equal(r.body.error.code, code);
  }
  reset();
});

test("mapActivityError: missing profile (23503) → 404 unknown_user; anything else → 500", () => {
  assert.equal(mapActivityError(new ActivityDbError("23503", "violates foreign key constraint completed_items_user_id_fkey")).code, "unknown_user");
  assert.deepEqual(mapActivityError(new Error("connection reset")), { status: 500, code: "activity_failed", message: "connection reset" });
  assert.equal(mapActivityError(new ActivityDbError("P0001", "activity:made_up: x")).status, 500);
});
