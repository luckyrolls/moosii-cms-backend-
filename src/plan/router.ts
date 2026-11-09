import { Router, type Request, type Response } from "express";
import { apiError } from "../lib/errors";
import { toPlan, type PlanItemRaw, type ReasonRaw } from "./shape";

// GET /plan — app-facing (api-contract §11). The member's own plan, in order, with WHY each track is in it.
// Built by a FACTORY so tests mount it over real HTTP with fake deps and a fake token check; the real wiring is
// src/routes/plan.ts.
//
// Auth: the END-USER's Supabase JWT (a demo-persona session is an ordinary one). The user id comes from the verified
// token, never a query parameter or body (invariant 7) — there is no way to ask for someone else's plan.
// Read-only: no writes, no rebuild, no recompute. The frozen algorithm is not involved (invariant 1).

export type VerifyUser = (token: string) => Promise<
  { ok: true; userId: string } | { ok: false; status: number; code: string; message: string }
>;

export type PlanDeps = {
  listPlan(userId: string): Promise<PlanItemRaw[]>;
  listReasons(userId: string): Promise<ReasonRaw[]>;
};

export function createPlanRouter(opts: { verifyUser: VerifyUser; deps: PlanDeps }): Router {
  const router = Router();

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      apiError(res, 401, "unauthorized", "Missing or malformed Authorization header");
      return;
    }
    const v = await opts.verifyUser(header.slice("Bearer ".length));
    if (!v.ok) {
      apiError(res, v.status, v.code, v.message);
      return;
    }
    try {
      // Both reads are for the SAME user and neither depends on the other, so they go together.
      const [rows, reasons] = await Promise.all([opts.deps.listPlan(v.userId), opts.deps.listReasons(v.userId)]);
      res.json(toPlan(v.userId, rows, reasons));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[plan] failed user=${v.userId}: ${msg}`);
      apiError(res, 500, "plan_failed", "could not load the plan");
    }
  });

  return router;
}
