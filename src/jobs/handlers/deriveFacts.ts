import { randomUUID } from "crypto";
import type { Job } from "../registry";
import { DOMAIN } from "../../lib/domain";
import { factsDbDeps } from "../../facts/db";
import { MxProvider } from "../../facts/derive/mxProvider";
import { deriveFactsForUser } from "../../facts/derive/derive";

// derive_facts — derive the four bank-data facts for ONE user from MX (financial only) and record
// them through the same core as POST /facts (source derived | estimated, source_ref job:<id>), which
// enqueues the user's coalesced MLP rebuild. Not an AI call, so nothing goes to ai_generation_log:
// provenance is this job row (input + result) and user_facts.source / source_ref.
// Contract: docs/api-contract.md §8d.
export async function deriveFactsHandler(job: Job): Promise<unknown> {
  const correlationId = randomUUID();
  const result = await deriveFactsForUser(job.input, { jobId: job.id, correlationId }, {
    domain: DOMAIN,
    provider: () => new MxProvider(),
    facts: factsDbDeps,
  });
  console.log(`[derive_facts] user=${result.user_id} written=${result.written} ` +
    result.facts.map((f) => `${f.fact_key}=${f.value ?? `unknown(${f.reason})`}`).join(" ") + ` corr=${correlationId}`);
  return result;
}
