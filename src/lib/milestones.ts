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

// Negation / not-yet-reached cues. A milestone described as NOT reached ("not
// crawling yet", "hasn't rolled", "won't walk", "yet to sit up") is a deliberately
// UNSERVED class (screening boundary — clinical territory), NOT a fact to record:
// the concern signal stands but resolves to NO milestone. This gate is FAIL-CLOSED
// on purpose — a false "milestone reached" fact is permanent and would let slice-3
// suppress the very questionnaire that catches the error, whereas a missed genuine
// positive is merely re-recorded on the next update. So any negation cue → skip.
const NEGATION_RE =
  /\b(?:not|no|never|without|hasn'?t|haven'?t|hadn'?t|isn'?t|wasn'?t|aren'?t|weren'?t|won'?t|can'?t|cannot|couldn'?t|didn'?t|doesn'?t|don'?t|yet)\b/i;

// Load the taxonomy (name -> id) from the DB (source of truth for the ids).
export async function loadMilestoneIds(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from("milestones").select("id, name");
  if (error) throw new Error(`Failed to load milestones: ${error.message}`);
  return new Map((data ?? []).map((m) => [m.name, m.id]));
}

// Resolve classify signals -> milestone facts (deduped). Two gates guard every
// fact-write, because a written milestone is a permanent, downstream-trusted fact:
//   GATE 1 — TYPE: only type='milestone' signals may write a milestone. A concern
//     ("not crawling yet") is NOT a reached-milestone claim, even if its words
//     overlap a milestone name.
//   GATE 2 — POLARITY: a negated/not-yet value never resolves (NEGATION_RE), so
//     "not crawling yet" can never normalize-match milestone 'crawling'.
// A signal resolves only if it clears both gates AND its value contains the slug
// (spaced) or an alias phrase. Confidence carried through.
export function resolveMilestoneFacts(
  signals: { type: string; value: string; confidence: number }[],
  nameToId: Map<string, string>,
): MilestoneFact[] {
  const facts: MilestoneFact[] = [];
  const seen = new Set<string>();
  for (const s of signals) {
    if (s.type !== "milestone") continue;              // GATE 1: type
    const v = (s.value ?? "").toLowerCase();
    if (NEGATION_RE.test(v)) continue;                 // GATE 2: polarity (fail-closed)
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
