import { supabase } from "../supabase";
import { getHandler } from "./registry";

// Insert a queued job row and return its id — does NOT start execution.
// Used by batch endpoints that want to collect all IDs before running.
export async function createJob(
  type: string,
  input: Record<string, unknown>
): Promise<string> {
  const { data, error } = await supabase
    .from("jobs")
    .insert({ type, input: input as never, status: "queued" })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create job: ${error?.message}`);
  }

  return data.id;
}

// Convenience: create + start immediately. Used by POST /jobs.
export async function createAndStartJob(
  type: string,
  input: Record<string, unknown>
): Promise<string> {
  const id = await createJob(type, input);
  startJob(id);
  return id;
}

// Run a list of job IDs through a worker pool capped at `concurrency`.
// Spawns min(concurrency, n) workers; each drains the shared queue until empty.
// Fire-and-forget: errors per job are already caught inside runJob.
export function startJobsBatch(jobIds: string[], concurrency: number): void {
  const queue = [...jobIds];

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      if (id) await runJob(id);
    }
  }

  const numWorkers = Math.min(concurrency, jobIds.length);
  Promise.all(Array.from({ length: numWorkers }, worker)).catch((err) =>
    console.error("[batch] Worker pool error:", err)
  );
}

export function startJob(jobId: string): void {
  runJob(jobId).catch((err) =>
    console.error(`Unhandled error in job ${jobId}:`, err)
  );
}

export async function runJob(jobId: string): Promise<void> {
  await supabase
    .from("jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", jobId);

  const { data: job, error: fetchError } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  if (fetchError || !job) {
    console.error(`Failed to load job ${jobId}:`, fetchError);
    return;
  }

  try {
    const handler = getHandler(job.type);
    const result = await handler(job as never);
    await supabase
      .from("jobs")
      .update({ status: "succeeded", result: result as never, finished_at: new Date().toISOString() })
      .eq("id", jobId);
  } catch (err) {
    const error =
      err instanceof Error
        ? { message: err.message, stack: err.stack }
        : { message: String(err) };
    await supabase
      .from("jobs")
      .update({ status: "failed", error: error as never, finished_at: new Date().toISOString() })
      .eq("id", jobId);
  }
}

export async function reapStaleJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("jobs")
    .update({
      status: "failed",
      error: { message: "Job orphaned (stale or service restart)" },
      finished_at: new Date().toISOString(),
    })
    .eq("status", "running")
    .lt("started_at", cutoff)
    .select("id");

  if (error) {
    console.error("reapStaleJobs failed:", error);
    return;
  }
  if (data && data.length > 0) {
    console.log(`Reaped ${data.length} stale job(s):`, data.map((j) => j.id));
  }
}
