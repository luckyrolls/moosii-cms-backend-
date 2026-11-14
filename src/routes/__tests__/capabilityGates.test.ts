// Slice 2: the capability gate on every approval-class route, over real HTTP against the REAL
// routers — not a copy of the gate expression, which is the drift trap that produced the
// 118/115 regression and the rebuild-trigger defect. api-contract.md sections 1f, 2 and 3.
//
// The routers import src/supabase.ts, which process.exit(1)s on missing env, so ./_stubEnv is
// imported FIRST and points it at an unroutable origin. A caller WITHOUT the capability is
// refused before any query runs, so the 403 is exact. A caller WITH it passes the gate and then
// fails to reach the stub origin — so "not 403" is the assertion that matters there, and it
// proves the gate let the request through.
//
// Run: `npm test`.
import { stubServer } from "./_stubEnv";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "net";
import { mapPublishError } from "../../lib/lessonPublish";
import { hasCapability, hasAnyCapability, type CmsUser } from "../../middleware/jwtAuth";
import { diffReview, toApprovalFields, type ReviewSnapshot } from "../../lib/cardReview";
import lessons from "../lessons";
import quiz from "../quiz";
import images from "../images";
import questionnaires from "../questionnaires";
import tones, { wantsActiveOnly } from "../tones";

const ID = "11111111-1111-4111-8111-111111111111";

type Caps = { editorial?: boolean; clinical?: boolean; publish?: boolean };
const user = (c: Caps): CmsUser => ({
  id: "22222222-2222-4222-8222-222222222222",
  email: null,
  role: "admin",
  can_review_editorial: !!c.editorial,
  can_approve_clinical: !!c.clinical,
  can_publish: !!c.publish,
});

// ---------------------------------------------------------------- the pure helpers

test("hasCapability knows three capabilities and fails closed", () => {
  assert.equal(hasCapability(user({ editorial: true }), "editorial"), true);
  assert.equal(hasCapability(user({ editorial: true }), "clinical"), false);
  assert.equal(hasCapability(user({ editorial: true }), "publish"), false);
  assert.equal(hasCapability(user({ publish: true }), "publish"), true);
  assert.equal(hasCapability(undefined, "publish"), false, "no user -> no capability");
  assert.equal(hasCapability(undefined, "editorial"), false);
});

test("hasAnyCapability is an OR, and still fails closed", () => {
  assert.equal(hasAnyCapability(user({ clinical: true }), ["publish", "clinical"]), true);
  assert.equal(hasAnyCapability(user({ publish: true }), ["publish", "clinical"]), true);
  assert.equal(hasAnyCapability(user({ editorial: true }), ["publish", "clinical"]), false);
  assert.equal(hasAnyCapability(user({}), ["editorial", "clinical"]), false);
  assert.equal(hasAnyCapability(undefined, ["editorial", "clinical", "publish"]), false);
});

// Every HINT migration 126 can raise. Capability -> 403, state -> 409, and the HINT IS the code.
test("mapPublishError maps each 126 HINT to a status and uses the hint as the code", () => {
  for (const hint of ["publish_not_permitted", "unpublish_not_permitted"]) {
    const m = mapPublishError({ hint, code: "23514", message: "..." });
    assert.equal(m?.status, 403, hint);
    assert.equal(m?.code, hint);
    assert.ok((m?.message ?? "").length > 10, "a plain-language message, not the SQL text");
    assert.ok(!/ERROR|23514|set_lesson_published/.test(m!.message), "no database prose leaks out");
  }
  for (const hint of ["publish_not_approved", "publish_quiz_pending", "publish_archived"]) {
    const m = mapPublishError({ hint, code: "23514", message: "..." });
    assert.equal(m?.status, 409, hint);
    assert.equal(m?.code, hint);
  }
});

test("mapPublishError leaves anything it does not recognise to the 500 path", () => {
  assert.equal(mapPublishError({ hint: "something_else", code: "23514" }), null);
  assert.equal(mapPublishError({ hint: null, code: "23514", message: "deadlock detected" }), null);
  assert.equal(mapPublishError({ code: "42883", message: "function does not exist" }), null);
  assert.equal(mapPublishError(null), null);
  assert.equal(mapPublishError(undefined), null);
});

const snap = (o: Partial<ReviewSnapshot>): ReviewSnapshot => ({
  seg_status: "complete", draft: 0, editorial_reviewed: 0, clinically_approved: 3, quiz_pending: 0, ...o,
});

test("diffReview reports what the TRIGGERS did, not what the route wrote", () => {
  // a card edit: one card knocked to draft, the gate lost
  const one = diffReview(snap({}), snap({ seg_status: "pending", draft: 1, clinically_approved: 2 }), "card");
  assert.deepEqual(one, {
    approval_reset: true, scope: "card", seg_status: "pending",
    cards_reset_to_draft: 1, cards_demoted_to_editorial: 0, quiz_questions_reset: 0,
  });

  // a delete/reorder: the WHOLE segment goes back to draft
  const all = diffReview(snap({}), snap({ seg_status: "pending", draft: 3, clinically_approved: 0 }), "segment");
  assert.equal(all.scope, "segment");
  assert.equal(all.cards_reset_to_draft, 3);

  // an image swap DEMOTES to editorial_reviewed rather than resetting to draft
  const img = diffReview(snap({}), snap({ seg_status: "pending", editorial_reviewed: 1, clinically_approved: 2 }), "card");
  assert.equal(img.cards_demoted_to_editorial, 1);
  assert.equal(img.cards_reset_to_draft, 0);
  assert.equal(img.approval_reset, true);

  // a quiz question going back to pending counts, even with the cards untouched
  const quiz = diffReview(snap({}), snap({ quiz_pending: 2 }), "card");
  assert.equal(quiz.quiz_questions_reset, 2);
  assert.equal(quiz.approval_reset, true);
});

test("diffReview reports 'none' when nothing moved, whatever scope the caller claimed", () => {
  const same = diffReview(snap({}), snap({}), "segment");
  assert.deepEqual(same, {
    approval_reset: false, scope: "none", seg_status: "complete",
    cards_reset_to_draft: 0, cards_demoted_to_editorial: 0, quiz_questions_reset: 0,
  });
  // an already-pending segment that stays pending is not a new reset
  const stillPending = diffReview(snap({ seg_status: "pending", draft: 1 }), snap({ seg_status: "pending", draft: 1 }), "card");
  assert.equal(stillPending.approval_reset, false);
});

test("toApprovalFields keeps approval_reset a BOOLEAN and puts the breakdown beside it", () => {
  const f = toApprovalFields(diffReview(snap({}), snap({ seg_status: "pending", draft: 1 }), "card"));
  assert.equal(typeof f.approval_reset, "boolean", "widening this field would break `if (approval_reset)`");
  assert.equal(f.approval_reset, true);
  assert.equal(f.approval_reset_detail.scope, "card");
  assert.ok(!("approval_reset" in f.approval_reset_detail));
});

// GET /tones keeps its original default (every tone, so the CMS Tone Management screen still
// shows the inactive ones it is the only place to re-activate); the PICKER narrows explicitly.
test("wantsActiveOnly narrows ONLY on the explicit param, and defaults to every tone", () => {
  assert.equal(wantsActiveOnly({}), false, "bare /tones must stay unfiltered");
  assert.equal(wantsActiveOnly({ active_only: "true" }), true);
  assert.equal(wantsActiveOnly({ active_only: "false" }), false);
  assert.equal(wantsActiveOnly({ active_only: "1" }), false, "only the exact string 'true' counts");
  assert.equal(wantsActiveOnly({ active_only: "TRUE" }), false);
  assert.equal(wantsActiveOnly({ active_only: ["true"] }), false, "a repeated param is an array, not 'true'");
  assert.equal(wantsActiveOnly({ include_inactive: "true" }), false, "the retired param has no effect");
});

// ---------------------------------------------------------------- the real routers

const app = express();
app.use(express.json());
let current: CmsUser | undefined;
app.use((req, _res, next) => {
  // `current` serves the sequential cases; the header serves the concurrent ones, where a
  // module-level variable would race.
  const hdr = req.headers["x-test-caps"];
  (req as unknown as { user?: CmsUser }).user = typeof hdr === "string" ? user(JSON.parse(hdr) as Caps) : current;
  next();
});

app.use("/lessons", lessons);
app.use("/quiz", quiz);
app.use("/content-images", images);
app.use("/questionnaires", questionnaires);
app.use("/tones", tones);

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); stubServer.close(); });

async function post(path: string, caps: Caps): Promise<{ status: number; body: { error?: { code?: string; message?: string } } }> {
  current = user(caps);
  const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  let body: { error?: { code?: string; message?: string } } = {};
  try { body = (await r.json()) as typeof body; } catch { /* non-JSON body on the pass-through path */ }
  return { status: r.status, body };
}

// [route, the capability sets that are REFUSED, the sets that PASS the gate, the expected code]
const GATES: Array<{ route: string; refused: Caps[]; allowed: Caps[]; code?: string }> = [
  { route: `/lessons/${ID}/approve`,            refused: [{}, { editorial: true }, { publish: true }], allowed: [{ clinical: true }] },
  { route: `/lessons/${ID}/editorial-approve`,  refused: [{}, { clinical: true }, { publish: true }],  allowed: [{ editorial: true }] },
  { route: `/lessons/${ID}/unapprove`,          refused: [{}, { publish: true }],                      allowed: [{ editorial: true }, { clinical: true }] },
  { route: `/lessons/${ID}/publish`,            refused: [{}, { editorial: true }, { clinical: true }], allowed: [{ publish: true }], code: "publish_not_permitted" },
  { route: `/lessons/${ID}/unpublish`,          refused: [{}, { editorial: true }],                     allowed: [{ publish: true }, { clinical: true }], code: "unpublish_not_permitted" },
  { route: `/quiz/${ID}/approve`,               refused: [{}, { editorial: true }, { publish: true }], allowed: [{ clinical: true }] },
  { route: `/quiz/${ID}/unapprove`,             refused: [{}, { publish: true }],                      allowed: [{ editorial: true }, { clinical: true }] },
  { route: `/content-images/${ID}/approve`,     refused: [{}, { clinical: true }, { publish: true }],  allowed: [{ editorial: true }] },
  { route: `/content-images/${ID}/reject`,      refused: [{}, { publish: true }],                      allowed: [{ editorial: true }, { clinical: true }] },
  { route: `/questionnaires/${ID}/publish`,     refused: [{}, { editorial: true }, { clinical: true }], allowed: [{ publish: true }], code: "publish_not_permitted" },
  { route: `/questionnaires/${ID}/unpublish`,   refused: [{}, { editorial: true }],                     allowed: [{ publish: true }, { clinical: true }], code: "unpublish_not_permitted" },
];

// REFUSALS run per route and are fast: the gate answers before any query is attempted.
for (const g of GATES) {
  test(`gate: POST ${g.route.replace(ID, ":id")} refuses without the capability`, async () => {
    for (const caps of g.refused) {
      const r = await post(g.route, caps);
      assert.equal(r.status, 403, `${g.route} with ${JSON.stringify(caps)} should be 403, got ${r.status}`);
      if (g.code) assert.equal(r.body.error?.code, g.code, `${g.route} error code`);
    }
  });
}

// PASS-THROUGHS are fired CONCURRENTLY. Each one gets past the gate and then fails to reach a
// database, and an outbound request costs ~7s in this sandbox whatever it is aimed at — serially
// that was 70s for the file, concurrently it is one round trip. `current` cannot be shared across
// concurrent requests, so each sends its capabilities as a header the test app reads per request.
test("gate: every capable caller gets through to the (unreachable) database", async () => {
  const want = GATES.flatMap((g) => g.allowed.map((caps) => ({ route: g.route, caps })));
  const results = await Promise.all(
    want.map(async ({ route, caps }) => ({
      route, caps,
      status: (await fetch(base + route, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-test-caps": JSON.stringify(caps) },
        body: "{}",
      })).status,
    }))
  );
  for (const r of results) {
    assert.notEqual(r.status, 403, `${r.route} with ${JSON.stringify(r.caps)} must pass the gate`);
    assert.ok(r.status >= 400, "no database is reachable here, so it cannot be a 2xx");
  }
  assert.equal(results.length, 16, "every allowed capability set was exercised");
});

// GET /tones is NOT capability-gated (reading the library is not a sign-off), so a
// capability-less admin must still reach it — it fails on the unreachable database, not on 403.
test("GET /tones is not capability-gated", async () => {
  current = user({});
  for (const path of ["/tones", "/tones?active_only=true"]) {
    const r = await fetch(base + path);
    assert.notEqual(r.status, 403, `${path} must not be capability-gated`);
  }
});

// A user with NO capabilities is refused everywhere — the fail-closed default that matters
// most, since both plain Moosii admins are in exactly that state after migration 126.
test("a capability-less admin is refused by every approval-class route", async () => {
  for (const g of GATES) {
    const r = await post(g.route, {});
    assert.equal(r.status, 403, `${g.route} must refuse a capability-less admin`);
  }
});
