import { validateFactsBody, type FactRow, type Vocabulary } from "./validate";

// POST /facts core — validate → conflict check → ONE write → enqueue the rebuild. The database
// calls are INJECTED (FactsDeps) so the ordering guarantees are unit-tested with fakes:
// nothing is written on any rejection, the write is a single call carrying every row, and the
// rebuild is enqueued only after the write succeeded. Real deps: src/facts/db.ts.

export type ExistingObservation = { fact_key: string; value: string; observed_at: string };

export type FactsDeps = {
  loadVocabulary(): Promise<Vocabulary>;
  // Rows already recorded for this user at any of these (key, observed_at) pairs.
  findExisting(userId: string, keys: string[], observedAts: string[]): Promise<ExistingObservation[]>;
  // ONE INSERT statement for all rows (atomic), ON CONFLICT (user_id, fact_key, observed_at) DO
  // NOTHING. Returns how many rows were actually inserted. Throws UnknownUserError when the
  // user_id has no auth account (user_facts_user_id_fkey, migration 076).
  insertRows(rows: FactRow[]): Promise<{ written: number }>;
  enqueueRebuild(userId: string, ctx: { reason: string; correlationId: string }): Promise<{ enqueued: boolean; jobId?: string; coalescedInto?: string }>;
};

export class UnknownUserError extends Error {
  constructor(userId: string) {
    super(`user_id ${userId} does not resolve to an auth user`);
    this.name = "UnknownUserError";
  }
}

export type RecordFactsOutcome =
  | { status: 200; body: { written: number; rebuild_enqueued: boolean }; userId: string; skipped: number }
  | { status: 400 | 404 | 409; code: string; message: string };

export async function recordFacts(body: unknown, deps: FactsDeps, correlationId: string): Promise<RecordFactsOutcome> {
  const vocab = await deps.loadVocabulary();
  const v = validateFactsBody(body, vocab);
  if (!v.ok) return { status: v.status, code: v.code, message: v.message };

  // Redelivery of an identical observation is harmless (DO NOTHING). A DIFFERENT value at the
  // same (user, key, observed_at) is a contradiction, not a redelivery — refuse the whole call
  // rather than let the conflict clause drop it silently.
  const existing = await deps.findExisting(
    v.userId,
    [...new Set(v.rows.map((r) => r.fact_key))],
    [...new Set(v.rows.map((r) => r.observed_at))],
  );
  const recorded = new Map(existing.map((x) => [`${x.fact_key}|${new Date(x.observed_at).getTime()}`, x.value]));
  for (let i = 0; i < v.rows.length; i++) {
    const r = v.rows[i];
    const prior = recorded.get(`${r.fact_key}|${new Date(r.observed_at).getTime()}`);
    if (prior !== undefined && prior !== r.value) {
      return {
        status: 409,
        code: "conflicting_observation",
        message: `facts[${i}]: ${JSON.stringify(r.fact_key)} at ${r.observed_at} is already recorded as ${JSON.stringify(prior)}, not ${JSON.stringify(r.value)}`,
      };
    }
  }

  let written: number;
  try {
    ({ written } = await deps.insertRows(v.rows));
  } catch (e) {
    if (e instanceof UnknownUserError) return { status: 404, code: "unknown_user", message: e.message };
    throw e;
  }

  // After the write committed. Enqueued even when written = 0 (an identical redelivery): a
  // rebuild is idempotent, and it covers a previous call whose rebuild failed.
  const r = await deps.enqueueRebuild(v.userId, { reason: "facts_intake", correlationId });
  return {
    status: 200,
    body: { written, rebuild_enqueued: r.enqueued || Boolean(r.coalescedInto) },
    userId: v.userId,
    skipped: v.rows.length - written,
  };
}
