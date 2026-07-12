import { supabase } from "../supabase";
import {
  loadUserMlpInputs,
  computeMilestoneSuppressionDetail,
  matchRecurringBand,
  isQuestionnaireDue,
  type Band,
} from "../jobs/handlers/rebuildMlp";
import { isAgeEligible } from "./generateFullMLP";

// ---------------------------------------------------------------------------
// Per-user questionnaire lifecycle status for the CMS user-MLP inspector.
//
// Read-only. Runs the REAL recurrence + suppression logic over the real rows —
// it reuses loadUserMlpInputs (same pool/universe the rebuild computes over),
// matchRecurringBand + isQuestionnaireDue (the pure due math), and
// computeMilestoneSuppressionDetail (the exact suppression resolution). No parallel
// due logic, no writes, no MLP side effects.
// ---------------------------------------------------------------------------

export type QuestionnaireStatus =
  | "never_answered"
  | "answered_one_shot"
  | "answered_awaiting"
  | "due_now"
  | "suppressed";

export type QuestionnaireStatusEntry = {
  questionnaire_id: string;
  questionnaire_name: string | null;
  published: boolean;
  status: QuestionnaireStatus;
  // Populated once answered (secondary fields — present even when status=suppressed).
  latest_answer_at: string | null;
  latest_score: number | null;
  matched_band: { score_min_range: number | null; score_max_range: number | null; repeat_after_days: number } | null;
  due_at: string | null;
  // Populated only when suppressed — the milestone fact that caused it.
  suppressed_by: { milestone_id: string; milestone_name: string | null } | null;
  // Age gate — ORTHOGONAL to `status` (a questionnaire can be gated AND due/suppressed/
  // answered), so it's a flag, not a status value. `age_gated` = the youngest child is
  // outside the questionnaire's age bounds, so the real MLP (generateFullMLP) drops it
  // right now. Computed with the SAME predicate the pool filter uses (isAgeEligible).
  // Display precedence (recommended): suppressed > age_gated > due_now > answered_awaiting
  // > answered_one_shot > never_answered — mirrors the pipeline (suppression removes
  // before the age filter), and gated outranks due because a gated item isn't actually
  // surfaced. The payload keeps `status` AND `age_gated` so nothing is lost.
  age_gated: boolean;
  age_gate_months: number | null;     // the questionnaire's lower age bound (== questionnaire.age post-041)
  youngest_age_months: number | null; // the user's youngest-child age used for the check
};

const DAY = 86_400_000;

export async function assembleQuestionnaireStatus(userId: string): Promise<QuestionnaireStatusEntry[]> {
  // Same universe the rebuild uses: published pool items in the user's active tracks.
  // The universe is the RAW pool (BEFORE the age filter): the inspector reports EVERY
  // questionnaire and never drops age-gated ones — gating is surfaced per-entry via the
  // `age_gated` flag (see classifyQuestionnaire), not by removal. (Pre-041 this pool
  // happened to equal the age-filtered set because questionnaires carried [null,null]
  // bounds; 041 gave them a real lower bound, so the two now differ and we flag it.)
  const { pool, youngestAgeMonths } = await loadUserMlpInputs(userId);
  const questionnaires = pool.filter((i) => i.item_type === "questionnaire");
  if (questionnaires.length === 0) return [];
  const qIds = questionnaires.map((q) => q.item_id);

  // Suppression detail — the exact resolution the rebuild runs. Default-to-surface on
  // error (mirrors the rebuild's try/catch): no suppression rather than false-hide.
  let suppression = new Map<string, { milestone_id: string; milestone_name: string | null }>();
  try {
    const hits = await computeMilestoneSuppressionDetail(userId, pool);
    suppression = new Map(hits.map((h) => [h.questionnaireId, { milestone_id: h.milestoneId, milestone_name: h.milestoneName }]));
  } catch (e) {
    console.warn(`[questionnaire_status] suppression resolution failed for ${userId}; reporting none: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Latest completed answer per questionnaire (score + when).
  const { data: completed, error: cErr } = await supabase
    .from("completed_items")
    .select("item_id, score, created_at")
    .eq("user_id", userId)
    .eq("item_type", "questionnaire")
    .in("item_id", qIds);
  if (cErr) throw new Error(`completed_items query failed: ${cErr.message}`);
  const latestByQ = new Map<string, { score: number | null; created_at: string }>();
  for (const r of completed ?? []) {
    if (!r.item_id) continue;
    const prev = latestByQ.get(r.item_id);
    if (!prev || new Date(r.created_at) > new Date(prev.created_at)) {
      latestByQ.set(r.item_id, { score: r.score, created_at: r.created_at });
    }
  }

  // Recurring bands (repeat_after_days NOT NULL) per questionnaire.
  const { data: bandRows, error: bErr } = await supabase
    .from("questionnaire_response")
    .select("questionnaire_id, score_min_range, score_max_range, repeat_after_days")
    .in("questionnaire_id", qIds)
    .not("repeat_after_days", "is", null);
  if (bErr) throw new Error(`questionnaire_response query failed: ${bErr.message}`);
  const bandsByQ = new Map<string, Band[]>();
  for (const b of bandRows ?? []) {
    if (!b.questionnaire_id || b.repeat_after_days === null) continue;
    const list = bandsByQ.get(b.questionnaire_id) ?? [];
    list.push({ min: b.score_min_range, max: b.score_max_range, days: b.repeat_after_days });
    bandsByQ.set(b.questionnaire_id, list);
  }

  const now = Date.now();
  // One entry per questionnaire — the universe is preserved (never filtered by the gate).
  const entries: QuestionnaireStatusEntry[] = questionnaires.map((q) =>
    classifyQuestionnaire(q, {
      youngestAgeMonths,
      latest: latestByQ.get(q.item_id) ?? null,
      bands: bandsByQ.get(q.item_id) ?? [],
      suppressedBy: suppression.get(q.item_id) ?? null,
      now,
    })
  );

  entries.sort((a, b) => (a.questionnaire_name ?? "").localeCompare(b.questionnaire_name ?? ""));
  return entries;
}

// Inputs a questionnaire pool item carries for classification.
type QuestionnairePoolItem = {
  item_id: string;
  item_name?: string | null;
  min_child_age?: number | null;
  max_child_age?: number | null;
};

export type QuestionnaireClassifyCtx = {
  youngestAgeMonths: number | null;
  latest: { score: number | null; created_at: string } | null;
  bands: Band[];
  suppressedBy: { milestone_id: string; milestone_name: string | null } | null;
  now: number;
};

// Pure per-questionnaire classifier — the answer lifecycle status PLUS the orthogonal age
// gate. No DB, no side effects (exported for unit testing). Status uses the same pure due
// math the rebuild uses (matchRecurringBand + isQuestionnaireDue); the age gate uses the
// same predicate the pool filter uses (isAgeEligible). Suppression trumps due (unchanged);
// the age gate is reported separately so a gated-AND-due (or gated-AND-suppressed)
// questionnaire keeps both facts.
export function classifyQuestionnaire(
  q: QuestionnairePoolItem,
  ctx: QuestionnaireClassifyCtx
): QuestionnaireStatusEntry {
  const { youngestAgeMonths, latest, bands, suppressedBy, now } = ctx;

  const matched = latest ? matchRecurringBand(latest.score, bands) : null;
  const due = latest && matched
    ? isQuestionnaireDue(latest.score, new Date(latest.created_at).getTime(), bands, now)
    : false;
  const dueAt = latest && matched
    ? new Date(new Date(latest.created_at).getTime() + matched.days * DAY).toISOString()
    : null;

  // Answer lifecycle status — UNCHANGED. Suppression trumps due-ness (mirrors the rebuild).
  let status: QuestionnaireStatus;
  if (suppressedBy) status = "suppressed";
  else if (!latest) status = "never_answered";
  else if (!matched) status = "answered_one_shot";
  else if (due) status = "due_now";
  else status = "answered_awaiting";

  return {
    questionnaire_id: q.item_id,
    questionnaire_name: q.item_name ?? null,
    published: true, // the pool is published-only
    status,
    latest_answer_at: latest?.created_at ?? null,
    latest_score: latest?.score ?? null,
    matched_band: matched
      ? { score_min_range: matched.min, score_max_range: matched.max, repeat_after_days: matched.days }
      : null,
    due_at: dueAt,
    suppressed_by: suppressedBy,
    // ORTHOGONAL age gate — same predicate as generateFullMLP's pool filter.
    age_gated: !isAgeEligible(youngestAgeMonths, q.min_child_age, q.max_child_age),
    age_gate_months: q.min_child_age ?? null,
    youngest_age_months: youngestAgeMonths,
  };
}
