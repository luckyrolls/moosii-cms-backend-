// GET /plan — the PURE half (api-contract §11). Turns the member's persisted plan rows (user_mlp) plus the reason rows
// (user_track_reasons_for_user, migration 119) into the response: items in position order, and one entry per track
// carrying its authored reasons and how many plan items it contributed.
//
// NOTHING here recomputes anything. The plan is read as the rebuild left it — the frozen algorithm is not involved
// (invariant 1), and a reason can never add, remove or reorder an item.

// Why a track is in the plan. The kinds are the UNION arms of user_active_tracks_for_user:
//   default       — every member gets it (new_user_tracks)
//   fact          — a fact_track_rules rule matched the member's current value; carries that observation
//   demographic   — a demographic answer routed it
//   questionnaire — a questionnaire answer's action added it
//   insight       — a user_mlp_mods 'add' with a backing user_track_activations row (source, confidence)
//   manual        — a user_mlp_mods 'add' with no activation row: a human put it there
export const REASON_KINDS = ["default", "fact", "demographic", "questionnaire", "insight", "manual"] as const;
export type ReasonKind = (typeof REASON_KINDS)[number];

// Which reason to show when a track has several (Building a Buffer can match has_emergency_buffer=false AND
// saving_for_home=true, and a default track can also be fact-matched). MOST SPECIFIC FIRST: a reason about this
// member's own data beats "everyone gets this". Only used for the item's convenience `why`; `tracks[].reasons`
// always carries the full set, so a client can ignore this ordering entirely.
export const WHY_PREFERENCE: readonly ReasonKind[] = ["fact", "insight", "questionnaire", "demographic", "manual", "default"];

export type PlanItemRaw = {
  item_id: string; item_type: string; position: number | null;
  item_name: string | null; item_description: string | null; with_quiz: boolean | null;
  track_id: string; track_name: string | null; updated_at: string | null;
};

export type ReasonRaw = {
  track_id: string; track_name: string | null; kind: string; label: string | null;
  fact_key: string | null; value: string | null; observed_at: string | null;
  source: string | null; source_ref: string | null; confidence: number | null; action_at: string | null;
};

export type PlanReason = {
  kind: ReasonKind; label: string | null;
  fact_key: string | null; value: string | null; observed_at: string | null;
  source: string | null; confidence: number | null; at: string | null;
};

export type PlanItem = {
  position: number | null; item_id: string; item_type: string;
  item_name: string | null; item_description: string | null; with_quiz: boolean;
  track_id: string; track_name: string | null;
  why: { kind: ReasonKind; label: string | null } | null;
};

export type PlanTrack = {
  track_id: string; track_name: string | null; item_count: number; reasons: PlanReason[];
};

export type PlanResponse = {
  user_id: string; generated_at: string | null; items: PlanItem[]; tracks: PlanTrack[];
};

const isKind = (k: string): k is ReasonKind => (REASON_KINDS as readonly string[]).includes(k);

function toReason(r: ReasonRaw): PlanReason | null {
  if (!isKind(r.kind)) return null;           // an unknown kind is dropped, never guessed
  return {
    kind: r.kind, label: r.label ?? null,
    fact_key: r.fact_key ?? null, value: r.value ?? null, observed_at: r.observed_at ?? null,
    source: r.source ?? null, confidence: r.confidence ?? null, at: r.action_at ?? null,
  };
}

// The reason to show on an item: the most specific one by WHY_PREFERENCE. A LABELLED reason always wins over an
// unlabelled one of a more specific kind, because an unlabelled reason has nothing to display (no fallback text —
// a kind with no authored copy returns label: null and the client decides).
export function pickWhy(reasons: PlanReason[]): { kind: ReasonKind; label: string | null } | null {
  if (reasons.length === 0) return null;
  const rank = (r: PlanReason) => WHY_PREFERENCE.indexOf(r.kind);
  const labelled = reasons.filter((r) => r.label !== null);
  const pool = labelled.length > 0 ? labelled : reasons;
  const best = pool.reduce((a, b) => (rank(b) < rank(a) ? b : a));
  return { kind: best.kind, label: best.label };
}

// Items come back in position order (NULL last, then item_id, so the order is total and stable). A track with reasons
// but no item still appears in `tracks` with item_count 0 — that is the diagnostic for "the track activated but all
// its lessons are unpublished", which otherwise looks like nothing happened.
export function toPlan(userId: string, rows: PlanItemRaw[], reasonRows: ReasonRaw[]): PlanResponse {
  const reasonsByTrack = new Map<string, PlanReason[]>();
  const nameByTrack = new Map<string, string | null>();
  for (const r of reasonRows) {
    const reason = toReason(r);
    if (!reason) continue;
    if (!reasonsByTrack.has(r.track_id)) reasonsByTrack.set(r.track_id, []);
    reasonsByTrack.get(r.track_id)!.push(reason);
    if (!nameByTrack.has(r.track_id)) nameByTrack.set(r.track_id, r.track_name ?? null);
  }

  const sorted = [...rows].sort((a, b) => {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER;
    const pb = b.position ?? Number.MAX_SAFE_INTEGER;
    return pa - pb || (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0);
  });

  const countByTrack = new Map<string, number>();
  for (const r of rows) countByTrack.set(r.track_id, (countByTrack.get(r.track_id) ?? 0) + 1);

  const items: PlanItem[] = sorted.map((r) => ({
    position: r.position ?? null, item_id: r.item_id, item_type: r.item_type,
    item_name: r.item_name ?? null, item_description: r.item_description ?? null,
    with_quiz: r.with_quiz ?? false,
    track_id: r.track_id, track_name: r.track_name ?? null,
    why: pickWhy(reasonsByTrack.get(r.track_id) ?? []),
  }));

  // Every track that has an item OR a reason, named from whichever source knows it.
  const trackIds = [...new Set([...countByTrack.keys(), ...reasonsByTrack.keys()])];
  const trackNameFromItems = new Map<string, string | null>();
  for (const r of rows) if (!trackNameFromItems.has(r.track_id)) trackNameFromItems.set(r.track_id, r.track_name ?? null);

  const tracks: PlanTrack[] = trackIds
    .map((id) => ({
      track_id: id,
      track_name: trackNameFromItems.get(id) ?? nameByTrack.get(id) ?? null,
      item_count: countByTrack.get(id) ?? 0,
      reasons: reasonsByTrack.get(id) ?? [],
    }))
    .sort((a, b) => (b.item_count - a.item_count) || ((a.track_name ?? "") < (b.track_name ?? "") ? -1 : 1));

  const stamps = rows.map((r) => r.updated_at).filter((t): t is string => !!t);
  const generatedAt = stamps.length > 0 ? stamps.reduce((a, b) => (a > b ? a : b)) : null;

  return { user_id: userId, generated_at: generatedAt, items, tracks };
}
