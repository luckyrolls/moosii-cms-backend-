import { computeUserMlp } from "../jobs/handlers/rebuildMlp";

// ---------------------------------------------------------------------------
// MLP preview for the CMS user-MLP inspector. Read-only: recomputes the path with
// overridden inputs (a chosen age and/or including completed items) WITHOUT
// persisting. Reuses the rebuild's own compute core (computeUserMlp) — no duplicated
// due/suppression/age logic; the preview and the persisted rebuild run the same code.
// ---------------------------------------------------------------------------

export type MlpPreviewItem = {
  position: number;
  item_id: string;
  item_type: string;
  item_name: string;
  track_id: string;
  track_name: string;
  track_weight: number | null;
  track_priority: number | null;
  item_priority: number | null;
  with_quiz: boolean;
};

export type MlpPreview = {
  user_id: string;
  child_age_months: number | null;
  age_months: number | null;
  include_completed: boolean;
  items: MlpPreviewItem[];
};

// Validate the ?age_months= query param. Absent/empty → no override (use the real
// child age). Present → must be a non-negative integer. Exported so the 400 guard is
// unit-testable without an admin token (auth runs before the handler over HTTP).
export function parseAgeMonthsParam(
  raw: unknown
): { ok: true; ageMonths?: number } | { ok: false; message: string } {
  if (raw === undefined || raw === "") return { ok: true };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, message: "age_months must be a non-negative integer" };
  }
  return { ok: true, ageMonths: n };
}

export async function assembleMlpPreview(
  userId: string,
  opts: { ageMonthsOverride?: number; includeCompleted: boolean }
): Promise<MlpPreview> {
  const compute = await computeUserMlp(userId, {
    ageMonthsOverride: opts.ageMonthsOverride,
    includeCompleted: opts.includeCompleted,
  });

  return {
    user_id: userId,
    child_age_months: compute.childAgeMonths,
    age_months: compute.ageMonthsUsed,
    include_completed: opts.includeCompleted,
    items: compute.items.map((i) => ({
      position: i.position,
      item_id: i.item_id,
      item_type: i.item_type,
      item_name: i.item_name,
      track_id: i.track_id,
      track_name: i.track_name,
      track_weight: i.track_weight,
      track_priority: i.track_priority,
      item_priority: i.item_priority,
      with_quiz: i.with_quiz,
    })),
  };
}
