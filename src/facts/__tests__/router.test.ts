// /facts over real HTTP with fake deps (api-contract.md §8): domain gate, auth, response and
// GET shape. Run: `npm test`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express, { type RequestHandler } from "express";
import type { AddressInfo } from "net";
import { createFactsRouter } from "../router";
import type { FactsDeps } from "../service";

const FACTS_KEY = "f".repeat(64);
const INTERNAL_KEY = "i".repeat(64);
const ADMIN_TOKEN = "admin-jwt";
const USER = "0b7c5f4e-9a51-4d8e-8a63-2f1d3c4b5a69";

const fakeAdmin: RequestHandler = (req, res, next) => {
  if (req.headers.authorization === `Bearer ${ADMIN_TOKEN}`) { next(); return; }
  res.status(401).json({ error: { code: "unauthorized", message: "Invalid or expired token" } });
};

let writes = 0;
const deps: FactsDeps & { loadFactsForUser: (u: string, l: number) => Promise<{ latest: unknown[]; history: unknown[] }> } = {
  async loadVocabulary() { return { values: new Map([["has_direct_deposit", new Set(["true", "false"])]]) }; },
  async findExisting() { return []; },
  async insertRows(rows) { writes += rows.length; return { written: rows.length }; },
  async enqueueRebuild() { return { enqueued: true, jobId: "job-1" }; },
  async loadFactsForUser(userId, limit) {
    return {
      latest: [{ fact_key: "has_direct_deposit", value: "true", observed_at: "2026-09-15T14:00:00+00:00", source: "platform_api", source_ref: null }],
      history: [
        { fact_key: "has_direct_deposit", value: "true", observed_at: "2026-09-15T14:00:00+00:00", source: "platform_api", source_ref: null, created_at: "2026-09-15T14:00:01+00:00" },
        { fact_key: "has_direct_deposit", value: "false", observed_at: "2026-09-01T14:00:00+00:00", source: "platform_api", source_ref: null, created_at: "2026-09-01T14:00:01+00:00", _limit: limit, _user: userId },
      ],
    };
  },
};

async function serve(domain: string) {
  const app = express();
  app.use(express.json());
  app.use("/facts", createFactsRouter({ domain, factsKey: FACTS_KEY, adminAuth: fakeAdmin, deps }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/facts`;
}

const post = (url: string, body: unknown, token?: string) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });

const goodBody = { user_id: USER, facts: [{ key: "has_direct_deposit", value: "true", observed_at: "2026-09-15T14:00:00Z" }] };

test("domain gate: POST /facts is 404 on a non-financial deployment — even with the right key", async () => {
  const url = await serve("moosii");
  const before = writes;
  const res = await post(url, goodBody, FACTS_KEY);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: { code: "not_found", message: "Not found" } });
  assert.equal(writes, before, "nothing written");
});

test("auth: missing key, wrong key and the INTERNAL key are all 401 and write nothing", async () => {
  const url = await serve("financial");
  const before = writes;
  for (const token of [undefined, "wrong", INTERNAL_KEY]) {
    const res = await post(url, goodBody, token);
    assert.equal(res.status, 401, `token ${token ?? "(none)"}`);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, "unauthorized");
  }
  assert.equal(writes, before);
});

test("POST with the facts key → 200 { written, rebuild_enqueued } and nothing else", async () => {
  const url = await serve("financial");
  const res = await post(url, goodBody, FACTS_KEY);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { written: 1, rebuild_enqueued: true });
});

test("POST validation errors use the standard error envelope with a 400", async () => {
  const url = await serve("financial");
  const res = await post(url, { user_id: USER, facts: [{ key: "has_direct_deposit", value: "true" }] }, FACTS_KEY);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: { code: "missing_observed_at", message: "facts[0].observed_at is required (ISO 8601 with a time zone, e.g. 2026-09-15T14:00:00Z)" },
  });
});

test("GET /facts/:user_id needs the admin JWT, and the facts key does not grant it", async () => {
  const url = await serve("financial");
  assert.equal((await fetch(`${url}/${USER}`)).status, 401);
  assert.equal((await fetch(`${url}/${USER}`, { headers: { Authorization: `Bearer ${FACTS_KEY}` } })).status, 401);
});

test("GET shape: { user_id, latest[], history[] }, default limit 200, on any domain", async () => {
  const url = await serve("moosii");
  const res = await fetch(`${url}/${USER}`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  assert.equal(res.status, 200);
  const j = (await res.json()) as { user_id: string; latest: Record<string, unknown>[]; history: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(j).sort(), ["history", "latest", "user_id"]);
  assert.equal(j.user_id, USER);
  assert.deepEqual(Object.keys(j.latest[0]).sort(), ["fact_key", "observed_at", "source", "source_ref", "value"]);
  assert.deepEqual(Object.keys(j.history[0]).sort(), ["created_at", "fact_key", "observed_at", "source", "source_ref", "value"]);
  assert.equal(j.history[1]._limit, 200);
});

test("GET validates user_id and limit", async () => {
  const url = await serve("financial");
  const auth = { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } };
  assert.equal((await fetch(`${url}/not-a-uuid`, auth)).status, 400);
  assert.equal((await fetch(`${url}/${USER}?limit=0`, auth)).status, 400);
  assert.equal((await fetch(`${url}/${USER}?limit=5000`, auth)).status, 400);
  const ok = await fetch(`${url}/${USER}?limit=5`, auth);
  const j = (await ok.json()) as { history: Record<string, unknown>[] };
  assert.equal(j.history[1]._limit, 5);
});
