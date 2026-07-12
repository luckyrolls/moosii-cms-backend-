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

// Enqueue a `rebuild_mlp scope:all` UNLESS one is already queued/running (coalescing —
// ONE check, not a debounce). Used by the publish-state triggers (questionnaire routes +
// POST /mlp/rebuild-all). NEVER throws — safe to fire-and-forget from a request handler;
// a publish must never be blocked or failed by this. `reason` + `correlationId` are stamped
// into the job input so "why did this rebuild run" is answerable from the jobs row.
//
// The coalesced race is CORRECTNESS-SAFE: two concurrent scope:all runs are harmless
// because rebuild_user_mlp is derive-and-overwrite (atomic per-user delete+insert, no
// non-idempotent step), so they converge — a rare double-enqueue is wasted work, never
// wrong data. Accordingly we fail TOWARD triggering: if the coalescing check itself errors,
// we enqueue anyway (a missed rebuild is worse than a harmless duplicate).
export async function enqueueRebuildAllIfIdle(
  ctx: { reason: string; correlationId?: string }
): Promise<{ enqueued: boolean; jobId?: string; coalescedInto?: string }> {
  try {
    const { data: existing, error } = await supabase
      .from("jobs")
      .select("id, status")
      .eq("type", "rebuild_mlp")
      .in("status", ["queued", "running"])
      .contains("input", { scope: "all" })
      .limit(1);

    if (!error && existing && existing.length > 0) {
      const into = existing[0].id as string;
      console.log(`[rebuild-trigger] coalesced into ${into} (${existing[0].status}) — reason=${ctx.reason} corr=${ctx.correlationId ?? "-"}`);
      return { enqueued: false, coalescedInto: into };
    }
    if (error) {
      console.warn(`[rebuild-trigger] coalescing check failed (${ctx.reason}); enqueuing anyway (harmless dup): ${error.message}`);
    }

    const jobId = await createAndStartJob("rebuild_mlp", {
      scope: "all",
      triggered_by: ctx.reason,
      correlation_id: ctx.correlationId ?? null,
    });
    console.log(`[rebuild-trigger] enqueued ${jobId} scope:all — reason=${ctx.reason} corr=${ctx.correlationId ?? "-"}`);
    return { enqueued: true, jobId };
  } catch (e) {
    console.error(`[rebuild-trigger] enqueue errored (${ctx.reason}), non-fatal: ${e instanceof Error ? e.message : String(e)}`);
    return { enqueued: false };
  }
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
