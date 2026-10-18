import { recordFacts, type FactsDeps } from "../facts/service";

// POST /demo/simulate-fact — the PURE half (api-contract §9d). FINANCIAL ONLY, authed by the DEMO SESSION (the persona
// is the token's user, never a parameter; the route runs demoGate first). Lets a demo show "the bank data changed":
// it records ONE fact for the persona through the same recordFacts core as POST /facts and derive_facts — vocabulary,
// no-amounts and conflict rules apply, the user's coalesced rebuild is enqueued, and activity follow-ups are verified
// exactly as after a real derivation.
//
// Provenance: source 'seed' (so /demo/outcomes, the partner insights and GET /facts label it seeded / Illustrative)
// with source_ref 'demo-simulate' — distinct from the §8e seed ('demo-seed'), so demo:reset can delete exactly these
// rows and the persona's real (derived) value becomes current again.

export const SIMULATE_FACT_KEYS = ["credit_utilization_band", "has_emergency_buffer"] as const;
export const SIMULATED_SOURCE_REF = "demo-simulate";

export type SimulateOutcome =
  | { status: 200; body: { persona: string; user_id: string; fact_key: string; value: string; observed_at: string;
                           written: number; rebuild_enqueued: boolean; followups_verified: number } }
  | { status: 400 | 409; code: string; message: string };

export async function simulateFact(
  who: { user_id: string; persona: string },
  body: unknown,
  ctx: { correlationId: string; now: Date },
  deps: FactsDeps,
): Promise<SimulateOutcome> {
  const b = body as Record<string, unknown> | null;
  const key = b?.fact_key;
  const value = b?.value;
  if (typeof key !== "string" || !(SIMULATE_FACT_KEYS as readonly string[]).includes(key)) {
    return { status: 400, code: "fact_not_allowed", message: `fact_key must be one of ${SIMULATE_FACT_KEYS.join(", ")}` };
  }
  if (typeof value !== "string" || !value) return { status: 400, code: "invalid_request", message: "value is required" };

  // Count what the follow-up hook verifies, without changing recordFacts' own contract.
  let verified = 0;
  const counted: FactsDeps = {
    ...deps,
    ...(deps.resolveFollowups && {
      async resolveFollowups(userId: string) {
        const r = await deps.resolveFollowups!(userId);
        verified += r.resolved;
        return r;
      },
    }),
  };
  const observedAt = ctx.now.toISOString();
  const out = await recordFacts(
    { user_id: who.user_id, facts: [{ key, value, observed_at: observedAt, source: "seed", source_ref: SIMULATED_SOURCE_REF }] },
    counted,
    ctx.correlationId,
    { internal: true, reason: "demo_simulate_fact" },
  );
  if (out.status !== 200) {
    return { status: out.status === 404 ? 400 : out.status, code: out.code, message: out.message };
  }
  return {
    status: 200,
    body: { persona: who.persona, user_id: who.user_id, fact_key: key, value, observed_at: observedAt,
            written: out.body.written, rebuild_enqueued: out.body.rebuild_enqueued, followups_verified: verified },
  };
}
