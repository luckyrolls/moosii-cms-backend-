import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";
import { rebuildOneUser } from "../jobs/handlers/rebuildMlp";
import { enqueueRebuildAllIfIdle } from "../jobs/runner";
import { jwtAuthMiddleware } from "../middleware/jwtAuth";
import { assembleQuestionnaireStatus } from "../mlp/questionnaireStatus";
import { assembleMlpPreview, parseAgeMonthsParam } from "../mlp/mlpPreview";

const router = Router();

// GET /mlp/:user_id/preview?age_months=<int?>&include_completed=<bool?> — ADMIN
// (CMS user-MLP inspector). Recomputes the path with overridden inputs WITHOUT
// persisting: age_months → view the path at a chosen age; include_completed=true →
// view the full path including completed items. Reuses the rebuild's compute core
// (computeUserMlp); read-only, no writes, no user_mlp side effects. include_completed
// bypasses ONLY the completed-exclusion — the age gate + milestone suppression still
// apply. Absent age → the child's real age (returned as child_age_months).
router.get("/:user_id/preview", jwtAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = req.params.user_id;
  if (!userId) { apiError(res, 400, "bad_request", "user_id is required"); return; }

  const parsedAge = parseAgeMonthsParam(req.query.age_months);
  if (!parsedAge.ok) { apiError(res, 400, "bad_request", parsedAge.message); return; }
  const ageMonthsOverride = parsedAge.ageMonths;
  const includeCompleted = req.query.include_completed === "true";

  try {
    const preview = await assembleMlpPreview(userId, { ageMonthsOverride, includeCompleted });
    res.json(preview);
  } catch (e) {
    apiError(res, 500, "mlp_preview_failed", e instanceof Error ? e.message : String(e));
  }
});

// GET /mlp/:user_id/questionnaire-status — ADMIN (CMS user-MLP inspector). Unlike the
// app-facing /recompute below (self-scoped end-user JWT), this reads an ARBITRARY
// user's questionnaire lifecycle, so it takes the admin gate explicitly (this router
// is mounted without a global middleware). Read-only: runs the real recurrence +
// suppression logic over real rows, no writes, no MLP side effects.
router.get("/:user_id/questionnaire-status", jwtAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
  const userId = req.params.user_id;
  if (!userId) { apiError(res, 400, "bad_request", "user_id is required"); return; }
  try {
    const questionnaires = await assembleQuestionnaireStatus(userId);
    res.json({ user_id: userId, questionnaires });
  } catch (e) {
    apiError(res, 500, "questionnaire_status_failed", e instanceof Error ? e.message : String(e));
  }
});

// POST /mlp/rebuild-all — ADMIN. Enqueue a COALESCED `rebuild_mlp scope:all`. The CMS
// calls this right after a Supabase-direct lesson publish/unpublish (which the backend
// can't hook server-side). Coalesced: if a scope:all rebuild is already queued/running,
// it returns that job instead of enqueuing a second (see enqueueRebuildAllIfIdle). Always
// 202. NOT the manual "rebuild everything" admin button — that posts /jobs directly and is
// intentionally un-coalesced (an explicit force must not be swallowed). Optional body:
// { reason?, correlation_id? } for provenance ("why did this rebuild run").
router.post("/rebuild-all", jwtAuthMiddleware, async (req: Request, res: Response): Promise<void> => {
  const reason = typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : "cms_publish";
  const correlationId = typeof req.body?.correlation_id === "string" ? req.body.correlation_id : undefined;
  const r = await enqueueRebuildAllIfIdle({ reason, correlationId });
  res.status(202).json({
    enqueued: r.enqueued,
    job_id: r.jobId ?? null,
    coalesced_into: r.coalescedInto ?? null,
  });
});

// POST /mlp/recompute — APP-FACING. Unlike /jobs (admin/internal auth) and the SPA
// routes (admin role), this verifies ANY signed-in Supabase user and recomputes
// THAT user's MLP synchronously into user_mlp. The mobile app calls it with the
// end-user's Supabase JWT (the anon-key session token) after onboarding / a
// completed questionnaire.
//
// SECURITY: user_id is taken from the verified token, NEVER the request body — a
// user can only recompute their own MLP. Synchronous (the recompute is one fast
// atomic rpc), so the app gets a definitive result and doesn't need to poll the
// jobs table (which it can't read under its RLS context anyway).
router.post("/recompute", async (req: Request, res: Response): Promise<void> => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    apiError(res, 401, "unauthorized", "Missing or malformed Authorization header");
    return;
  }
  const token = header.slice("Bearer ".length);

  let userId: string;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) { apiError(res, 401, "unauthorized", "Invalid or expired token"); return; }
    userId = data.user.id;
  } catch {
    apiError(res, 401, "unauthorized", "Could not verify token");
    return;
  }

  try {
    const result = await rebuildOneUser(userId);
    res.json({ ok: true, user_id: userId, items_written: result.items_written });
  } catch (e) {
    apiError(res, 500, "recompute_failed", e instanceof Error ? e.message : String(e));
  }
});

export default router;
