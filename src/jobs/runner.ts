import { supabase } from "../supabase";
import { getHandler } from "./registry";
import {
  enqueueRebuildIfIdle,
  type EnqueueResult,
  type RebuildJobRow,
  type RebuildScope,
  type RebuildTriggerDeps,
} from "./rebuildTrigger";

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

// Enqueue a `rebuild_mlp scope:all` unless one is already QUEUED (coalescing — ONE check, not a
// debounce). Used by the publish-state triggers (lesson + questionnaire publish/unpublish/delete,
// POST /mlp/rebuild-all). NEVER throws — safe to await from a request handler; a publish must never
// be blocked or failed by this. `reason` + `correlationId` are stamped into the job input so "why did
// this rebuild run" is answerable from the `jobs` row.
//
// It does NOT fold into a RUNNING rebuild: that run may already have passed the users this change
// affects. The rule, and why a duplicate is harmless while a miss is not, lives in rebuildTrigger.ts.
export async function enqueueRebuildAllIfIdle(
  ctx: { reason: string; correlationId?: string }
): Promise<EnqueueResult> {
  return enqueueRebuildIfIdle({ kind: "all" }, ctx, supabaseRebuildDeps);
}

// Enqueue a single-user `rebuild_mlp { user_id }` unless one for that user is already QUEUED.
// Used by POST /facts. Same contract and same guard as the scope:all trigger above.
export async function enqueueRebuildUserIfIdle(
  userId: string,
  ctx: { reason: string; correlationId?: string }
): Promise<EnqueueResult> {
  return enqueueRebuildIfIdle({ kind: "user", userId }, ctx, supabaseRebuildDeps);
}

// The real deps: open rebuilds of this scope (queued AND running — rebuildTrigger decides), and
// create+start. A scope filter uses `contains` on the jsonb input, so `{scope:"all"}` and a
// per-user job never match each other.
const supabaseRebuildDeps: RebuildTriggerDeps = {
  async listOpenRebuilds(scope: RebuildScope): Promise<RebuildJobRow[]> {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, status")
      .eq("type", "rebuild_mlp")
      .in("status", ["queued", "running"])
      .contains("input", scope.kind === "all" ? { scope: "all" } : { user_id: scope.userId })
      .limit(10);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Array<{ id: string; status: string }>).map((r) => ({ id: r.id, status: r.status }));
  },
  createAndStart: (input) => createAndStartJob("rebuild_mlp", input),
};

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
