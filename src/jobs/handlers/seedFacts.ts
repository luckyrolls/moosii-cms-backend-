import { randomUUID } from "crypto";
import type { Job } from "../registry";
import { DOMAIN } from "../../lib/domain";
import { supabase } from "../../supabase";
import { factsDbDeps } from "../../facts/db";
import { seedFactsForUser } from "../../facts/seed";

// seed_facts — write SEEDED facts (source 'seed', source_ref 'demo-seed') for a demo persona (auth
// app_metadata.demo_persona set), financial only. Refuses every other user. Contract: api-contract §8e.
export async function seedFactsHandler(job: Job): Promise<unknown> {
  const correlationId = randomUUID();
  const result = await seedFactsForUser(job.input, { correlationId }, {
    domain: DOMAIN,
    facts: factsDbDeps,
    now: () => new Date(),
    async demoPersonaOf(userId) {
      const { data, error } = await supabase.auth.admin.getUserById(userId);
      if (error || !data?.user) return null;
      const p = (data.user.app_metadata as Record<string, unknown> | undefined)?.demo_persona;
      return typeof p === "string" && p.trim() ? p : null;
    },
    async latestFacts(userId) {
      const { data, error } = await (supabase as any)
        .from("user_facts_latest").select("fact_key, value, source").eq("user_id", userId);
      if (error) throw new Error(`user_facts_latest read failed: ${error.message}`);
      return data ?? [];
    },
  });
  console.log(`[seed_facts] user=${result.user_id} persona=${result.demo_persona} written=${result.written} corr=${correlationId}`);
  return result;
}
