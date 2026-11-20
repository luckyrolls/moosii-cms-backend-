// Migration 128's routes and their pure layer. No database: these cover the TS gate, the payload
// parsing, the HINT mapping and the rebuild decision. The database behaviour — the backfill, the
// switch, the same-group rule — is src/lib/__tests__/catalogModes.db.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "./_stubEnv";
import express from "express";
import {
  CATALOG_MODES,
  interpretRetagResult,
  interpretSwitchResult,
  isMigrationPendingError,
  isSuperAdmin,
  mapCatalogError,
  parseGroup,
  parseMode,
  shouldRebuildAfterRetag,
  shouldRebuildAfterSwitch,
} from "../../lib/catalogModes";

// ───────────────────────────────────────────────────────────── the pure layer

test("parseMode accepts exactly the three modes — legacy is a group, never a mode", () => {
  for (const m of CATALOG_MODES) assert.equal(parseMode(m), m);
  for (const bad of ["legacy", "LIVE", "", null, undefined, 1, {}, ["live"]]) {
    assert.equal(parseMode(bad), null, `${JSON.stringify(bad)} must not parse as a mode`);
  }
});

test("parseGroup accepts all four groups, legacy included", () => {
  for (const g of ["live", "mem", "mdm", "legacy"]) assert.equal(parseGroup(g), g);
  for (const bad of ["archived", "", null, 7]) assert.equal(parseGroup(bad), null);
});

test("mapCatalogError maps 128's HINTs and refuses to guess at anything else", () => {
  assert.deepEqual(mapCatalogError({ hint: "cross_group_link", message: "x" }), {
    status: 409,
    code: "cross_group_link",
    message: "x",
  });
  assert.equal(mapCatalogError({ hint: "catalog_mode_not_permitted", message: "y" })?.status, 403);
  assert.equal(mapCatalogError({ hint: "bad_mode", message: "y" })?.status, 400);
  assert.equal(mapCatalogError({ hint: "bad_group", message: "y" })?.status, 400);
  // an unknown hint is NOT a recognised refusal: it must reach the 500 path, not be flattened
  assert.equal(mapCatalogError({ hint: "something_else", message: "y" }), null);
  assert.equal(mapCatalogError({ message: "no hint" }), null);
  assert.equal(mapCatalogError(null), null);
});

test("isMigrationPendingError spots the pre-apply window and nothing else", () => {
  assert.equal(isMigrationPendingError({ code: "PGRST202", message: "not found" }), true);
  assert.equal(isMigrationPendingError({ code: "42883", message: "function does not exist" }), true);
  assert.equal(isMigrationPendingError({ message: 'column tracks.test_group does not exist' }), true);
  assert.equal(isMigrationPendingError({ code: "23514", message: "check violation" }), false);
  assert.equal(isMigrationPendingError({ code: "23505", message: "duplicate" }), false);
});

test("isSuperAdmin is exact — a plain admin is not one", () => {
  assert.equal(isSuperAdmin({ role: "super_admin" }), true);
  assert.equal(isSuperAdmin({ role: "admin" }), false);
  assert.equal(isSuperAdmin({ role: "user" }), false);
  assert.equal(isSuperAdmin(undefined), false);
  assert.equal(isSuperAdmin(null), false);
});

test("interpretSwitchResult requires a usable mode, changed flag and both counts", () => {
  const good = { mode: "live", previous_mode: "mem", changed: true, tracks_archived: 1, tracks_unarchived: 4 };
  assert.deepEqual(interpretSwitchResult(good), good);
  assert.equal(interpretSwitchResult({ ...good, previous_mode: null })?.previous_mode, null);
  // malformed is NOT coerced: `changed` decides whether every plan gets rebuilt
  assert.equal(interpretSwitchResult({ ...good, changed: "yes" }), null);
  assert.equal(interpretSwitchResult({ ...good, mode: "legacy" }), null);
  assert.equal(interpretSwitchResult({ ...good, tracks_archived: "1" }), null);
  assert.equal(interpretSwitchResult({ ...good, previous_mode: "nope" }), null);
  assert.equal(interpretSwitchResult(null), null);
});

test("interpretRetagResult reads found:false, and validates the rest", () => {
  assert.deepEqual(interpretRetagResult({ found: false }), { found: false });
  const good = {
    found: true, track_id: "t", test_group: "mem", previous_group: "legacy",
    changed: true, archived: false, mode_archived: false,
  };
  assert.deepEqual(interpretRetagResult(good), good);
  assert.equal(interpretRetagResult({ ...good, test_group: "nope" }), null);
  assert.equal(interpretRetagResult({ ...good, archived: null }), null);
  assert.equal(interpretRetagResult({}), null);
});

test("the rebuild decision: only a real change rebuilds", () => {
  const base = { mode: "live" as const, previous_mode: "mem" as const, tracks_archived: 1, tracks_unarchived: 4 };
  assert.equal(shouldRebuildAfterSwitch({ ...base, changed: true }), true);
  // a no-op switch must NOT enqueue: a needless scope:all rebuild would also coalesce a real one
  // queued behind it (src/jobs/rebuildTrigger.ts)
  assert.equal(shouldRebuildAfterSwitch({ ...base, changed: false }), false);

  assert.equal(shouldRebuildAfterRetag({ found: true, changed: true }), true);
  assert.equal(shouldRebuildAfterRetag({ found: true, changed: false }), false);
  assert.equal(shouldRebuildAfterRetag({ found: false }), false);
});

// ───────────────────────────────────────────────────── the routes, over real HTTP

type Role = "super_admin" | "admin" | "user" | "none";

// The real routers, behind a stub of jwtAuthMiddleware that reads the role from a header. What is
// under test is the ROUTER's own gate, not the admin gate in front of it.
async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const { default: catalogModeRouter, trackGroupRouter } = await import("../catalogMode");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const role = (req.headers["x-test-role"] as Role) ?? "none";
    if (role !== "none") (req as any).user = { id: "11111111-1111-4111-8111-111111111111", role };
    next();
  });
  app.use("/admin", catalogModeRouter);
  app.use("/tracks", trackGroupRouter);

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function call(
  base: string,
  method: string,
  path: string,
  role: Role,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(role === "none" ? {} : { "x-test-role": role }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test("POST /admin/catalog-mode and PATCH /tracks/:id/test-group are super_admin only", async () => {
  await withServer(async (base) => {
    for (const role of ["admin", "user", "none"] as Role[]) {
      const sw = await call(base, "POST", "/admin/catalog-mode", role, { mode: "live" });
      assert.equal(sw.status, 403, `switch as ${role}`);
      assert.equal(sw.json.error.code, "catalog_mode_not_permitted");

      const rt = await call(base, "PATCH", "/tracks/abc/test-group", role, { test_group: "mem" });
      assert.equal(rt.status, 403, `retag as ${role}`);
      assert.equal(rt.json.error.code, "catalog_mode_not_permitted");
    }
  });
});

test("a bad payload is refused BEFORE any RPC, and 'legacy' is not a mode", async () => {
  await withServer(async (base) => {
    for (const body of [{ mode: "legacy" }, { mode: "nope" }, { mode: 1 }, {}, { mode: null }]) {
      const r = await call(base, "POST", "/admin/catalog-mode", "super_admin", body);
      assert.equal(r.status, 400, `mode ${JSON.stringify(body)}`);
      assert.equal(r.json.error.code, "bad_mode");
    }
    for (const body of [{ test_group: "archived" }, { test_group: 2 }, {}]) {
      const r = await call(base, "PATCH", "/tracks/abc/test-group", "super_admin", body);
      assert.equal(r.status, 400, `group ${JSON.stringify(body)}`);
      assert.equal(r.json.error.code, "bad_group");
    }
  });
});

test("a super_admin passes the gate and then fails to reach a database, which is the proof", async () => {
  await withServer(async (base) => {
    const r = await call(base, "POST", "/admin/catalog-mode", "super_admin", { mode: "live" });
    assert.notEqual(r.status, 403, "the TS gate let a super_admin through");
    assert.notEqual(r.status, 400, "the payload was accepted");
    assert.ok(r.status >= 500 || r.status === 503, `expected a database failure, got ${r.status}`);
  });
});

test("GET /admin/catalog-mode needs no super_admin — any admin may read the mode", async () => {
  await withServer(async (base) => {
    const r = await call(base, "GET", "/admin/catalog-mode", "admin");
    assert.notEqual(r.status, 403, "reading the current mode is not a privileged action");
  });
});
