import { supabase } from "../supabase";
import { getHandler } from "./registry";

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
    const result = await handler(job);
    await supabase
      .from("jobs")
      .update({ status: "succeeded", result, finished_at: new Date().toISOString() })
      .eq("id", jobId);
  } catch (err) {
    const error =
      err instanceof Error
        ? { message: err.message, stack: err.stack }
        : { message: String(err) };
    await supabase
      .from("jobs")
      .update({ status: "failed", error, finished_at: new Date().toISOString() })
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
