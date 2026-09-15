import { supabase } from "../supabase";
import { enqueueRebuildUserIfIdle } from "../jobs/runner";
import { UnknownUserError, type FactsDeps, type ExistingObservation } from "./service";
import type { FactsReadDeps } from "./router";
import type { FactRow, Vocabulary } from "./validate";

// Real deps for /facts — the service-role client, like every other route (RLS bypassed).

async function loadVocabulary(): Promise<Vocabulary> {
  const { data, error } = await supabase.from("fact_values").select("fact_key, value");
  if (error) throw new Error(`fact vocabulary load failed: ${error.message}`);
  const values = new Map<string, Set<string>>();
  for (const row of data ?? []) {
    const set = values.get(row.fact_key) ?? new Set<string>();
    set.add(row.value);
    values.set(row.fact_key, set);
  }
  return { values };
}

async function findExisting(userId: string, keys: string[], observedAts: string[]): Promise<ExistingObservation[]> {
  if (keys.length === 0 || observedAts.length === 0) return [];
  const { data, error } = await supabase
    .from("user_facts")
    .select("fact_key, value, observed_at")
    .eq("user_id", userId)
    .in("fact_key", keys)
    .in("observed_at", observedAts);
  if (error) throw new Error(`existing-observation lookup failed: ${error.message}`);
  return data ?? [];
}

// ONE statement → one transaction: every row lands or none does. ON CONFLICT DO NOTHING makes an
// identical redelivery a no-op (the conflict check in service.ts has already refused contradictions).
async function insertRows(rows: FactRow[]): Promise<{ written: number }> {
  const { data, error } = await supabase
    .from("user_facts")
    .upsert(rows, { onConflict: "user_id,fact_key,observed_at", ignoreDuplicates: true })
    .select("id");
  if (error) {
    if (error.code === "23503" && /user_facts_user_id_fkey/.test(`${error.message} ${error.details ?? ""}`)) {
      throw new UnknownUserError(rows[0]?.user_id ?? "(none)");
    }
    throw new Error(`user_facts insert failed (${error.code}): ${error.message}`);
  }
  return { written: (data ?? []).length };
}

async function loadFactsForUser(userId: string, historyLimit: number): Promise<{ latest: unknown[]; history: unknown[] }> {
  const [latest, history] = await Promise.all([
    supabase
      .from("user_facts_latest")
      .select("fact_key, value, observed_at, source, source_ref")
      .eq("user_id", userId)
      .order("fact_key", { ascending: true }),
    supabase
      .from("user_facts")
      .select("fact_key, value, observed_at, source, source_ref, created_at")
      .eq("user_id", userId)
      .order("observed_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(historyLimit),
  ]);
  if (latest.error) throw new Error(`user_facts_latest read failed: ${latest.error.message}`);
  if (history.error) throw new Error(`user_facts read failed: ${history.error.message}`);
  return { latest: latest.data ?? [], history: history.data ?? [] };
}

export const factsDbDeps: FactsDeps & FactsReadDeps = {
  loadVocabulary,
  findExisting,
  insertRows,
  enqueueRebuild: (userId, ctx) => enqueueRebuildUserIfIdle(userId, ctx),
  loadFactsForUser,
};
