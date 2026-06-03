import { Router, Request, Response } from "express";
import { createAndStartJob } from "../jobs/runner";
import { apiError } from "../lib/errors";

const router = Router();

// POST /sub-segments/:id/generate-image
// Creates a single generate_sub_segment_image job for the given sub-segment.
// Backs "redo this one" and the prompt-tweak/compare loop.
router.post("/:id/generate-image", async (req: Request, res: Response): Promise<void> => {
  const subSegmentId = req.params.id;
  const { instructions_override, prompt_override } = req.body as {
    instructions_override?: string;
    prompt_override?: string;
  };

  try {
    const jobId = await createAndStartJob("generate_sub_segment_image", {
      sub_segment_id: subSegmentId,
      auto_approve: false,
      ...(instructions_override && { instructions_override }),
      ...(prompt_override && { prompt_override }),
    });
    res.status(202).json({ job_id: jobId });
  } catch (err) {
    console.error("Failed to create generate-image job:", err);
    apiError(res, 500, "job_create_failed", "Failed to create image generation job");
  }
});

export default router;
