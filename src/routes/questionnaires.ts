import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";
import { enqueueRebuildAllIfIdle } from "../jobs/runner";

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

  // Publish-state changed → propagate to users via a coalesced rebuild (fire-and-forget).
  void enqueueRebuildAllIfIdle({ reason: "questionnaire_unpublish", correlationId: id });

  res.json({ questionnaire_id: id, is_published: false });
});

export default router;
