// POST /demo/session core: every refusal path, in gate order (api-contract §9). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoSession, FixedWindowLimiter, type DemoDeps } from "../session";

const CODE = "correct-horse-battery-staple";
const SAM = { id: "19587e0a-bfe0-48e2-94a1-055a5bbc9584", email: "sam@example.test" };

function deps(over: Partial<DemoDeps> = {}) {
  const minted: string[] = [];
  const d: DemoDeps = {
    domain: "financial",
    accessCode: CODE,
    limiter: { allow: () => true },
    async findByPersona(p) { return p === "sam" ? [SAM] : []; },
    async mintSession(email) { minted.push(email); return { access_token: "at", refresh_token: "rt", expires_at: 123 }; },
    ...over,
  };
  return { d, minted };
}

test("200: a demo persona with the right code gets a session for exactly that user", async () => {
  const { d, minted } = deps();
  const out = await createDemoSession({ persona: "sam", code: CODE }, "1.1.1.1", d);
  assert.equal(out.status, 200);
  assert.ok(out.status === 200 && out.body.user_id === SAM.id && out.body.persona === "sam" && out.body.access_token === "at");
  assert.deepEqual(minted, [SAM.email]);
});

test("404 on any domain but financial — before anything else", async () => {
  const { d, minted } = deps({ domain: "moosii", accessCode: undefined });
  const out = await createDemoSession({ persona: "sam", code: CODE }, "ip", d);
  assert.equal(out.status, 404);
  assert.equal(minted.length, 0);
});

test("503 when DEMO_ACCESS_CODE is unset or blank", async () => {
  for (const accessCode of [undefined, "", "   "]) {
    const { d } = deps({ accessCode });
    const out = await createDemoSession({ persona: "sam", code: CODE }, "ip", d);
    assert.equal(out.status, 503);
    assert.ok(out.status !== 200 && out.code === "demo_disabled");
  }
});

test("429 when the limiter refuses — even with the right code", async () => {
  const { d, minted } = deps({ limiter: { allow: () => false } });
  const out = await createDemoSession({ persona: "sam", code: CODE }, "ip", d);
  assert.equal(out.status, 429);
  assert.equal(minted.length, 0);
});

test("400 on a bad body", async () => {
  const { d } = deps();
  for (const body of [null, [], {}, { persona: "sam" }, { code: CODE }, { persona: "Sam!", code: CODE }, { persona: 7, code: CODE }]) {
    const out = await createDemoSession(body, "ip", d);
    assert.equal(out.status, 400, JSON.stringify(body));
  }
});

test("401 on a wrong code (including a prefix / different length); nothing minted", async () => {
  const { d, minted } = deps();
  for (const code of ["wrong", CODE + "x", CODE.slice(0, -1)]) {
    const out = await createDemoSession({ persona: "sam", code }, "ip", d);
    assert.equal(out.status, 401);
  }
  assert.equal(minted.length, 0);
});

test("403 for a persona no user carries; nothing minted", async () => {
  const { d, minted } = deps();
  const out = await createDemoSession({ persona: "priya", code: CODE }, "ip", d);
  assert.equal(out.status, 403);
  assert.ok(out.status !== 200 && out.code === "not_demo_persona");
  assert.equal(minted.length, 0);
});

test("500 when two users carry the same persona; nothing minted", async () => {
  const { d, minted } = deps({ async findByPersona() { return [SAM, { id: "x", email: "x@example.test" }]; } });
  const out = await createDemoSession({ persona: "sam", code: CODE }, "ip", d);
  assert.equal(out.status, 500);
  assert.equal(minted.length, 0);
});

test("FixedWindowLimiter: N per window per key, resets after the window", () => {
  let t = 0;
  const l = new FixedWindowLimiter(2, 1000, () => t);
  assert.deepEqual([l.allow("a"), l.allow("a"), l.allow("a"), l.allow("b")], [true, true, false, true]);
  t = 1000;
  assert.equal(l.allow("a"), true);
});
