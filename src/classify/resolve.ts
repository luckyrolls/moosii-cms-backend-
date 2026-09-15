import { isReadableChildHealth, type RawChildHealth } from "./healthUrgency";
import type { DistressTier } from "./distressNarrowing";

// The classifier's normalize → retry → marked-default loop, with the generator INJECTED so it is
// testable without a live LLM. Moved out of src/routes/classifyUpdate.ts (which re-exports it) so
// it can be unit-tested without importing the Supabase client.

export type { DistressTier };
const DISTRESS_TIERS: DistressTier[] = ["none", "strain", "overwhelm", "safety"];

export type LlmSignal   = { type: string; value: string; confidence: number; evidence_span: string };
export type LlmProposal = { track_id: string; confidence: number; source_signal: string };
export type LlmDistress = { tier: string; evidence_span: string };
export type LlmOut      = { relevant: boolean; signals: LlmSignal[]; proposed_enrichments: LlmProposal[]; distress?: LlmDistress; child_health?: unknown };

export type GenResult = { text: string; raw: unknown; model: string };

// Recover a near-miss tier ("Safety", "SAFETY ", "overwhelm.") to a canonical value.
// Returns null ONLY when the value is genuinely unreadable — the caller RE-ASKS on
// null (never silently defaults), because a garbled safety read must not become none.
export function normalizeTier(raw: unknown): DistressTier | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase().replace(/[^a-z]/g, "");
  return (DISTRESS_TIERS as string[]).includes(t) ? (t as DistressTier) : null;
}

export type Resolution = {
  out: LlmOut;
  result: GenResult;
  distressTier: DistressTier;
  distressParseFailed: boolean;
  childHealth: RawChildHealth | null;   // null when not expected, or unreadable after retries
  childHealthParseFailed: boolean;      // true ONLY when expected and still unreadable after retries
  attempts: number;
};

// A response is "good" only when it parses, its distress tier is readable, and — when the prompt
// asks for child_health (expectChildHealth) — its child_health object is readable. Anything else
// is a FAILED generation and is re-asked up to attemptsMax. After that: never-JSON is a hard
// failure; JSON with an unreadable distress tier defaults to none MARKED parse_failed (D11); an
// unreadable child_health is MARKED parse_failed (H-D9) — neither is ever a silent "nothing".
export async function resolveClassification(
  generate: () => Promise<GenResult>,
  attemptsMax = 3,
  opts: { expectChildHealth?: boolean } = {},
): Promise<Resolution> {
  let out: LlmOut | null = null;
  let result!: GenResult;
  let bestTier: DistressTier | null = null;         // readable tier from the latest attempt that had one
  let bestHealth: RawChildHealth | null = null;     // readable child_health from the latest attempt that had one
  let attempts = 0;
  for (attempts = 1; attempts <= attemptsMax; attempts++) {
    result = await generate();
    let parsed: LlmOut;
    try {
      parsed = JSON.parse(result.text) as LlmOut;
    } catch {
      console.warn(`[classify_update] attempt ${attempts}: non-JSON response — re-asking`);
      continue;
    }
    out = parsed;
    const tier = normalizeTier(parsed.distress?.tier);
    const healthOk = !opts.expectChildHealth || isReadableChildHealth(parsed.child_health);
    if (tier !== null) bestTier = tier;
    if (opts.expectChildHealth && isReadableChildHealth(parsed.child_health)) bestHealth = parsed.child_health;
    if (tier !== null && healthOk) {
      return {
        out, result, distressTier: tier, distressParseFailed: false,
        childHealth: opts.expectChildHealth ? (parsed.child_health as RawChildHealth) : null,
        childHealthParseFailed: false, attempts,
      };
    }
    if (tier === null) console.warn(`[classify_update] attempt ${attempts}: distress tier unreadable (${JSON.stringify(parsed.distress?.tier)}) — re-asking`);
    if (!healthOk) console.warn(`[classify_update] attempt ${attempts}: child_health unreadable — re-asking`);
  }
  if (out === null) {
    throw new Error(`Classifier returned non-JSON after ${attemptsMax} attempts.\nRaw: ${result.text}`);
  }
  // Exhausted. Use the LATEST parse for signals/proposals; keep any readable distress tier or
  // child_health seen along the way rather than discarding a real read.
  const distressParseFailed = bestTier === null;
  const childHealthParseFailed = !!opts.expectChildHealth && bestHealth === null;
  if (distressParseFailed) console.error(`[classify_update] distress UNREADABLE after ${attemptsMax} attempts — defaulting tier=none WITH parse_failed marker`);
  if (childHealthParseFailed) console.error(`[classify_update] child_health UNREADABLE after ${attemptsMax} attempts — band=null WITH parse_failed marker`);
  return {
    out, result,
    distressTier: bestTier ?? "none", distressParseFailed,
    childHealth: bestHealth, childHealthParseFailed,
    attempts: attemptsMax,
  };
}
