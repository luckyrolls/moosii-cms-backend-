// ONE coalescing rule for every auto-triggered `rebuild_mlp`, scope:all and single-user alike.
//
// WHY ONE: the two helpers in runner.ts used to carry their own copy of this rule and they had
// DRIFTED — the single-user path folded into a QUEUED job only, the scope:all path folded into a
// QUEUED **or RUNNING** one. Folding into a RUNNING rebuild is a lost-update: the run reads the
// candidate pool (and each user's facts) once per user as it walks the user base, so a publish that
// commits mid-run is invisible to every user the run has already passed. The publish returned 200,
// the rebuild said "coalesced", and that lesson reached those users only when some later rebuild
// happened to run. QUEUED is safe because a queued job has not read anything yet.
//
// A duplicate rebuild is harmless: rebuild_user_mlp is derive-and-overwrite (atomic per-user
// delete+insert, no non-idempotent step), so two concurrent runs converge. A missed one is not.
// Accordingly every uncertainty here fails TOWARD enqueuing.

export type RebuildJobRow = { id: string; status: string };

// What to rebuild. `{ scope: "all" }` is the publish-state trigger; `{ user_id }` is POST /facts.
export type RebuildScope = { kind: "all" } | { kind: "user"; userId: string };

export type EnqueueResult = { enqueued: boolean; jobId?: string; coalescedInto?: string };

export type RebuildTriggerDeps = {
  // Open `rebuild_mlp` jobs matching this scope — QUEUED **and RUNNING** both come back on
  // purpose: the queued/running decision lives here, in code, where it is testable.
  listOpenRebuilds(scope: RebuildScope): Promise<RebuildJobRow[]>;
  createAndStart(input: Record<string, unknown>): Promise<string>;
};

// The guard itself: a new trigger may fold ONLY into a job that has not started.
export function coalesceTarget(rows: readonly RebuildJobRow[]): RebuildJobRow | null {
  return rows.find((r) => r.status === "queued") ?? null;
}

export function jobInput(scope: RebuildScope, ctx: { reason: string; correlationId?: string }): Record<string, unknown> {
  return {
    ...(scope.kind === "all" ? { scope: "all" } : { user_id: scope.userId }),
    triggered_by: ctx.reason,
    correlation_id: ctx.correlationId ?? null,
  };
}

// The `rebuild` field publish/unpublish report (api-contract §2).
export function describeRebuild(r: EnqueueResult): { rebuild: "queued" | "coalesced" | "failed"; rebuild_job_id: string | null } {
  if (r.enqueued && r.jobId) return { rebuild: "queued", rebuild_job_id: r.jobId };
  if (r.coalescedInto) return { rebuild: "coalesced", rebuild_job_id: r.coalescedInto };
  return { rebuild: "failed", rebuild_job_id: null };
}

const label = (scope: RebuildScope) => (scope.kind === "all" ? "scope:all" : `user ${scope.userId}`);

// NEVER throws — safe to await from a request handler; a publish must never be blocked or failed
// by its rebuild trigger.
export async function enqueueRebuildIfIdle(
  scope: RebuildScope,
  ctx: { reason: string; correlationId?: string },
  deps: RebuildTriggerDeps
): Promise<EnqueueResult> {
  const corr = ctx.correlationId ?? "-";
  let open: RebuildJobRow[] | null = null;
  try {
    open = await deps.listOpenRebuilds(scope);
  } catch (e) {
    // Fail toward rebuilding: a missed rebuild is worse than a harmless duplicate.
    console.warn(`[rebuild-trigger] coalescing check failed (${ctx.reason}); enqueuing anyway (harmless dup): ${e instanceof Error ? e.message : String(e)}`);
  }

  if (open) {
    const target = coalesceTarget(open);
    if (target) {
      console.log(`[rebuild-trigger] ${label(scope)} coalesced into queued ${target.id} — reason=${ctx.reason} corr=${corr}`);
      return { enqueued: false, coalescedInto: target.id };
    }
    const running = open.filter((r) => r.status === "running").map((r) => r.id);
    if (running.length > 0) {
      // The fix: a running rebuild may already have passed the affected users, so it cannot
      // carry this change. Queue a fresh one behind it.
      console.log(`[rebuild-trigger] ${label(scope)} NOT folded into running ${running.join(",")} (may have passed affected users) — queuing a fresh rebuild; reason=${ctx.reason} corr=${corr}`);
    }
  }

  try {
    const jobId = await deps.createAndStart(jobInput(scope, ctx));
    console.log(`[rebuild-trigger] enqueued ${jobId} ${label(scope)} — reason=${ctx.reason} corr=${corr}`);
    return { enqueued: true, jobId };
  } catch (e) {
    console.error(`[rebuild-trigger] enqueue errored (${ctx.reason}), non-fatal: ${e instanceof Error ? e.message : String(e)}`);
    return { enqueued: false };
  }
}
