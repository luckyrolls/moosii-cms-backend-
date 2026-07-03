import { supabase } from "../supabase";

// Slice-2 (b): code-side alias resolver mapping a classify signal's free-form value
// to a canonical milestone slug. Keyed by the taxonomy `name` seeded in migration
// 019. THE ONE OBVIOUS PLACE for milestone phrasing — extend here as the
// unmatched-signal report surfaces new phrasings. Unresolved values degrade into
// unmatched signals (the fail-safe); never stretch a match.
// Future precision: have the classifier emit a canonical milestone key instead.
export const MILESTONE_ALIASES: Record<string, string[]> = {
  rolling:                ["rolling over", "rolled over", "rolls over", "rolling"],
  sitting:                ["sitting up", "sits up", "sat up", "sitting unassisted"],
  crawling:               ["crawling", "crawls", "started to crawl", "crawl"],
  pulling_up:             ["pulling up", "pulled up", "pulls up", "pull to stand", "pulling to stand"],
  walking:                ["walking", "first steps", "took her first steps", "took his first steps", "started walking", "walks"],
  babbling:               ["babbling", "babbles", "babble"],
  first_words:            ["first word", "first words", "said mama", "said dada", "said her first word", "said his first word"],
  solids:                 ["solid food", "solid foods", "started solids", "starting solids", "eating solids", "first foods"],
  teething:               ["teething", "first tooth", "cutting teeth", "getting teeth"],
  separation_anxiety:     ["separation anxiety", "cries when i leave", "clingy when i leave", "upset when i leave"],
  sleeping_through_night: ["slept through the night", "sleeping through the night", "sleeps through the night", "through the night"],
};

export type MilestoneFact = { milestone_id: string; confidence: number | null };

// Load the taxonomy (name -> id) from the DB (source of truth for the ids).
export async function loadMilestoneIds(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from("milestones").select("id, name");
  if (error) throw new Error(`Failed to load milestones: ${error.message}`);
  return new Map((data ?? []).map((m) => [m.name, m.id]));
}

// Resolve classify signals -> milestone facts (deduped). A signal resolves if its
// value contains the slug (spaced) or any alias phrase. Confidence carried through.
export function resolveMilestoneFacts(
  signals: { value: string; confidence: number }[],
  nameToId: Map<string, string>,
): MilestoneFact[] {
  const facts: MilestoneFact[] = [];
  const seen = new Set<string>();
  for (const s of signals) {
    const v = (s.value ?? "").toLowerCase();
    let slug: string | undefined;
    for (const [key, phrases] of Object.entries(MILESTONE_ALIASES)) {
      if (v.includes(key.replace(/_/g, " ")) || phrases.some((p) => v.includes(p))) { slug = key; break; }
    }
    if (!slug) continue;
    const id = nameToId.get(slug);
    if (id && !seen.has(id)) {
      seen.add(id);
      facts.push({ milestone_id: id, confidence: typeof s.confidence === "number" ? s.confidence : null });
    }
  }
  return facts;
}
