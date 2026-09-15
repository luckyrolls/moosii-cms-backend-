// FACTS_API_KEY bearer check + boot config (api-contract.md §8). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFactsBearer, keyFingerprint } from "../auth";
import { checkFactsConfig } from "../config";

const FACTS_KEY = "f".repeat(64);
const INTERNAL_KEY = "i".repeat(64);

test("the facts key authenticates and yields a 6-char fingerprint, never the key", () => {
  const r = checkFactsBearer(`Bearer ${FACTS_KEY}`, FACTS_KEY);
  assert.deepEqual(r, { ok: true, fingerprint: keyFingerprint(FACTS_KEY) });
  if (r.ok) {
    assert.match(r.fingerprint, /^[0-9a-f]{6}$/);
    assert.notEqual(r.fingerprint, FACTS_KEY.slice(0, 6), "a fingerprint is a hash, not a key prefix");
  }
});

test("missing or malformed header → 401", () => {
  for (const h of [undefined, "", FACTS_KEY, `Basic ${FACTS_KEY}`, "Bearer"]) {
    const r = checkFactsBearer(h, FACTS_KEY);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 401);
  }
});

test("a wrong key → 401, including a prefix or a longer key", () => {
  for (const k of ["wrong", FACTS_KEY.slice(0, 10), FACTS_KEY + "x", ""]) {
    const r = checkFactsBearer(`Bearer ${k}`, FACTS_KEY);
    assert.equal(r.ok, false, `accepted ${JSON.stringify(k)}`);
  }
});

test("the INTERNAL key is rejected — it is not a facts credential", () => {
  const r = checkFactsBearer(`Bearer ${INTERNAL_KEY}`, FACTS_KEY);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.message, "Invalid API key");
});

test("an unconfigured key fails closed", () => {
  const r = checkFactsBearer(`Bearer ${FACTS_KEY}`, undefined);
  assert.equal(r.ok, false);
});

test("boot: FACTS_API_KEY is required on financial", () => {
  for (const k of [undefined, "", "   "]) {
    assert.equal(checkFactsConfig("financial", k, INTERNAL_KEY).kind, "fatal");
  }
  assert.deepEqual(checkFactsConfig("financial", FACTS_KEY, INTERNAL_KEY), { kind: "ok" });
});

test("boot: on financial the key must be long, unpadded, and distinct from INTERNAL_API_KEY", () => {
  assert.match((checkFactsConfig("financial", "short", INTERNAL_KEY) as { message: string }).message, /at least 32/);
  assert.match((checkFactsConfig("financial", ` ${FACTS_KEY}`, INTERNAL_KEY) as { message: string }).message, /whitespace/);
  const same = checkFactsConfig("financial", INTERNAL_KEY, INTERNAL_KEY);
  assert.equal(same.kind, "fatal");
  if (same.kind === "fatal") assert.match(same.message, /must differ from INTERNAL_API_KEY/);
});

test("boot: ignored outside financial (warn if set, silent if not)", () => {
  assert.deepEqual(checkFactsConfig("moosii", undefined, INTERNAL_KEY), { kind: "ok" });
  assert.equal(checkFactsConfig("moosii", "short", INTERNAL_KEY).kind, "ignored");
});
