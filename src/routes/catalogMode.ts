import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";
import { enqueueRebuildAllIfIdle } from "../jobs/runner";
import { describeRebuild } from "../jobs/rebuildTrigger";
import {
  interpretRetagResult,
  interpretSwitchResult,
  isMigrationPendingError,
  isSuperAdmin,
  mapCatalogError,
  parseGroup,
  parseMode,
  shouldRebuildAfterRetag,
  shouldRebuildAfterSwitch,
} from "../lib/catalogModes";

const router = Router();

// CATALOG MODES (migration 128). ONE global mode — live | mem | mdm — decides which group of
// tracks parents can see. Switching is a bulk archive/unarchive plus a rebuild of every plan; it
// is NOT an MLP algorithm change (invariant 1), because archival is already the one filter the
// selection honours (invariant 6, 045/046).
//
// super_admin only, in TS here and again in the database against p_actor. The actor is always
// req.user.id from the verified JWT, never the body (invariant 7).
//
// 'legacy' is a GROUP but never a MODE: PATCH can put a track there, POST can never switch to it.

function handleRpcError(
  res: Response,
  error: { hint?: string | null; code?: string | null; message?: string | null },
  what: string
): void {
  const refusal = mapCatalogError(error);
  if (refusal) {
    console.warn(`[${what}] refused: ${refusal.code}`);
    apiError(res, refusal.status, refusal.code, refusal.message);
    return;
  }
  if (isMigrationPendingError(error)) {
    console.warn(`[${what}] migration 128 is not applied here yet: ${error.message}`);
    apiError(
      res,
      503,
      "migration_pending",
      "Catalog modes need migration 128, which is not applied on this deployment yet."
    );
    return;
  }
  console.error(`[${what}] failed: ${error.message}`);
  apiError(res, 500, "db_error", error.message ?? "unknown database error");
}

// GET /admin/catalog-mode — the current mode, who set it, and the rebuild that followed.
// Readable by any admin: knowing which catalog is live is not a privileged action, and the CMS
// shows it on every page that lists tracks.
router.get("/catalog-mode", async (_req: Request, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from("catalog_mode_switches")
    .select("mode, previous_mode, actor_id, actor_role, switched_at, tracks_archived, tracks_unarchived")
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    handleRpcError(res, error, "catalog-mode-get");
    return;
  }
  if (!data) {
    apiError(res, 503, "migration_pending", "No catalog mode is set; migration 128 seeds the first one.");
    return;
  }

  // The most recent scope:all rebuild, so the CMS can say whether the plans have caught up with
  // the switch. Read directly rather than tracked on the switch row: the rebuild is a separate
  // job that may be queued, coalesced or retried after the switch committed.
  const { data: job } = await supabase
    .from("jobs")
    .select("id, status, created_at, finished_at")
    .eq("type", "rebuild_mlp")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const counts = await supabase
    .from("tracks")
    .select("test_group, archived_at");

  const groups: Record<string, { total: number; active: number }> = {};
  for (const row of (counts.data ?? []) as Array<{ test_group: string; archived_at: string | null }>) {
    const g = (groups[row.test_group] ??= { total: 0, active: 0 });
    g.total += 1;
    if (row.archived_at === null) g.active += 1;
  }

  res.json({
    ok: true,
    mode: data.mode,
    previous_mode: data.previous_mode,
    switched_at: data.switched_at,
    actor_id: data.actor_id,
    actor_role: data.actor_role,
    tracks_archived: data.tracks_archived,
    tracks_unarchived: data.tracks_unarchived,
    groups,
    last_rebuild: job
      ? { job_id: job.id, status: job.status, created_at: job.created_at, finished_at: job.finished_at }
      : null,
  });
});

// POST /admin/catalog-mode { mode } — switch, then rebuild every plan.
router.post("/catalog-mode", async (req: Request, res: Response): Promise<void> => {
  if (!isSuperAdmin(req.user)) {
    apiError(res, 403, "catalog_mode_not_permitted", "Only a super_admin can switch the catalog mode.");
    return;
  }
  const mode = parseMode(req.body?.mode);
  if (!mode) {
    apiError(res, 400, "bad_mode", "mode must be one of live, mem, mdm (legacy is a group, never a mode).");
    return;
  }
  const actor = req.user?.id;
  if (!actor) {
    apiError(res, 403, "forbidden", "an authenticated actor is required");
    return;
  }

  const { data, error } = await supabase.rpc("switch_catalog_mode", {
    p_mode: mode,
    p_actor: actor,
  });
  if (error) {
    // A REFUSED switch changed nothing, so it must not trigger a rebuild.
    handleRpcError(res, error, "catalog-mode-switch");
    return;
  }

  const result = interpretSwitchResult(data);
  if (!result) {
    console.error(`[catalog-mode-switch] unreadable RPC result: ${JSON.stringify(data)}`);
    apiError(res, 500, "db_error", "switch_catalog_mode returned an unreadable result");
    return;
  }

  // EVERY plan is stale now: the visible track set just changed for every user. Single rebuild,
  // coalesced by the shared rule (src/jobs/rebuildTrigger.ts) — never folded into a RUNNING job,
  // which may already have passed users this switch affects.
  if (!shouldRebuildAfterSwitch(result)) {
    res.json({ ok: true, ...result, rebuild: "skipped", rebuild_job_id: null });
    return;
  }
  const rebuild = await enqueueRebuildAllIfIdle({
    reason: "catalog_mode_switch",
    correlationId: `${result.previous_mode ?? "none"}->${result.mode}`,
  });
  res.json({ ok: true, ...result, ...describeRebuild(rebuild) });
});

export default router;

// PATCH /tracks/:id/test-group lives in its own router so it can mount under /tracks.
export const trackGroupRouter = Router();

trackGroupRouter.patch("/:id/test-group", async (req: Request, res: Response): Promise<void> => {
  if (!isSuperAdmin(req.user)) {
    apiError(res, 403, "catalog_mode_not_permitted", "Only a super_admin can change a track's group.");
    return;
  }
  const group = parseGroup(req.body?.test_group);
  if (!group) {
    apiError(res, 400, "bad_group", "test_group must be one of live, mem, mdm, legacy.");
    return;
  }
  const actor = req.user?.id;
  if (!actor) {
    apiError(res, 403, "forbidden", "an authenticated actor is required");
    return;
  }

  const { data, error } = await supabase.rpc("set_track_group", {
    p_track: req.params.id,
    p_group: group,
    p_actor: actor,
  });
  if (error) {
    handleRpcError(res, error, "track-test-group");
    return;
  }

  const result = interpretRetagResult(data);
  if (!result) {
    console.error(`[track-test-group] unreadable RPC result: ${JSON.stringify(data)}`);
    apiError(res, 500, "db_error", "set_track_group returned an unreadable result");
    return;
  }
  if (!result.found) {
    apiError(res, 404, "not_found", "No such track.");
    return;
  }

  if (!shouldRebuildAfterRetag(result)) {
    res.json({ ok: true, ...result, rebuild: "skipped", rebuild_job_id: null });
    return;
  }
  const rebuild = await enqueueRebuildAllIfIdle({
    reason: "track_group_change",
    correlationId: req.params.id,
  });
  res.json({ ok: true, ...result, ...describeRebuild(rebuild) });
});
