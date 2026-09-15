// POST /facts body validation — PURE (no DB, no env), so every rejection rule is unit-tested.
// Contract: docs/api-contract.md §8. All-or-nothing: the FIRST offending entry is named and
// nothing is written. The database repeats the vocabulary + "no amounts" rules as constraints
// (migrations 069/070); this layer exists to name the offender instead of surfacing a raw 23503.

export const FACT_SOURCES = ["platform_api", "cms", "manual"] as const;  // user_facts_source_valid (070)
export type FactSource = (typeof FACT_SOURCES)[number];

export const MAX_FACTS_PER_CALL = 100;

// key -> the values authored for it (fact_values)
export type Vocabulary = { values: Map<string, Set<string>> };

export type FactRow = {
  user_id: string;
  fact_key: string;
  value: string;
  observed_at: string;   // normalized ISO 8601 (UTC, ms precision)
  source: FactSource;
};

export type ValidationError = { ok: false; status: 400; code: string; message: string };
export type ValidatedBody = { ok: true; userId: string; rows: FactRow[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same "opens numeric / signed / dollar" rule as the fact_values_not_numeric CHECK (069).
const NUMERIC_RE = /^\s*[+-]?\$?\d/;
// A date AND a time AND an explicit zone — a bare date or a zone-less time is ambiguous, and
// observed_at is the idempotency key, so it must mean exactly one instant.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function bad(code: string, message: string): ValidationError {
  return { ok: false, status: 400, code, message };
}

export function validateFactsBody(body: unknown, vocab: Vocabulary): ValidatedBody | ValidationError {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return bad("invalid_request", "body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if ("external_user_id" in b) {
    return bad("invalid_request", "external_user_id is not supported; send user_id (the Supabase auth uid)");
  }
  if (!isUuid(b.user_id)) return bad("invalid_request", "user_id is required and must be a uuid");
  if (!Array.isArray(b.facts) || b.facts.length === 0) {
    return bad("invalid_request", "facts must be a non-empty array");
  }
  if (b.facts.length > MAX_FACTS_PER_CALL) {
    return bad("invalid_request", `at most ${MAX_FACTS_PER_CALL} facts per call (got ${b.facts.length})`);
  }

  const userId = b.user_id;
  const rows: FactRow[] = [];
  const firstIndexByInstant = new Map<string, number>();

  for (let i = 0; i < b.facts.length; i++) {
    const at = `facts[${i}]`;
    const f = b.facts[i];
    if (!f || typeof f !== "object" || Array.isArray(f)) return bad("invalid_request", `${at} must be an object`);
    const e = f as Record<string, unknown>;

    if (typeof e.key !== "string" || !e.key.trim()) return bad("invalid_request", `${at}.key is required`);
    if (typeof e.value !== "string" || !e.value.trim()) {
      return bad("invalid_request", `${at}.value is required and must be a string`);
    }
    if (e.observed_at === undefined || e.observed_at === null || e.observed_at === "") {
      return bad("missing_observed_at", `${at}.observed_at is required (ISO 8601 with a time zone, e.g. 2026-09-15T14:00:00Z)`);
    }
    if (typeof e.observed_at !== "string" || !ISO_RE.test(e.observed_at) || Number.isNaN(Date.parse(e.observed_at))) {
      return bad("invalid_observed_at", `${at}.observed_at must be ISO 8601 with a time zone (got ${JSON.stringify(e.observed_at)})`);
    }
    let source: FactSource = "platform_api";
    if (e.source !== undefined) {
      if (typeof e.source !== "string" || !(FACT_SOURCES as readonly string[]).includes(e.source)) {
        return bad("invalid_source", `${at}.source must be one of ${FACT_SOURCES.join(" | ")} (got ${JSON.stringify(e.source)})`);
      }
      source = e.source as FactSource;
    }

    const key = e.key;
    const value = e.value;
    if (NUMERIC_RE.test(value)) {
      return bad("unknown_fact", `${at}: value ${JSON.stringify(value)} for key ${JSON.stringify(key)} looks numeric — facts are boolean or a short enum, never an amount`);
    }
    const allowed = vocab.values.get(key);
    if (!allowed) return bad("unknown_fact", `${at}: unknown key ${JSON.stringify(key)}`);
    if (!allowed.has(value)) return bad("unknown_fact", `${at}: unknown value ${JSON.stringify(value)} for key ${JSON.stringify(key)}`);

    const observedAt = new Date(e.observed_at).toISOString();
    const instant = `${key}|${observedAt}`;
    const first = firstIndexByInstant.get(instant);
    if (first !== undefined) {
      return bad("duplicate_fact", `${at} repeats facts[${first}]: the same key ${JSON.stringify(key)} at the same observed_at`);
    }
    firstIndexByInstant.set(instant, i);

    rows.push({ user_id: userId, fact_key: key, value, observed_at: observedAt, source });
  }

  return { ok: true, userId, rows };
}
