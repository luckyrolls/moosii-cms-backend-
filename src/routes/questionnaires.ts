import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";
import { enqueueRebuildAllIfIdle } from "../jobs/runner";
import { logApproval } from "../lib/approvalLog";
import { planQuestionnaireDelete } from "../lib/contentTeardown";

// questionnaire tables aren't in database.types.ts. Untyped bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const router = Router();

// POST /questionnaires/:id/publish — the human approve step. Flips
// is_published=true and marks the questions approved. Requires >=1 question.
router.post("/:id/publish", async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;

  const { data: q, error: fErr } = await db
    .from("questionnaire").select("id, is_published").eq("id", id).single();
  if (fErr || !q) { apiError(res, 404, "not_found", "questionnaire not found"); return; }

  const { data: qs } = await db
    .from("questionnaire_questions").select("question_id").eq("questionnaire_id", id);
  if (!qs || qs.length === 0) {
    apiError(res, 409, "no_questions", "questionnaire has no questions to publish");
    return;
  }

  const now = new Date().toISOString();
  const { error: pErr } = await db
    .from("questionnaire").update({ is_published: true, updated_at: now }).eq("id", id);
  if (pErr) { apiError(res, 500, "db_error", pErr.message); return; }

  const { error: aErr } = await db
    .from("questionnaire_questions").update({ answer_status: "approved" }).eq("questionnaire_id", id);
  if (aErr) { apiError(res, 500, "db_error", aErr.message); return; }

  await logApproval("questionnaire", id, "publish", req);

  // Publish-state changed → propagate to users via a coalesced rebuild. Fire-and-forget;
  // never block or fail the publish on the rebuild trigger.
  void enqueueRebuildAllIfIdle({ reason: "questionnaire_publish", correlationId: id });

  res.json({ questionnaire_id: id, is_published: true, questions_approved: qs.length });
});

// POST /questionnaires/:id/unpublish — pull a published questionnaire back to draft
// (e.g. to edit it). Flips is_published=false; questions revert to pending.
router.post("/:id/unpublish", async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;

  const { data: q, error: fErr } = await db
    .from("questionnaire").select("id").eq("id", id).single();
  if (fErr || !q) { apiError(res, 404, "not_found", "questionnaire not found"); return; }

  const now = new Date().toISOString();
  const { error: pErr } = await db
    .from("questionnaire").update({ is_published: false, updated_at: now }).eq("id", id);
  if (pErr) { apiError(res, 500, "db_error", pErr.message); return; }

  await db.from("questionnaire_questions").update({ answer_status: "pending" }).eq("questionnaire_id", id);

  await logApproval("questionnaire", id, "unpublish", req);

  // Publish-state changed → propagate to users via a coalesced rebuild (fire-and-forget).
  void enqueueRebuildAllIfIdle({ reason: "questionnaire_unpublish", correlationId: id });

  res.json({ questionnaire_id: id, is_published: false });
});

// DELETE /questionnaires/:id — full teardown. No images. The atom + routing + user tables
// all CASCADE (questionnaire_questions, questionnaire_answers, questionnaire_answer_actions,
// questionnaire_response, questionnaire_user_answers, user_questionnaire_progress,
// completed_items, starred_items), so this is ONE delete. Works identically for
// kind='checkin' and kind='diagnostic' — no kind branch.
//
// child_milestones rows referencing this questionnaire's answers SURVIVE: source_ref is
// plain TEXT with no FK, and milestone facts are monotonic. This is deliberate — no cleanup.
//
// ?dry_run=true → returns the CASCADE counts for the confirm modal; deletes nothing.
router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;
  const dryRun = req.query.dry_run === "true";

  const plan = await planQuestionnaireDelete(id);
  if (!plan.found) { apiError(res, 404, "not_found", `questionnaire ${id} not found`); return; }

  if (dryRun) {
    res.json({ dry_run: true, questionnaire_id: id, kind: plan.kind, would_delete: plan.counts });
    return;
  }

  const { error: delErr } = await db.from("questionnaire").delete().eq("id", id);
  if (delErr) { apiError(res, 500, "delete_failed", delErr.message); return; }

  // Routing/pool changed → coalesced rebuild (fire-and-forget, same as publish/unpublish).
  void enqueueRebuildAllIfIdle({ reason: "questionnaire_delete", correlationId: id });

  res.json({ ok: true, questionnaire_id: id, kind: plan.kind, deleted: plan.counts });
});

export default router;
