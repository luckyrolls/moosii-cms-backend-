import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { createJob, startJobsBatch } from "../jobs/runner";
import { apiError } from "../lib/errors";
import { logApproval } from "../lib/approvalLog";
import { hasCapability } from "../middleware/jwtAuth";
import { setCardsReviewState, recomputeSegStatus } from "../lib/cardReview";
import { loadSegmentPromptRowById, loadBlock } from "../jobs/handlers/generateSegmentContent";

const router = Router();

// Max concurrent Gemini calls across a single batch. Keep low to stay within
// Gemini's per-minute rate limit. Tunable via env var without a deploy.
const BATCH_CONCURRENCY = parseInt(process.env.BATCH_CONCURRENCY ?? "2", 10);

// POST /segments/:id/generate-images
// mode 'all'        — regenerate everything (tuning / re-run)
// mode 'gaps'       — only sub-segments with no successful candidate (never generated
//                     or all prior attempts failed/rejected)
// mode 'unapproved' — only sub-segments with no approved content_images row
router.post("/:id/generate-images", async (req: Request, res: Response): Promise<void> => {
  const segmentId = req.params.id;
  const {
    mode = "all",
    concurrency,
  } = req.body as { mode?: "all" | "gaps" | "unapproved"; concurrency?: number };

  if (mode !== "all" && mode !== "gaps" && mode !== "unapproved") {
    apiError(res, 400, "invalid_mode", 'mode must be "all", "gaps", or "unapproved"');
    return;
  }

  const limit = concurrency ?? BATCH_CONCURRENCY;

  // NOTE: order by created_at as a proxy for sequence. If sub_segments gains an
  // explicit position column, prefer that here.
  const { data: subSegments, error: ssErr } = await supabase
    .from("sub_segments")
    .select("id")
    .eq("seg_id", segmentId)
    .order("created_at");

  if (ssErr) {
    apiError(res, 500, "db_error", ssErr.message);
    return;
  }

  if (!subSegments || subSegments.length === 0) {
    res.json({ segment_id: segmentId, mode, jobs: [] });
    return;
  }

  const allIds = subSegments.map((s) => s.id);
  let selected = subSegments;

  if (mode === "unapproved") {
    // Skip sub-segments that already have an approved image
    const { data: approved } = await supabase
      .from("content_images")
      .select("sub_segment_id")
      .eq("status", "approved")
      .in("sub_segment_id", allIds);

    const approvedSet = new Set((approved ?? []).map((r) => r.sub_segment_id as string));
    selected = subSegments.filter((s) => !approvedSet.has(s.id));
  } else if (mode === "gaps") {
    // Skip sub-segments that already have a usable candidate or approved image
    const { data: existing } = await supabase
      .from("content_images")
      .select("sub_segment_id")
      .in("status", ["candidate", "approved"])
      .in("sub_segment_id", allIds);

    const existingSet = new Set((existing ?? []).map((r) => r.sub_segment_id as string));
    selected = subSegments.filter((s) => !existingSet.has(s.id));
  }

  if (selected.length === 0) {
    res.json({ segment_id: segmentId, mode, jobs: [] });
    return;
  }

  // Step 1: insert all job rows up front — fast DB inserts, no Gemini calls yet.
  const jobs = await Promise.all(
    selected.map(async (ss) => {
      const jobId = await createJob("generate_sub_segment_image", {
        sub_segment_id: ss.id,
        auto_approve: false,
      });
      return { sub_segment_id: ss.id, job_id: jobId };
    })
  );

  // Step 2: return 202 immediately with all job IDs.
  res.status(202).json({ segment_id: segmentId, mode, jobs });

  // Step 3: drain execution concurrency-capped (fire-and-forget).
  startJobsBatch(jobs.map((j) => j.job_id), limit);
});

// GET /segments/:id/regen-prompt?tone_id=<prompts.id>
// Returns the current text of each prompt layer for the given tone, so the CMS
// can pre-fill the regen prompt editor before a per-run override. The layers are
// tone-scoped (identical across segments), so :id is contextual only.
// `system_message` is returned read-only (NOT overridable); the `editable` layers
// (scope / tone / structure / length) are the starting text for the regen
// `overrides` input.
router.get("/:id/regen-prompt", async (req: Request, res: Response): Promise<void> => {
  const toneId = (req.query.tone_id as string | undefined)?.trim();
  if (!toneId) {
    apiError(res, 400, "missing_tone_id", "query param 'tone_id' is required");
    return;
  }

  try {
    const promptRow = await loadSegmentPromptRowById(toneId);
    const [toneContent, structureContent, lengthContent] = await Promise.all([
      loadBlock(promptRow.tone_block_id, "tone"),
      loadBlock(promptRow.structure_block_id, "structure"),
      loadBlock(promptRow.length_block_id, "length"),
    ]);

    res.json({
      tone_id: toneId,
      tone:    promptRow.tone,
      system_message: promptRow.system_message, // read-only; not overridable
      editable: {
        scope:     promptRow.scope ?? "",
        tone:      toneContent,
        structure: structureContent,
        length:    lengthContent,
      },
    });
  } catch (err) {
    apiError(res, 404, "prompt_not_found", err instanceof Error ? err.message : String(err));
  }
});

// GET /segments/:id/generation-log
// The latest WHOLE-SEGMENT content prompt that produced this segment's current
// cards — what a reviewer sees as "the prompt used". Scoped to content ops
// (`segment_content`, `segment_content_regen`) so a later quiz/image log on the
// same segment doesn't shadow it. Single-card regens log under
// related_entity_type='sub_segment' and are intentionally excluded here.
router.get("/:id/generation-log", async (req: Request, res: Response): Promise<void> => {
  const segmentId = req.params.id;

  const { data, error } = await supabase
    .from("ai_generation_log")
    .select("id, operation, prompt, model, notes, correlation_id, created_at")
    .eq("related_entity_type", "segment")
    .eq("related_entity_id", segmentId)
    .in("operation", ["segment_content", "segment_content_regen"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    apiError(res, 500, "db_error", error.message);
    return;
  }

  res.json({ found: !!data, log: data ?? null });
});

// ── Card-level review (migration 056). seg_status is DERIVED from the cards — these routes
// transition cards and let recompute_seg_status set the gate; NONE writes seg_status directly.
// Role controls what you SEE; CAPABILITY controls what you can SIGN. Actor is ALWAYS the
// verified JWT (never the body). Optional body.card_ids = surgical (one/some cards); omit =
// BULK (every card in the segment) — the normal case.

async function segmentExists(id: string): Promise<boolean> {
  const { data } = await supabase.from("segments").select("id").eq("id", id).maybeSingle();
  return !!data;
}

// POST /segments/:id/editorial-approve — cap: editorial. draft → editorial_reviewed.
router.post("/:id/editorial-approve", async (req: Request, res: Response): Promise<void> => {
  if (!hasCapability(req.user, "editorial")) { apiError(res, 403, "forbidden", "Requires editorial capability"); return; }
  if (!(await segmentExists(req.params.id))) { apiError(res, 404, "not_found", "segment not found"); return; }
  const cardIds = Array.isArray((req.body ?? {}).card_ids) ? (req.body.card_ids as string[]) : null;
  try {
    const r = await setCardsReviewState(req.params.id, cardIds, "editorial_reviewed", "draft", null);
    await logApproval("segment", req.params.id, "editorial_approve", req);
    res.json({ ok: true, ...r });
  } catch (e) { apiError(res, 500, "transition_failed", e instanceof Error ? e.message : String(e)); }
});

// POST /segments/:id/clinical-approve — cap: CLINICAL. editorial_reviewed → clinically_approved.
// This is the health sign-off: Mark (no clinical capability) is structurally 403 here, and
// the actor stamped as approved_by is the verified token, so his id can never sign clinically.
router.post("/:id/clinical-approve", async (req: Request, res: Response): Promise<void> => {
  if (!hasCapability(req.user, "clinical")) { apiError(res, 403, "forbidden", "Requires clinical capability"); return; }
  if (!(await segmentExists(req.params.id))) { apiError(res, 404, "not_found", "segment not found"); return; }
  const cardIds = Array.isArray((req.body ?? {}).card_ids) ? (req.body.card_ids as string[]) : null;
  try {
    const r = await setCardsReviewState(req.params.id, cardIds, "clinically_approved", "editorial_reviewed", req.user!.id);
    await logApproval("segment", req.params.id, "clinical_approve", req);
    res.json({ ok: true, ...r });
  } catch (e) { apiError(res, 500, "transition_failed", e instanceof Error ? e.message : String(e)); }
});

// POST /segments/:id/reject — go back ONE step, carrying a reason. Body: { stage:
// 'clinical'|'editorial', reason?, card_ids? }. clinical reject: clinically_approved →
// editorial_reviewed (cap clinical). editorial reject: editorial_reviewed → draft (cap
// editorial). No separate 'rejected' state.
router.post("/:id/reject", async (req: Request, res: Response): Promise<void> => {
  const { stage, reason, card_ids } = (req.body ?? {}) as { stage?: string; reason?: string; card_ids?: string[] };
  const cap: "editorial" | "clinical" | null = stage === "clinical" ? "clinical" : stage === "editorial" ? "editorial" : null;
  if (!cap) { apiError(res, 400, "invalid_stage", "stage must be 'editorial' or 'clinical'"); return; }
  if (!hasCapability(req.user, cap)) { apiError(res, 403, "forbidden", `Requires ${cap} capability`); return; }
  if (!(await segmentExists(req.params.id))) { apiError(res, 404, "not_found", "segment not found"); return; }
  const from = cap === "clinical" ? "clinically_approved" : "editorial_reviewed";
  const to = cap === "clinical" ? "editorial_reviewed" : "draft";
  const cardIds = Array.isArray(card_ids) ? card_ids : null;
  try {
    const r = await setCardsReviewState(req.params.id, cardIds, to, from, null);
    await logApproval("segment", req.params.id, "reject", req, typeof reason === "string" ? reason : null);
    res.json({ ok: true, ...r });
  } catch (e) { apiError(res, 500, "transition_failed", e instanceof Error ? e.message : String(e)); }
});

// POST /segments/:id/recompute-status — derive seg_status from the cards (no transition).
// The CONTRACT the CMS slice targets: call this after a card add/reorder instead of writing
// seg_status directly. Any admin (no capability needed — it only reflects card truth).
router.post("/:id/recompute-status", async (req: Request, res: Response): Promise<void> => {
  if (!(await segmentExists(req.params.id))) { apiError(res, 404, "not_found", "segment not found"); return; }
  try {
    const seg_status = await recomputeSegStatus(req.params.id);
    res.json({ ok: true, segment_id: req.params.id, seg_status });
  } catch (e) { apiError(res, 500, "recompute_failed", e instanceof Error ? e.message : String(e)); }
});

export default router;
