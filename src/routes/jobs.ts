import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { createAndStartJob } from "../jobs/runner";

const router = Router();

router.post("/", async (req: Request, res: Response): Promise<void> => {
  const { type, input = {} } = req.body as { type?: string; input?: Record<string, unknown> };

  if (!type) {
    res.status(400).json({ error: "type is required" });
    return;
  }

  try {
    const jobId = await createAndStartJob(type, input);
    res.status(202).json({ job_id: jobId });
  } catch (err) {
    console.error("Failed to create job:", err);
    res.status(500).json({ error: "Failed to create job" });
  }
});

router.get("/:id", async (req: Request, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (error || !data) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(data);
});

export default router;
