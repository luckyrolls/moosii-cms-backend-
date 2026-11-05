import { recordFacts, type FactsDeps, type RecordFactsOptions } from "./service";
import { MAX_FACTS_PER_CALL } from "./validate";

// POST /facts/batch core (api-contract.md §8b-batch) — MANY members in one call, so a daily push for
// a whole population is a handful of requests instead of one per member.
//
// Each member is recorded through the SAME recordFacts core as POST /facts: same validation, same
// conflict rule, same all-or-nothing write, same D6 no-op, same per-member rebuild. The members are
// INDEPENDENT: one member's rejection is reported in that member's result and never touches another's
// write, so a batch always answers 200 and the caller reads `results`. Members run one at a time —
// at this scale a predictable, debuggable order beats concurrency.
//
// Partner identity is unchanged (D2): every member is addressed by `user_id`, the Supabase auth uid.

export const MAX_MEMBERS_PER_BATCH = 50;

export type BatchMemberResult =
  | { user_id: string | null; status: "ok"; written: number; unchanged: boolean; rebuild_enqueued: boolean }
  | { user_id: string | null; status: "error"; error: { code: string; message: string } };

export type BatchSummary = {
  members: number;
  ok: number;
  failed: number;
  unchanged: number;
  written: number;
  rebuilds_enqueued: number;
};

export type RecordFactsBatchOutcome =
  | { status: 200; body: { summary: BatchSummary; results: BatchMemberResult[] } }
  | { status: 400; code: string; message: string };

function bad(code: string, message: string): RecordFactsBatchOutcome {
  return { status: 400, code, message };
}

export async function recordFactsBatch(
  body: unknown,
  deps: FactsDeps,
  correlationId: string,
  opts: RecordFactsOptions = {},
): Promise<RecordFactsBatchOutcome> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("invalid_request", "body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.members) || b.members.length === 0) return bad("invalid_request", "members must be a non-empty array");
  if (b.members.length > MAX_MEMBERS_PER_BATCH) {
    return bad("invalid_request", `at most ${MAX_MEMBERS_PER_BATCH} members per call (got ${b.members.length})`);
  }

  // Envelope checks only — everything about a member's own facts is validateFactsBody's job, so one
  // member's bad entry is that member's error and not the batch's.
  const seen = new Map<string, number>();
  for (let i = 0; i < b.members.length; i++) {
    const m = b.members[i];
    if (!m || typeof m !== "object" || Array.isArray(m)) return bad("invalid_request", `members[${i}] must be an object`);
    const e = m as Record<string, unknown>;
    if (Array.isArray(e.facts) && e.facts.length > MAX_FACTS_PER_CALL) {
      return bad("invalid_request", `members[${i}]: at most ${MAX_FACTS_PER_CALL} facts per member (got ${e.facts.length})`);
    }
    if (typeof e.user_id === "string") {
      const key = e.user_id.toLowerCase();
      const first = seen.get(key);
      // Two entries for one member in one call have no defined order, and the second would see the
      // first's rows as "current" — refuse rather than return a result that depends on ordering.
      if (first !== undefined) return bad("invalid_request", `members[${i}] repeats members[${first}]: the same user_id twice in one call`);
      seen.set(key, i);
    }
  }

  // The vocabulary is the same for every member: load it ONCE per batch (recordFacts asks per call).
  let vocab: ReturnType<FactsDeps["loadVocabulary"]> | undefined;
  const perMember: FactsDeps = {
    ...deps,
    loadVocabulary: () => (vocab ??= deps.loadVocabulary()),
  };

  const results: BatchMemberResult[] = [];
  for (let i = 0; i < b.members.length; i++) {
    const m = b.members[i] as Record<string, unknown>;
    const userId = typeof m.user_id === "string" ? m.user_id : null;
    try {
      const out = await recordFacts({ user_id: m.user_id, facts: m.facts }, perMember, `${correlationId}:${i}`, opts);
      results.push(
        out.status === 200
          ? { user_id: out.userId, status: "ok", written: out.body.written, unchanged: out.body.unchanged, rebuild_enqueued: out.body.rebuild_enqueued }
          : { user_id: userId, status: "error", error: { code: out.code, message: out.message } },
      );
    } catch (e) {
      // A write that threw (connection reset, an unexpected PG error) fails THAT member only.
      results.push({ user_id: userId, status: "error", error: { code: "facts_write_failed", message: e instanceof Error ? e.message : String(e) } });
    }
  }

  const ok = results.filter((r) => r.status === "ok");
  return {
    status: 200,
    body: {
      summary: {
        members: results.length,
        ok: ok.length,
        failed: results.length - ok.length,
        unchanged: ok.filter((r) => r.status === "ok" && r.unchanged).length,
        written: ok.reduce((s, r) => s + (r.status === "ok" ? r.written : 0), 0),
        rebuilds_enqueued: ok.filter((r) => r.status === "ok" && r.rebuild_enqueued).length,
      },
      results,
    },
  };
}
