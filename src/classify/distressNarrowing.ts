// Distress narrowing, layer 2 (the code backstop to prompt rule 6, migration 083). PURE.
// Decision D2/D4 proposed change (provisional-clinical-decisions.md): when the ONLY evidence for
// strain/overwhelm is the child's symptom wording, the tier is narrowed to none — and marked
// (downgraded_from) so it is audited, never silent.
//
// SAFETY IS NEVER DOWNGRADED: 'safety' (and 'none') pass through untouched, by construction.
// An empty evidence span is never downgraded either — there is nothing to show it is symptom-only,
// and distress stays lenient (D4).

export type DistressTier = "none" | "strain" | "overwhelm" | "safety";

function norm(s: string): string {
  return s.toLowerCase().replace(/[“”"'’`]/g, "").replace(/\s+/g, " ").trim();
}

// Split an evidence span into its clauses on sentence/clause punctuation and " and "/" but ".
function clauses(span: string): string[] {
  return norm(span)
    .split(/[.;!?,]|\s(?:and|but)\s/)
    .map((c) => c.replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, "").trim())
    .filter((c) => c.length > 0);
}

export function narrowDistress(
  tier: DistressTier,
  evidenceSpan: string | null,
  healthSpans: string[],
): { tier: DistressTier; downgraded_from: "strain" | "overwhelm" | null } {
  if (tier !== "strain" && tier !== "overwhelm") return { tier, downgraded_from: null };
  const evidence = (evidenceSpan ?? "").trim();
  const spans = healthSpans.map(norm).filter((s) => s.length > 0);
  if (!evidence || spans.length === 0) return { tier, downgraded_from: null };

  const parts = clauses(evidence);
  if (parts.length === 0) return { tier, downgraded_from: null };
  const symptomOnly = parts.every((p) => spans.some((s) => s.includes(p)));
  return symptomOnly ? { tier: "none", downgraded_from: tier } : { tier, downgraded_from: null };
}
