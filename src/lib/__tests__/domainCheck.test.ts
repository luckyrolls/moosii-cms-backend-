// Tests for the DOMAIN env <-> app_settings.domain cross-check (migration 064).
// Run: `npm test`.
//
// This imports domainCheck.ts, NOT domain.ts — the latter validates the env at import and
// calls process.exit, which would kill the test runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDomainReadError, compareDomainToDatabase } from "../domainCheck";

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

// ---- Reading app_settings failed: only "table does not exist" may keep the boot going ----------
// Error shapes below are the ones supabase-js actually returned on 2026-09-18.

test("table missing (42P01, pre-064) warns and keeps booting", () => {
  const r = classifyDomainReadError({ code: "42P01", message: 'relation "public.app_settings" does not exist' });
  assert.equal(r.kind, "table_missing");
  assert.match(r.message, /migration 064/);
});

test("newer PostgREST's table-missing code (PGRST205) also keeps booting", () => {
  const r = classifyDomainReadError({ code: "PGRST205", message: "Could not find the table 'public.app_settings' in the schema cache" });
  assert.equal(r.kind, "table_missing");
});

test("SUPABASE_URL with /rest/v1/ appended — an error with no code and no message — is FATAL", () => {
  // The 2026-09-18 outage: the old check logged "(undefined)" and booted; every JWT then got 401.
  for (const e of [{}, { code: undefined, message: undefined }, { code: "", message: "" }, { code: null, message: null }]) {
    const r = classifyDomainReadError(e);
    assert.equal(r.kind, "fatal", `expected fatal for ${JSON.stringify(e)}`);
    if (r.kind === "fatal") {
      assert.match(r.message, /no code and no message/);
      assert.match(r.message, /SUPABASE_URL is the bare project origin/);
      assert.match(r.message, /no \/rest\/v1/);
    }
  }
});

test("an unreachable host is FATAL and keeps the underlying message", () => {
  const r = classifyDomainReadError({ code: "", message: "TypeError: fetch failed" });
  assert.equal(r.kind, "fatal");
  if (r.kind === "fatal") assert.match(r.message, /no code: TypeError: fetch failed/);
});

test("a key from another project (JWT/permission errors) is FATAL", () => {
  for (const e of [
    { code: "PGRST301", message: "JWSError JWSInvalidSignature" },
    { code: "42501", message: "permission denied for table app_settings" },
    { code: "401", message: "Invalid API key" },
  ]) {
    const r = classifyDomainReadError(e);
    assert.equal(r.kind, "fatal", `expected fatal for ${e.code}`);
    if (r.kind === "fatal") assert.match(r.message, new RegExp(e.code));
  }
});

test("a missing-table MESSAGE without the missing-table CODE is still FATAL (code decides, not wording)", () => {
  assert.equal(classifyDomainReadError({ code: "PGRST116", message: "relation does not exist" }).kind, "fatal");
});

test("a null/undefined error object is FATAL (never silently tolerated)", () => {
  assert.equal(classifyDomainReadError(null).kind, "fatal");
  assert.equal(classifyDomainReadError(undefined).kind, "fatal");
});

test("codes are compared exactly after trimming — '42P01 ' counts, '42p01' does not", () => {
  assert.equal(classifyDomainReadError({ code: " 42P01 ", message: "x" }).kind, "table_missing");
  assert.equal(classifyDomainReadError({ code: "42p01", message: "x" }).kind, "fatal");
});
