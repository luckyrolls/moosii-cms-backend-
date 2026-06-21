import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { createJob, startJobsBatch } from "../jobs/runner";
import { apiError } from "../lib/errors";
import { loadPromptRow, loadBlock } from "../jobs/handlers/generateSegmentContent";

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

// GET /segments/:id/regen-prompt?tone=<tone>
// Returns the current text of each prompt layer for the given tone, so the CMS
// can pre-fill the regen prompt editor before a per-run override. The layers are
// tone-scoped (identical across segments), so :id is contextual only.
// `system_message` is returned read-only (NOT overridable); the `editable` layers
// (scope / tone / structure / length) are the starting text for the regen
// `overrides` input.
router.get("/:id/regen-prompt", async (req: Request, res: Response): Promise<void> => {
  const tone = (req.query.tone as string | undefined)?.trim();
  if (!tone) {
    apiError(res, 400, "missing_tone", "query param 'tone' is required");
    return;
  }

  try {
    const promptRow = await loadPromptRow(tone);
    const [toneContent, structureContent, lengthContent] = await Promise.all([
      loadBlock(promptRow.tone_block_id, "tone"),
      loadBlock(promptRow.structure_block_id, "structure"),
      loadBlock(promptRow.length_block_id, "length"),
    ]);

    res.json({
      tone,
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

export default router;
