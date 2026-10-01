import { sameSecret } from "./session";

// GET /demo/outcomes core (api-contract §9b; FINDINGS-demo-personas §3, migration 106). Beat 6 of the demo:
// each demo persona's fact history — REAL points from user_facts merged with SEEDED points from
// demo_outcome_series — plus a seeded aggregate. Every point and figure says which it is.
// The code arrives in the X-Demo-Code header (preferred: stays out of URLs and request logs) or, for now,
// ?code= — see pickDemoCode. Gates, in order (same as /demo/session):
//   1. DOMAIN ≠ financial            → 404 not_found
//   2. DEMO_ACCESS_CODE unset        → 503 demo_disabled
//   3. per-IP rate limit exceeded    → 429 rate_limited
//   4. code missing                  → 400 invalid_request
//   5. code ≠ DEMO_ACCESS_CODE       → 401 unauthorized (constant-time compare)
//   6. 200 { personas: [...], aggregate: [...] }
// All I/O is injected so the refusal paths and the tagging are unit-tested.

export type Provenance = "real" | "seeded";

export type FactRow = { user_id: string; fact_key: string; value: string; observed_at: string; source: string };
export type SeriesRow = { user_id: string; fact_key: string; value: string; observed_at: string; label: string };
export type AggregateRow = { metric: string; value: number; label: string };

export type OutcomePoint = {
  fact_key: string;
  value: string;
  observed_at: string;
  provenance: Provenance;
  source: string;           // user_facts.source, or "demo_outcome_series"
  label: string | null;     // seeded series label; null for user_facts rows
};

export type OutcomesBody = {
  personas: { persona: string; user_id: string; points: OutcomePoint[] }[];
  aggregate: { metric: string; value: number; provenance: "seeded"; label: string }[];
};

export type OutcomesDeps = {
  domain: string;
  accessCode: string | undefined;
  limiter: { allow(key: string): boolean };
  listPersonas(): Promise<{ persona: string; user_id: string }[]>;
  loadFacts(userIds: string[]): Promise<FactRow[]>;
  loadSeries(userIds: string[]): Promise<SeriesRow[]>;
  loadAggregate(): Promise<AggregateRow[]>;
};

export type OutcomesResult =
  | { status: 200; body: OutcomesBody }
  | { status: 400 | 401 | 404 | 429 | 503; code: string; message: string };

// Header wins whenever it is present and non-empty; otherwise the query value (which may be absent, an
// array for ?code=a&code=b, etc. — the gate's 400 handles anything that is not a single non-empty string).
export function pickDemoCode(header: unknown, query: unknown): unknown {
  return typeof header === "string" && header.trim() !== "" ? header : query;
}

// A user_facts row written by the demo seed (source 'seed', migration 104) is not a real observation either.
export function factProvenance(source: string): Provenance {
  return source === "seed" ? "seeded" : "real";
}

export function mergePoints(facts: FactRow[], series: SeriesRow[]): OutcomePoint[] {
  const pts: OutcomePoint[] = [
    ...facts.map((f) => ({
      fact_key: f.fact_key, value: f.value, observed_at: f.observed_at,
      provenance: factProvenance(f.source), source: f.source, label: null,
    })),
    ...series.map((s) => ({
      fact_key: s.fact_key, value: s.value, observed_at: s.observed_at,
      provenance: "seeded" as const, source: "demo_outcome_series", label: s.label,
    })),
  ];
  return pts.sort((a, b) =>
    a.fact_key.localeCompare(b.fact_key) || Date.parse(a.observed_at) - Date.parse(b.observed_at));
}

export async function getDemoOutcomes(code: unknown, ip: string, deps: OutcomesDeps): Promise<OutcomesResult> {
  if (deps.domain !== "financial") return { status: 404, code: "not_found", message: "not found" };
  const expected = deps.accessCode?.trim();
  if (!expected) return { status: 503, code: "demo_disabled", message: "demo is not configured on this service" };
  if (!deps.limiter.allow(ip)) return { status: 429, code: "rate_limited", message: "too many demo requests — wait a minute" };
  if (typeof code !== "string" || !code) return { status: 400, code: "invalid_request", message: "code is required" };
  if (!sameSecret(code, expected)) return { status: 401, code: "unauthorized", message: "wrong access code" };

  const personas = (await deps.listPersonas()).sort((a, b) => a.persona.localeCompare(b.persona));
  const ids = personas.map((p) => p.user_id);
  const [facts, series, aggregate] = ids.length
    ? await Promise.all([deps.loadFacts(ids), deps.loadSeries(ids), deps.loadAggregate()])
    : [[], [], await deps.loadAggregate()];

  return {
    status: 200,
    body: {
      personas: personas.map((p) => ({
        persona: p.persona,
        user_id: p.user_id,
        points: mergePoints(facts.filter((f) => f.user_id === p.user_id), series.filter((s) => s.user_id === p.user_id)),
      })),
      aggregate: aggregate
        .map((a) => ({ metric: a.metric, value: a.value, provenance: "seeded" as const, label: a.label }))
        .sort((a, b) => a.metric.localeCompare(b.metric)),
    },
  };
}
