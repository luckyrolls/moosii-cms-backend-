import { supabase } from "../supabase";

// The check-in atom tables (questionnaire_answer_actions, questionnaire_user_answers) and
// questionnaire.kind are ahead of parts of database.types.ts in this env. Single untyped
// bridge for this module; drop when the types fully catch up.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type CheckinMilestoneFact = {
  source_ref: string; // questionnaire_user_answers.id — the ANSWER row (provenance pointer)
  milestone_id: string;
  questionnaire_id: string; // carried for the structured skip log
};

// Resolve the CANDIDATE check-in milestone facts for a user: a `record_milestone` action
// on an answer the user gave, on a kind='checkin' questionnaire the user has COMPLETED.
//
// Gates (all three must hold):
//   • COMPLETION — the questionnaire has a completed_items row for this user (item_type=
//     'questionnaire', item_id = questionnaire id — the same completion convention the MLP
//     rebuild uses). "Finished and submitted" is structural, not inferred from a bare
//     answer row (a future partial-save/resume feature could leave answers for an
//     unfinished session; a milestone fact is permanent with no un-record path).
//   • KIND — q.kind='checkin' (defense-in-depth, mirroring view 049; the CMS only authors
//     actions on check-ins, but we do not rely on that).
//   • ACTION — questionnaire_answer_actions.action_type='record_milestone' (migration 051
//     guarantees at most one such action per answer, so no fan-out).
//
// "Unrecorded" is realized at WRITE time by ON CONFLICT (child_id, milestone_id) DO NOTHING
// — this returns candidates; the DB unique makes the net effect first-reach-wins (a fact the
// classifier already recorded is left untouched). In-memory join (no RPC): questionnaire_
// user_answers and questionnaire_answer_actions both FK questionnaire_answers.id via
// answer_id, so PostgREST cannot embed one under the other; we fetch and join in code.
export async function resolveUnrecordedCheckinMilestones(userId: string): Promise<CheckinMilestoneFact[]> {
  // 1. The user's answers.
  const { data: quaRows, error: quaErr } = await db
    .from("questionnaire_user_answers")
    .select("id, answer_id, questionnaire_id")
    .eq("user_id", userId);
  if (quaErr) throw new Error(`questionnaire_user_answers query failed: ${quaErr.message}`);
  const qua = (quaRows ?? []) as Array<{ id: string; answer_id: string; questionnaire_id: string }>;
  if (qua.length === 0) return [];

  // 2. COMPLETION gate — questionnaires the user has actually completed.
  const { data: compRows, error: compErr } = await db
    .from("completed_items")
    .select("item_id")
    .eq("user_id", userId)
    .eq("item_type", "questionnaire");
  if (compErr) throw new Error(`completed_items query failed: ${compErr.message}`);
  const completed = new Set(((compRows ?? []) as Array<{ item_id: string }>).map((r) => r.item_id));
  const answeredCompleted = qua.filter((q) => completed.has(q.questionnaire_id));
  if (answeredCompleted.length === 0) return [];

  // 3. record_milestone actions on those answers (051: <= 1 per answer).
  const answerIds = [...new Set(answeredCompleted.map((q) => q.answer_id))];
  const { data: actRows, error: actErr } = await db
    .from("questionnaire_answer_actions")
    .select("answer_id, milestone_id")
    .eq("action_type", "record_milestone")
    .in("answer_id", answerIds);
  if (actErr) throw new Error(`questionnaire_answer_actions query failed: ${actErr.message}`);
  const milestoneByAnswer = new Map(
    ((actRows ?? []) as Array<{ answer_id: string; milestone_id: string }>).map((a) => [a.answer_id, a.milestone_id])
  );
  if (milestoneByAnswer.size === 0) return [];

  // 4. KIND gate — q.kind='checkin'.
  const qIds = [...new Set(answeredCompleted.map((q) => q.questionnaire_id))];
  const { data: qRows, error: qErr } = await db
    .from("questionnaire")
    .select("id")
    .eq("kind", "checkin")
    .in("id", qIds);
  if (qErr) throw new Error(`questionnaire query failed: ${qErr.message}`);
  const checkin = new Set(((qRows ?? []) as Array<{ id: string }>).map((r) => r.id));

  // 5. Join in memory: completed ∧ check-in ∧ record_milestone. Dedup by answer row (qua.id).
  const facts: CheckinMilestoneFact[] = [];
  const seen = new Set<string>();
  for (const q of answeredCompleted) {
    if (!checkin.has(q.questionnaire_id)) continue;
    const milestone_id = milestoneByAnswer.get(q.answer_id);
    if (!milestone_id) continue;
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    facts.push({ source_ref: q.id, milestone_id, questionnaire_id: q.questionnaire_id });
  }
  return facts;
}

// Write check-in milestone facts for a user, STRICT single-child. NEVER THROWS — any
// failure logs and returns so the recompute proceeds (default-to-surface: a missed write
// re-asks next time, the safe direction). Runs in the backend service-role context, so
// child_milestones' RLS is bypassed (same write path apply_classification already uses).
export async function recordCheckinMilestones(userId: string): Promise<void> {
  try {
    const facts = await resolveUnrecordedCheckinMilestones(userId);
    if (facts.length === 0) return;

    // Single-child gate — a COUNT, not a resolver. The fact is permanent and monotonic
    // with no un-record path, so we write only when child resolution is unambiguous.
    const { data: kids, error: kidErr } = await db.from("children").select("id").eq("parent_id", userId);
    if (kidErr) throw new Error(`children query failed: ${kidErr.message}`);
    const childCount = (kids ?? []).length;

    if (childCount !== 1) {
      // 0 or 2+ children: write NOTHING; one structured skip per fact.
      for (const f of facts) {
        console.warn("[checkin_milestone_writer] skip: child_count != 1", {
          user_id: userId,
          questionnaire_id: f.questionnaire_id,
          milestone_id: f.milestone_id,
          child_count: childCount,
        });
      }
      return;
    }

    const child_id = (kids as Array<{ id: string }>)[0].id;

    // First-reach-wins: ON CONFLICT (child_id, milestone_id) DO NOTHING via ignoreDuplicates.
    // source='questionnaire', source_ref = the answer row; confidence omitted → NULL (an
    // explicit parent answer is not inferred, unlike the classifier's writes).
    const { error: insErr } = await db.from("child_milestones").upsert(
      facts.map((f) => ({
        child_id,
        milestone_id: f.milestone_id,
        source: "questionnaire",
        source_ref: f.source_ref,
      })),
      { onConflict: "child_id,milestone_id", ignoreDuplicates: true }
    );
    if (insErr) throw new Error(`child_milestones insert failed: ${insErr.message}`);
  } catch (e) {
    // The write must NEVER break the recompute (change 2). Log loudly, let the rebuild run.
    console.error(
      `[checkin_milestone_writer] errored for ${userId}; skipping the write, recompute proceeds: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
}
