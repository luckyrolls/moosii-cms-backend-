// GET /activity-followups/recent — the PURE half (api-contract §10). The reader shows a follow-up that data just
// resolved, which the due view (committed + due only) never returns. Rows: every committed follow-up (due or not) plus
// every follow-up resolved in the last RECENT_WINDOW_DAYS, newest first. No amounts, no Moosies fields.

export const RECENT_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

// The resolving fact's provenance, so a client can label a simulated verification Illustrative:
//   demo-simulated — written by POST /demo/simulate-fact (source 'seed', source_ref 'demo-simulate', §9d)
//   seeded         — any other seed row (the §8e demo seed)
//   derived        — a real observation: derived / estimated from linked accounts, or partner-reported
// null when the follow-up isn't verified, or its evidence row is gone (ON DELETE SET NULL).
export type VerifiedSource = "derived" | "seeded" | "demo-simulated";

export function verifiedSource(fact: { source: string; source_ref: string | null } | null): VerifiedSource | null {
  if (!fact) return null;
  if (fact.source === "seed") return fact.source_ref === "demo-simulate" ? "demo-simulated" : "seeded";
  return "derived";
}

export type RecentRaw = {
  id: string; lesson_id: string; status: string; asks: number;
  due_at: string | null; committed_at: string | null; resolved_at: string | null; resolved_by: string | null;
  verified_at: string | null; created_at: string;
  lesson: { lesson_name: string | null } | null;
  fact: { source: string; source_ref: string | null } | null;
};

export type RecentFollowup = {
  id: string; lesson_id: string; lesson_name: string | null; status: string; asks: number;
  due_at: string | null; resolved_at: string | null; resolved_by: string | null;
  verified_at: string | null; verified_source: VerifiedSource | null;
};

export function recentSince(now: Date): string {
  return new Date(now.getTime() - RECENT_WINDOW_DAYS * DAY_MS).toISOString();
}

// Filters again (the query already does) so the rule is one testable function, then orders newest first by the row's
// latest moment: resolved_at, else committed_at, else created_at.
export function toRecent(rows: RecentRaw[], now: Date): RecentFollowup[] {
  const since = Date.parse(recentSince(now));
  const latest = (r: RecentRaw) => Date.parse(r.resolved_at ?? r.committed_at ?? r.created_at);
  return rows
    .filter((r) => r.status === "committed" || (r.resolved_at !== null && Date.parse(r.resolved_at) >= since))
    .sort((a, b) => latest(b) - latest(a) || (a.id < b.id ? -1 : 1))
    .map((r) => ({
      id: r.id, lesson_id: r.lesson_id, lesson_name: r.lesson?.lesson_name ?? null, status: r.status, asks: r.asks,
      due_at: r.due_at, resolved_at: r.resolved_at, resolved_by: r.resolved_by,
      verified_at: r.verified_at, verified_source: r.verified_at ? verifiedSource(r.fact) : null,
    }));
}
