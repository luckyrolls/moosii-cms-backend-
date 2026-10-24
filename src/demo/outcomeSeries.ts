// demo_outcome_series rows — the PURE half of `npm run demo:outcomes` (scripts/demoOutcomes.ts does the I/O).
// The series is the demo's illustrative "later" story (api-contract §9b): migration 106 seeded it ONCE, relative to
// its apply date (2026-10-01), so its projected points drift into the past. The script re-writes the same shapes and
// labels relative to the RUN date: anchor = today's UTC noon, each point = anchor + its offset in days (106's rule).
// Seeded points drive nothing (never in user_facts), so re-seeding changes no plan.

import { DEMO_PERSONAS, type DemoPersona } from "./reset";

export type SeriesPoint = { persona: DemoPersona; fact_key: string; value: string; offsetDays: number; label: string };

// Same points as migration 106, same labels.
export const OUTCOME_SERIES: readonly SeriesPoint[] = [
  { persona: "sam",   fact_key: "credit_utilization_band", value: "moderate", offsetDays: 42,  label: "six weeks later (projected, seeded)" },
  { persona: "sarah", fact_key: "has_emergency_buffer",    value: "false",    offsetDays: -30, label: "a month ago (seeded)" },
  { persona: "sarah", fact_key: "has_emergency_buffer",    value: "true",     offsetDays: 21,  label: "in three weeks (projected, seeded)" },
];

const DAY_MS = 86_400_000;

export function anchorNoonUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
}

export type SeriesRow = { user_id: string; persona: DemoPersona; fact_key: string; value: string; observed_at: string; label: string };

export function seriesRows(now: Date): SeriesRow[] {
  const anchor = anchorNoonUtc(now).getTime();
  return OUTCOME_SERIES.map((p) => ({
    user_id: DEMO_PERSONAS[p.persona], persona: p.persona, fact_key: p.fact_key, value: p.value,
    observed_at: new Date(anchor + p.offsetDays * DAY_MS).toISOString(), label: p.label,
  }));
}
