// Slice 1: the test-account routes (migration 127) — the pure decision helpers, and the
// super_admin gate over real HTTP against the REAL router. Not a copy of the gate expression:
// re-implementing it in the test is the drift trap that produced the 118/115 regression.
//
// The router imports src/supabase.ts, which process.exit(1)s on missing env, so ./_stubEnv is
// imported FIRST and points it at a local origin that answers instantly. A caller who is not a
// super_admin is refused BEFORE any query runs, so the 403 and its code are exact. A super_admin
// passes the gate and then fails to reach a real database — so "not 403" is the assertion that
// matters there, and it proves the gate let the request through.
//
// Run: `npm test`. The DB-level behaviours (the flag is unwritable, reset refuses an unflagged
// user, the denylist, seed facts surviving, moosies zeroed) need a real Postgres and live in
// src/lib/__tests__/testAccounts.db.test.ts.
import { stubServer } from "./_stubEnv";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import type { CmsUser } from "../../middleware/jwtAuth";
import {
  interpretResetResult,
  interpretSetFlagResult,
  isMigrationPendingError,
  isSuperAdmin,
  mapTestAccountError,
  parseFlag,
  parseResetDepth,
  totalDeleted,
} from "../../lib/testAccounts";
import users from "../users";

const ID = "33333333-3333-4333-8333-333333333333";

const asUser = (role: string | null): CmsUser => ({
  id: "44444444-4444-4444-8444-444444444444",
  email: null,
  role: role as CmsUser["role"],
  can_review_editorial: true,
  can_approve_clinical: true,
  can_publish: true,
});

// ---------------------------------------------------------------- the pure helpers

test("isSuperAdmin accepts ONLY super_admin, and fails closed", () => {
  assert.equal(isSuperAdmin(asUser("super_admin")), true);
  assert.equal(isSuperAdmin(asUser("admin")), false, "a plain admin cannot flag or reset");
  assert.equal(isSuperAdmin(asUser("user")), false);
  assert.equal(isSuperAdmin(asUser(null)), false);
  assert.equal(isSuperAdmin(undefined), false, "no user -> not a super_admin");
  assert.equal(isSuperAdmin({}), false);
  // every capability in the world is not a role
  assert.equal(isSuperAdmin({ role: "Super_Admin" }), false, "the comparison is exact");
});

test("mapTestAccountError maps each 127 HINT to a status and uses the HINT as the code", () => {
  const notPermitted = mapTestAccountError({ hint: "test_account_not_permitted", code: "23514" });
  assert.equal(notPermitted?.status, 403);
  assert.equal(notPermitted?.code, "test_account_not_permitted");

  const notTest = mapTestAccountError({ hint: "not_test_account", code: "23514" });
  assert.equal(notTest?.status, 409);
  assert.equal(notTest?.code, "not_test_account");

  const badDepth = mapTestAccountError({ hint: "bad_depth", code: "23514" });
  assert.equal(badDepth?.status, 400);
  assert.equal(badDepth?.code, "bad_depth");

  // An unknown or absent hint must NOT be dressed up as a refusal — the caller keeps its 500.
  assert.equal(mapTestAccountError({ hint: "something_else", code: "23514" }), null);
  assert.equal(mapTestAccountError({ code: "23514", message: "boom" }), null);
  assert.equal(mapTestAccountError(null), null);
  assert.equal(mapTestAccountError(undefined), null);
});

test("isMigrationPendingError recognises the pre-apply window and nothing else", () => {
  for (const code of ["PGRST202", "42883", "PGRST204", "42703"]) {
    assert.equal(isMigrationPendingError({ code }), true, code);
  }
  assert.equal(isMigrationPendingError({ message: "could not find the function set_test_account" }), true);
  assert.equal(isMigrationPendingError({ message: 'column "is_test_account" does not exist' }), true);
  // a genuine failure must stay a 500
  assert.equal(isMigrationPendingError({ code: "23514", message: "check violation" }), false);
  assert.equal(isMigrationPendingError({ code: "57014", message: "canceling statement" }), false);
  assert.equal(isMigrationPendingError(null), false);
});

test("parseResetDepth accepts exactly the two literals", () => {
  assert.equal(parseResetDepth({ depth: "activity" }), "activity");
  assert.equal(parseResetDepth({ depth: "full" }), "full");
  assert.equal(parseResetDepth({ depth: "FULL" }), null, "case matters — a typo must not reach the RPC");
  assert.equal(parseResetDepth({ depth: "everything" }), null);
  assert.equal(parseResetDepth({ depth: true }), null);
  assert.equal(parseResetDepth({}), null, "an omitted depth is not a default");
  assert.equal(parseResetDepth(null), null);
  assert.equal(parseResetDepth("full"), null, "a bare string body is not a payload");
});

test("parseFlag requires a real boolean — no string coercion", () => {
  assert.equal(parseFlag({ is_test_account: true }), true);
  assert.equal(parseFlag({ is_test_account: false }), false);
  assert.equal(parseFlag({ is_test_account: "true" }), null, "coercing this would make the audit row lie");
  assert.equal(parseFlag({ is_test_account: 1 }), null);
  assert.equal(parseFlag({}), null);
  assert.equal(parseFlag(null), null);
});

test("interpretSetFlagResult treats anything malformed as NOT found", () => {
  assert.deepEqual(interpretSetFlagResult({ found: true, is_test_account: true, changed: true }), {
    found: true, isTestAccount: true, changed: true,
  });
  assert.deepEqual(interpretSetFlagResult({ found: true, is_test_account: false, changed: false }), {
    found: true, isTestAccount: false, changed: false,
  });
  assert.deepEqual(interpretSetFlagResult({ found: false }), { found: false });
  // a missing or non-boolean flag must never read as "flagged"
  assert.deepEqual(interpretSetFlagResult({ found: true }), { found: false });
  assert.deepEqual(interpretSetFlagResult({ found: true, is_test_account: "yes" }), { found: false });
  assert.deepEqual(interpretSetFlagResult(null), { found: false });
  assert.deepEqual(interpretSetFlagResult("nope"), { found: false });
});

test("interpretResetResult requires found + depth + a deleted object", () => {
  const ok = interpretResetResult({ found: true, depth: "full", deleted: { completed_items: 3 } });
  assert.equal(ok.found, true);
  assert.equal(ok.found && ok.depth, "full");
  assert.deepEqual(ok.found && ok.deleted, { completed_items: 3 });

  assert.deepEqual(interpretResetResult({ found: true, depth: "full" }), { found: false }, "no deleted map");
  assert.deepEqual(interpretResetResult({ found: true, deleted: {} }), { found: false }, "no depth");
  assert.deepEqual(interpretResetResult({ found: false }), { found: false });
  assert.deepEqual(interpretResetResult(undefined), { found: false });
});

test("totalDeleted sums counts and ignores the non-numeric markers", () => {
  assert.equal(totalDeleted({ completed_items: 3, user_mlp: 7 }), 10);
  assert.equal(
    totalDeleted({ completed_items: 3, quiz_user_progress: "skipped_no_user_column" }),
    3,
    "the quiz_user_progress marker must not be coerced to a count"
  );
  assert.equal(totalDeleted({}), 0);
  assert.equal(totalDeleted({ a: null as unknown as number, b: 2 }), 2);
});

// ---------------------------------------------------------------- the real router

const app = express();
app.use(express.json());
let current: CmsUser | undefined;
app.use((req, _res, next) => {
  // The header serves the concurrent cases, where a module-level variable would race.
  const hdr = req.headers["x-test-role"];
  (req as unknown as { user?: CmsUser }).user =
    typeof hdr === "string" ? asUser(hdr === "none" ? null : hdr) : current;
  next();
});
app.use("/users", users);

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.close();
  stubServer.close();
});

type Res = { status: number; body: { error?: { code?: string; message?: string } } };

async function call(method: string, path: string, role: string, body: unknown): Promise<Res> {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", "x-test-role": role },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  let parsed: Res["body"] = {};
  try {
    parsed = (await r.json()) as Res["body"];
  } catch {
    /* non-JSON body on the pass-through path */
  }
  return { status: r.status, body: parsed };
}

// [method, path, body] — every mutating route and the list
const ROUTES: Array<{ method: string; path: string; body: unknown; label: string }> = [
  { method: "PATCH", path: `/users/${ID}/test-account`, body: { is_test_account: true }, label: "flag" },
  { method: "POST", path: `/users/${ID}/reset`, body: { depth: "activity" }, label: "reset activity" },
  { method: "POST", path: `/users/${ID}/reset`, body: { depth: "full" }, label: "reset full" },
  { method: "GET", path: "/users/test-accounts", body: null, label: "list" },
];

test("every test-account route refuses a non-super_admin with 403 test_account_not_permitted", async () => {
  for (const role of ["admin", "user", "none"]) {
    const results = await Promise.all(
      ROUTES.map((r) => call(r.method, r.path, role, r.body).then((res) => ({ ...res, label: r.label })))
    );
    for (const res of results) {
      assert.equal(res.status, 403, `${res.label} as ${role} must be 403, got ${res.status}`);
      assert.equal(
        res.body.error?.code,
        "test_account_not_permitted",
        `${res.label} as ${role} must carry the stable code`
      );
    }
  }
});

// A plain `admin` is the important negative: it reaches the router (jwtAuthMiddleware admits any
// admin role) and is stopped only by this gate.
test("a plain admin is refused — the router gate, not the admin gate, is what stops them", async () => {
  const r = await call("PATCH", `/users/${ID}/test-account`, "admin", { is_test_account: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.error?.code, "test_account_not_permitted");
});

test("a super_admin passes the gate (and then fails to reach a database, which is the proof)", async () => {
  const results = await Promise.all(
    ROUTES.map((r) => call(r.method, r.path, "super_admin", r.body).then((res) => ({ ...res, label: r.label })))
  );
  for (const res of results) {
    assert.notEqual(res.status, 403, `${res.label} as super_admin must NOT be refused by the gate`);
    assert.notEqual(res.body.error?.code, "test_account_not_permitted", res.label);
  }
});

// Payload validation happens BEFORE the RPC, so a bad body is a clean 400 and never reaches the
// database — and critically, it is checked AFTER the role gate, so a non-super_admin probing with
// a malformed body still learns only that they are forbidden.
test("a bad depth is 400 bad_depth for a super_admin, and still 403 for everyone else", async () => {
  const good = await call("POST", `/users/${ID}/reset`, "super_admin", { depth: "everything" });
  assert.equal(good.status, 400);
  assert.equal(good.body.error?.code, "bad_depth");

  const missing = await call("POST", `/users/${ID}/reset`, "super_admin", {});
  assert.equal(missing.status, 400, "an omitted depth must not default to anything");
  assert.equal(missing.body.error?.code, "bad_depth");

  const plain = await call("POST", `/users/${ID}/reset`, "admin", { depth: "everything" });
  assert.equal(plain.status, 403, "the role gate runs first — no payload feedback for the unauthorised");
  assert.equal(plain.body.error?.code, "test_account_not_permitted");
});

test("a non-boolean flag is 400 bad_request before any RPC", async () => {
  const r = await call("PATCH", `/users/${ID}/test-account`, "super_admin", { is_test_account: "true" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error?.code, "bad_request");
});

// /users/test-accounts must not be captured by a /:id route. If it ever were, this would come
// back as a flag/reset refusal or a 404 for the id "test-accounts" instead of the list path.
test("GET /users/test-accounts is routed as the list, not as an :id", async () => {
  const r = await call("GET", "/users/test-accounts", "super_admin", null);
  assert.notEqual(r.status, 404, "the list route must exist and not be shadowed by /:id");
  assert.notEqual(r.body.error?.code, "not_found");
});
