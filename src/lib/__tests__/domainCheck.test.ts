// Tests for the DOMAIN env <-> app_settings.domain cross-check (migration 064).
// Run: `npm test`.
//
// This imports domainCheck.ts, NOT domain.ts — the latter validates the env at import and
// calls process.exit, which would kill the test runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import { compareDomainToDatabase } from "../domainCheck";

test("matching values are ok", () => {
  assert.deepEqual(compareDomainToDatabase("moosii", "moosii"), { kind: "ok" });
  assert.deepEqual(compareDomainToDatabase("financial", "financial"), { kind: "ok" });
});

test("whitespace around the DB value does not cause a false mismatch", () => {
  assert.equal(compareDomainToDatabase("moosii", "  moosii  ").kind, "ok");
  assert.equal(compareDomainToDatabase("moosii", "moosii\n").kind, "ok");
});

test("a real disagreement is FATAL and names both sides", () => {
  const r = compareDomainToDatabase("moosii", "financial");
  assert.equal(r.kind, "mismatch");
  if (r.kind === "mismatch") {
    assert.match(r.message, /DOMAIN env is 'moosii'/);
    assert.match(r.message, /app_settings\.domain is 'financial'/);
  }
});

test("the mismatch is symmetric — financial service against a moosii database", () => {
  const r = compareDomainToDatabase("financial", "moosii");
  assert.equal(r.kind, "mismatch");
});

test("an unseeded row WARNS but does not stop the boot", () => {
  for (const empty of [null, undefined, "", "   "]) {
    const r = compareDomainToDatabase("moosii", empty);
    assert.equal(r.kind, "unseeded", `expected unseeded for ${JSON.stringify(empty)}`);
  }
});

test("the unseeded warning carries a runnable seed statement for the right domain", () => {
  const r = compareDomainToDatabase("financial", null);
  assert.equal(r.kind, "unseeded");
  if (r.kind === "unseeded") {
    assert.match(r.message, /INSERT INTO app_settings/);
    assert.match(r.message, /'financial'/);
    assert.doesNotMatch(r.message, /'moosii'/, "must not suggest seeding the wrong domain");
  }
});

test("case is significant — a near-miss is a mismatch, not a silent pass", () => {
  assert.equal(compareDomainToDatabase("moosii", "Moosii").kind, "mismatch");
});
