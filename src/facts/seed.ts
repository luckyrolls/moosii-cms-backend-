import { recordFacts, type FactsDeps } from "./service";
import { isUuid } from "./validate";

// seed_facts core (api-contract §8e; FINDINGS-demo-personas §2). Writes SEEDED facts for a DEMO
// persona only: source 'seed', source_ref 'demo-seed', through the same recordFacts core as POST /facts
// and derive_facts (vocabulary, no-amounts and conflict rules all apply; the user's rebuild is enqueued).
//
// Idempotent across runs: a key whose CURRENT value is already this value from a seed is skipped, so a
// re-run writes nothing and enqueues nothing. Everything external is injected (unit-tested with fakes).

export const SEED_SOURCE_REF = "demo-seed";

export type LatestFact = { fact_key: string; value: string; source: string };

export type SeedDeps = {
  domain: string;
  demoPersonaOf(userId: string): Promise<string | null>;   // auth app_metadata.demo_persona, or null
  latestFacts(userId: string): Promise<LatestFact[]>;      // user_facts_latest for the user
  facts: FactsDeps;
  now(): Date;
};

export type SeedFactsResult = {
  user_id: string;
  demo_persona: string;
  observed_at: string;
  facts: { fact_key: string; value: string; status: "recorded" | "unchanged" }[];
  written: number;
  rebuild_enqueued: boolean;
};

export class SeedError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SeedError";
  }
}

export async function seedFactsForUser(
  input: { user_id?: unknown; facts?: unknown },
  ctx: { correlationId: string },
  deps: SeedDeps,
): Promise<SeedFactsResult> {
  if (deps.domain !== "financial") throw new SeedError("domain_not_supported", `seed_facts runs on the financial deployment only (DOMAIN=${deps.domain})`);
  if (!isUuid(input.user_id)) throw new SeedError("invalid_input", "input.user_id is required and must be a uuid");
  const userId = input.user_id;
  if (!Array.isArray(input.facts) || input.facts.length === 0) throw new SeedError("invalid_input", "input.facts must be a non-empty array of { key, value }");
  const requested: { key: string; value: string }[] = [];
  for (const [i, f] of input.facts.entries()) {
    const e = f as Record<string, unknown> | null;
    if (!e || typeof e.key !== "string" || typeof e.value !== "string") throw new SeedError("invalid_input", `input.facts[${i}] must be { key: string, value: string }`);
    requested.push({ key: e.key, value: e.value });
  }

  const persona = await deps.demoPersonaOf(userId);
  if (!persona) throw new SeedError("not_demo_user", `user ${userId} has no app_metadata.demo_persona — seeding is for demo personas only`);

  const latest = new Map((await deps.latestFacts(userId)).map((l) => [l.fact_key, l]));
  const toWrite = requested.filter((r) => {
    const cur = latest.get(r.key);
    return !(cur && cur.value === r.value && cur.source === "seed");
  });
  const observedAt = deps.now().toISOString();

  let written = 0;
  let rebuildEnqueued = false;
  if (toWrite.length > 0) {
    const outcome = await recordFacts(
      { user_id: userId, facts: toWrite.map((r) => ({ key: r.key, value: r.value, observed_at: observedAt, source: "seed", source_ref: SEED_SOURCE_REF })) },
      deps.facts,
      ctx.correlationId,
      { internal: true, reason: "seed_facts" },
    );
    if (outcome.status !== 200) throw new SeedError(outcome.code, outcome.message);
    written = outcome.body.written;
    rebuildEnqueued = outcome.body.rebuild_enqueued;
  }

  return {
    user_id: userId,
    demo_persona: persona,
    observed_at: observedAt,
    facts: requested.map((r) => ({ fact_key: r.key, value: r.value, status: toWrite.includes(r) ? "recorded" : "unchanged" })),
    written,
    rebuild_enqueued: rebuildEnqueued,
  };
}
