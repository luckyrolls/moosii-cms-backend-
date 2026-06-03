import { Router, Request, Response } from "express";
import { createAndStartJob } from "../jobs/runner";
import { apiError } from "../lib/errors";

const router = Router();

// POST /lessons/generate
// Creates a generate_lessons job: queries existing lessons, calls OpenAI,
// inserts new lessons + one segment per lesson.
router.post("/generate", async (req: Request, res: Response): Promise<void> => {
  const { prompt, track_id, topic_id, count } = req.body as {
    prompt?: string;
    track_id?: string;
    topic_id?: string;
    count?: number;
  };

  if (!prompt) {
    apiError(res, 400, "missing_field", "prompt is required");
    return;
  }
  if (!track_id) {
    apiError(res, 400, "missing_field", "track_id is required");
    return;
  }

  try {
    const jobId = await createAndStartJob("generate_lessons", {
      prompt,
      track_id,
      ...(topic_id && { topic_id }),
      ...(count !== undefined && { count }),
      ...(req.user?.id && { created_by: req.user.id }),
    });
    res.status(202).json({ job_id: jobId });
  } catch (err) {
    console.error("Failed to create generate_lessons job:", err);
    apiError(res, 500, "job_create_failed", "Failed to create lesson generation job");
  }
});

export default router;
