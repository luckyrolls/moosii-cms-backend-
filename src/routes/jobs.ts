import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { startJob } from "../jobs/runner";

const router = Router();

router.post("/", async (req: Request, res: Response): Promise<void> => {
  const { type, input = {} } = req.body as { type?: string; input?: Record<string, unknown> };

  if (!type) {
    res.status(400).json({ error: "type is required" });
    return;
  }

  const { data, error } = await supabase
    .from("jobs")
    .insert({ type, input, status: "queued" })
    .select("id")
    .single();

  if (error || !data) {
    console.error("Failed to create job:", error);
    res.status(500).json({ error: "Failed to create job" });
    return;
  }

  startJob(data.id);
  res.status(202).json({ job_id: data.id });
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
