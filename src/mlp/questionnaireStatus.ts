import { supabase } from "../supabase";
import {
  loadUserMlpInputs,
  computeMilestoneSuppressionDetail,
  matchRecurringBand,
  isQuestionnaireDue,
  type Band,
} from "../jobs/handlers/rebuildMlp";

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
};

const DAY = 86_400_000;

export async function assembleQuestionnaireStatus(userId: string): Promise<QuestionnaireStatusEntry[]> {
  // Same universe the rebuild uses: published pool items in the user's active tracks.
  // (Questionnaires carry open [null, null] age bounds, so the rebuild's downstream
  // age filter never removes them — this pool IS the questionnaire universe.)
  const { pool } = await loadUserMlpInputs(userId);
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
  const entries: QuestionnaireStatusEntry[] = questionnaires.map((q) => {
    const qid = q.item_id;
    const latest = latestByQ.get(qid) ?? null;
    const bands = bandsByQ.get(qid) ?? [];
    // Single source of truth: matchRecurringBand picks the governing band; isQuestionnaireDue
    // decides due-ness. Both are the same functions the rebuild uses.
    const matched = latest ? matchRecurringBand(latest.score, bands) : null;
    const due = latest && matched
      ? isQuestionnaireDue(latest.score, new Date(latest.created_at).getTime(), bands, now)
      : false;
    const dueAt = latest && matched
      ? new Date(new Date(latest.created_at).getTime() + matched.days * DAY).toISOString()
      : null;
    const supp = suppression.get(qid) ?? null;

    // Precedence mirrors the rebuild: suppression trumps due-ness. Due/answer fields
    // are still included as secondary context when suppressed.
    let status: QuestionnaireStatus;
    if (supp) status = "suppressed";
    else if (!latest) status = "never_answered";
    else if (!matched) status = "answered_one_shot";
    else if (due) status = "due_now";
    else status = "answered_awaiting";

    return {
      questionnaire_id: qid,
      questionnaire_name: q.item_name ?? null,
      published: true, // the pool is published-only
      status,
      latest_answer_at: latest?.created_at ?? null,
      latest_score: latest?.score ?? null,
      matched_band: matched
        ? { score_min_range: matched.min, score_max_range: matched.max, repeat_after_days: matched.days }
        : null,
      due_at: dueAt,
      suppressed_by: supp,
    };
  });

  entries.sort((a, b) => (a.questionnaire_name ?? "").localeCompare(b.questionnaire_name ?? ""));
  return entries;
}
