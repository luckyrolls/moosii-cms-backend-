import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";
import { enqueueRebuildUserIfIdle } from "../jobs/runner";
import { describeRebuild } from "../jobs/rebuildTrigger";
import {
  interpretResetResult,
  interpretSetFlagResult,
  isMigrationPendingError,
  isSuperAdmin,
  mapTestAccountError,
  parseFlag,
  parseResetDepth,
  totalDeleted,
} from "../lib/testAccounts";


const router = Router();

// TEST ACCOUNTS (migration 127). A test account is a demo/QA login a super_admin has deliberately
// flagged, and the only kind of account `reset_test_account` will touch.
//
// THREE INDEPENDENT LAYERS guard the flag, and this router is only the outermost:
//   1. PRIVILEGE — no column grant exists for `is_test_account`, so no client can write it at all
//      (112 revoked table-level INSERT/UPDATE from anon and authenticated). This is the real lock.
//   2. TRIGGER — test_account_flag_guard refuses a non-super_admin JWT.
//   3. ROUTE — this file, for a clean 403 instead of a database exception.
// RLS is NOT one of them: `user_self_update`'s qual ORs `id = auth.uid()`, so RLS by itself would
// let an account write its own row. See migration 127's header.
//
// The actor is ALWAYS req.user.id (the verified JWT) and never the body — invariant 7. The RPCs
// re-check it against p_actor, which is the authority.

// Shared refusal handling: 127's HINTs, then the migration-pending window, then a real 500.
function handleRpcError(
  res: Response,
  error: { hint?: string | null; code?: string | null; message?: string | null },
  what: string
): void {
  const refusal = mapTestAccountError(error);
  if (refusal) {
    console.warn(`[${what}] refused: ${refusal.code}`);
    apiError(res, refusal.status, refusal.code, refusal.message);
    return;
  }
  if (isMigrationPendingError(error)) {
    console.warn(`[${what}] migration 127 is not applied here yet: ${error.message}`);
    apiError(
      res,
      503,
      "migration_pending",
      "Test accounts need migration 127, which is not applied on this deployment yet."
    );
    return;
  }
  console.error(`[${what}] failed: ${error.message}`);
  apiError(res, 500, "db_error", error.message ?? "unknown database error");
}

// GET /users/test-accounts — the CMS list. Declared BEFORE any /:id route so "test-accounts" is
// never captured as an id. super_admin only: a plain admin cannot flag or reset, so a list of
// resettable accounts is not theirs to act on.
router.get("/test-accounts", async (req: Request, res: Response): Promise<void> => {
  if (!isSuperAdmin(req.user)) {
    apiError(res, 403, "test_account_not_permitted", "Only a super_admin can view test accounts.");
    return;
  }

  const { data, error } = await supabase
    .from("user")
    .select("id, email, display_name, role, is_test_account, onboarding_complete, moosies")
    .eq("is_test_account", true)
    .order("email", { ascending: true });

  if (error) {
    handleRpcError(res, error, "test-accounts-list");
    return;
  }

  res.json({ ok: true, users: data ?? [] });
});

// PATCH /users/:id/test-account — flag or unflag. Idempotent: setting the state it already has
// returns changed:false and writes no audit row.
router.patch("/:id/test-account", async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;

  if (!isSuperAdmin(req.user)) {
    apiError(
      res,
      403,
      "test_account_not_permitted",
      "Only a super_admin can flag an account as a test account."
    );
    return;
  }

  const flag = parseFlag(req.body);
  if (flag === null) {
    apiError(res, 400, "bad_request", "is_test_account must be a boolean");
    return;
  }

  const actor = req.user?.id;
  if (!actor) {
    apiError(res, 403, "forbidden", "an authenticated actor is required");
    return;
  }

  const { data, error } = await supabase.rpc("set_test_account", {
    p_user: id,
    p_flag: flag,
    p_actor: actor,
  });

  if (error) {
    handleRpcError(res, error, "test-account-flag");
    return;
  }

  const result = interpretSetFlagResult(data);
  if (!result.found) {
    apiError(res, 404, "not_found", "user not found");
    return;
  }

  console.log(
    `[test-account-flag] user=${id} is_test_account=${result.isTestAccount} changed=${result.changed} actor=${actor}`
  );
  res.json({
    ok: true,
    user_id: id,
    is_test_account: result.isTestAccount,
    changed: result.changed,
  });
});

// POST /users/:id/reset — wipe a flagged test account at one of two depths, then rebuild THAT ONE
// USER's plan.
//
// The rebuild is single-user (`rebuild_user_mlp`), never scope:all: a reset changes one member's
// state and must not re-derive every member's plan. It is part of the contract, not a nicety —
// moosii-rn will not self-recompute for up to 6 hours after a reset, because
// `mlp_last_recompute_<userId>` lives in expo-secure-store and survives the wipe
// (src/lib/mlpFreshness.ts:8, useMlpForegroundRecompute.ts:30). If the server does not rebuild, the
// app shows a plan derived from deleted state.
router.post("/:id/reset", async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id;

  if (!isSuperAdmin(req.user)) {
    apiError(res, 403, "test_account_not_permitted", "Only a super_admin can reset a test account.");
    return;
  }

  const depth = parseResetDepth(req.body);
  if (!depth) {
    apiError(res, 400, "bad_depth", "depth must be 'activity' or 'full'");
    return;
  }

  const actor = req.user?.id;
  if (!actor) {
    apiError(res, 403, "forbidden", "an authenticated actor is required");
    return;
  }

  const { data, error } = await supabase.rpc("reset_test_account", {
    p_user: id,
    p_depth: depth,
    p_actor: actor,
  });

  if (error) {
    handleRpcError(res, error, "test-account-reset");
    return;
  }

  const result = interpretResetResult(data);
  if (!result.found) {
    apiError(res, 404, "not_found", "user not found");
    return;
  }

  console.log(
    `[test-account-reset] user=${id} depth=${depth} rows=${totalDeleted(result.deleted)} actor=${actor}`
  );

  // Awaited, not fire-and-forget: the caller needs to know whether its rebuild was queued or
  // folded into one already waiting. This waits for the job INSERT only — the rebuild itself runs
  // in-process after the response — and the helper never throws, so a rebuild problem can never
  // fail a reset that already committed.
  const rebuild = await enqueueRebuildUserIfIdle(id, {
    reason: `test_account_reset_${depth}`,
    correlationId: id,
  });

  res.json({
    ok: true,
    user_id: id,
    depth: result.depth,
    deleted: result.deleted,
    rows_deleted: totalDeleted(result.deleted),
    ...describeRebuild(rebuild),
  });
});

export default router;
