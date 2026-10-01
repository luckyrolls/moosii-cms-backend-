import { createHash, timingSafeEqual } from "crypto";

// POST /demo/session core (api-contract §9; FINDINGS-demo-personas §1). Signs the reader in as a DEMO
// persona: a user whose auth app_metadata.demo_persona equals the requested persona. Everything else is
// refused. Gates run in this order, each a distinct answer:
//   1. DOMAIN ≠ financial            → 404 not_found        (the route does not exist elsewhere)
//   2. DEMO_ACCESS_CODE unset        → 503 demo_disabled
//   3. per-IP rate limit exceeded    → 429 rate_limited
//   4. body shape                    → 400 invalid_request
//   5. code ≠ DEMO_ACCESS_CODE       → 401 unauthorized     (constant-time compare)
//   6. no user carries that persona  → 403 not_demo_persona (and 500 if more than one does)
//   7. mint                          → 200 { persona, user_id, access_token, refresh_token, expires_at }
// Tokens are never logged. All I/O is injected so every refusal path is unit-tested.

export type DemoSession = { access_token: string; refresh_token: string; expires_at: number };

export type DemoDeps = {
  domain: string;
  accessCode: string | undefined;
  limiter: { allow(key: string): boolean };
  // Users whose app_metadata.demo_persona === persona (normally 0 or 1).
  findByPersona(persona: string): Promise<{ id: string; email: string }[]>;
  mintSession(email: string): Promise<DemoSession>;
};

export type DemoOutcome =
  | { status: 200; body: { persona: string; user_id: string } & DemoSession }
  | { status: 400 | 401 | 403 | 404 | 429 | 500 | 503; code: string; message: string };

const PERSONA_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function sameSecret(given: string, expected: string): boolean {
  // Hash both to a fixed length so timingSafeEqual never throws on a length mismatch.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function createDemoSession(body: unknown, ip: string, deps: DemoDeps): Promise<DemoOutcome> {
  if (deps.domain !== "financial") return { status: 404, code: "not_found", message: "not found" };
  const expected = deps.accessCode?.trim();
  if (!expected) return { status: 503, code: "demo_disabled", message: "demo sign-in is not configured on this service" };
  if (!deps.limiter.allow(ip)) return { status: 429, code: "rate_limited", message: "too many demo sign-ins — wait a minute" };

  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (typeof b.persona !== "string" || !PERSONA_RE.test(b.persona)) {
    return { status: 400, code: "invalid_request", message: "persona is required (lowercase letters, digits, - or _)" };
  }
  if (typeof b.code !== "string" || !b.code) return { status: 400, code: "invalid_request", message: "code is required" };
  if (!sameSecret(b.code, expected)) return { status: 401, code: "unauthorized", message: "wrong access code" };

  const users = await deps.findByPersona(b.persona);
  if (users.length === 0) return { status: 403, code: "not_demo_persona", message: `no demo user for persona ${JSON.stringify(b.persona)}` };
  if (users.length > 1) return { status: 500, code: "persona_ambiguous", message: `${users.length} users carry persona ${JSON.stringify(b.persona)}` };

  const session = await deps.mintSession(users[0].email);
  return { status: 200, body: { persona: b.persona, user_id: users[0].id, ...session } };
}

// Fixed-window counter per key (one Render instance → in-memory is enough). Not a security boundary on
// its own — the access code is — it just stops a loop from minting sessions.
export class FixedWindowLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>();
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}
  allow(key: string): boolean {
    const t = this.now();
    const cur = this.hits.get(key);
    if (!cur || t - cur.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: t, count: 1 });
      if (this.hits.size > 10_000) this.hits.clear();   // bound memory; a reset only loosens the limit
      return true;
    }
    cur.count++;
    return cur.count <= this.limit;
  }
}
