import { createHash, timingSafeEqual } from "crypto";

// POST /facts machine-caller auth: the existing bearer-shared-secret scheme, with its OWN key
// (FACTS_API_KEY) scoped to this one route. INTERNAL_API_KEY is deliberately NOT accepted — it
// also unlocks POST /jobs (arbitrary AI spend), and this key is held by an outside partner.
// PURE: the key is passed in, so the checks are unit-tested without env.

export type BearerCheck =
  | { ok: true; fingerprint: string }
  | { ok: false; status: 401; code: "unauthorized"; message: string };

// First 6 hex chars of a SHA-256 — enough to tell keys apart in logs, never the key.
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 6);
}

export function checkFactsBearer(header: string | undefined, factsKey: string | undefined): BearerCheck {
  if (!factsKey) {
    // Unreachable on a financial deployment (boot refuses without the key); fail closed anyway.
    return { ok: false, status: 401, code: "unauthorized", message: "facts intake is not configured" };
  }
  if (!header?.startsWith("Bearer ")) {
    return { ok: false, status: 401, code: "unauthorized", message: "Missing or malformed Authorization header" };
  }
  const token = header.slice("Bearer ".length);
  // Hash both sides so the compare is constant-time AND length-independent.
  const given = createHash("sha256").update(token).digest();
  const expected = createHash("sha256").update(factsKey).digest();
  if (!timingSafeEqual(given, expected)) {
    return { ok: false, status: 401, code: "unauthorized", message: "Invalid API key" };
  }
  return { ok: true, fingerprint: keyFingerprint(token) };
}
