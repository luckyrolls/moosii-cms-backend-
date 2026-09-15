import type { DistressTier } from "./distressNarrowing";
import type { HealthBand } from "./healthUrgency";

// Parent-facing response ORDER — PURE. Decided by Mark 2026-09-15 (H-D7):
//   safety distress > emergency > same_day > overwhelm/strain > routine > ack
// Mixed updates show BOTH the distress and the health response. The ack:
//   - suppressed when distress is strain+ (the distress response carries the moment — the rule
//     since slice 4), and when the health band is same_day or emergency (they REPLACE the ack);
//   - still shown with a routine health response (routine is order-only).

export type SupportResource = unknown;
export type ResponseItem =
  | { kind: "distress"; level: Exclude<DistressTier, "none">; message: string; resources: SupportResource }
  | { kind: "health"; level: HealthBand; message: string; resources: SupportResource };

type Copy = { message: string; resources: SupportResource } | null;

const RANK: Record<string, number> = {
  "distress:safety": 1,
  "health:emergency": 2,
  "health:same_day": 3,
  "distress:overwhelm": 4,
  "distress:strain": 4,
  "health:routine": 5,
};

export function orderResponses(input: {
  distressTier: DistressTier;
  distressResponse: Copy;
  healthBand: HealthBand | null;
  healthResponse: Copy;
}): { responses: ResponseItem[]; ackAllowed: boolean } {
  const items: ResponseItem[] = [];
  if (input.distressTier !== "none" && input.distressResponse) {
    items.push({ kind: "distress", level: input.distressTier, ...input.distressResponse });
  }
  if (input.healthBand && input.healthResponse) {
    items.push({ kind: "health", level: input.healthBand, ...input.healthResponse });
  }
  items.sort((a, b) => RANK[`${a.kind}:${a.level}`] - RANK[`${b.kind}:${b.level}`]);

  // Suppression follows the DETECTED level, not whether copy loaded: a missing copy row must not
  // turn an emergency back into a cheerful ack.
  const ackAllowed = input.distressTier === "none" && (input.healthBand === null || input.healthBand === "routine");
  return { responses: items, ackAllowed };
}
