import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";
import { logApproval } from "../lib/approvalLog";
import { hasCapability, hasAnyCapability } from "../middleware/jwtAuth";

const router = Router();

// Standalone per-segment QUIZ approval — the finer-grained counterpart to the bulk
// lesson approve. Goes through the backend (service-role) so it bypasses the
// quiz_questions RLS wall that blocks a direct browser UPDATE (same reason
// /segments/:id/approve exists for content). The app renders a quiz only when
// quiz_questions.answer_status='approved'.
//
// POST /quiz/:segment_id/approve   → answer_status = 'approved' for that segment
// POST /quiz/:segment_id/unapprove → answer_status = 'pending'
async function setQuizStatus(req: Request, res: Response, segmentId: string, status: "approved" | "pending"): Promise<void> {
  const { data, error } = await supabase
    .from("quiz_questions")
    .update({ answer_status: status, updated_at: new Date().toISOString() })
    .eq("segment_id", segmentId)
    .select("question_id");
  if (error) { apiError(res, 500, "db_error", error.message); return; }
  const count = (data ?? []).length;
  if (count === 0) {
    // No quiz for this segment — nothing changed, so no audit row.
    res.json({ ok: true, segment_id: segmentId, status, questions_updated: 0, note: "no quiz questions for this segment" });
    return;
  }
  // A quiz actually transitioned → record it (actor from JWT). entity_id = the segment.
  await logApproval("quiz", segmentId, status === "approved" ? "approve" : "unapprove", req);
  res.json({ ok: true, segment_id: segmentId, status, questions_updated: count });
}

// CAPABILITY (slice 2). Approving a quiz is a CLINICAL act: answer_status='approved' is what
// derives lessons.with_quiz (invariant 10), i.e. it is what makes the app show the questions.
// The same flip happens inside approve_segment_bundle behind the clinical gate, so leaving
// this route open was a way round that gate.
router.post("/:segment_id/approve", (req: Request, res: Response) => {
  if (!hasCapability(req.user, "clinical")) {
    apiError(res, 403, "forbidden", "Requires clinical capability"); return;
  }
  return setQuizStatus(req, res, req.params.segment_id, "approved");
});

// Taking an approval back needs EITHER capability — the same rule as a segment reject.
router.post("/:segment_id/unapprove", (req: Request, res: Response) => {
  if (!hasAnyCapability(req.user, ["editorial", "clinical"])) {
    apiError(res, 403, "forbidden", "Requires editorial or clinical capability"); return;
  }
  return setQuizStatus(req, res, req.params.segment_id, "pending");
});

export default router;
