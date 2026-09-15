import { Router, type Request, type Response, type RequestHandler } from "express";
import { randomUUID } from "crypto";
import { apiError } from "../lib/errors";
import { checkFactsBearer } from "./auth";
import { recordFacts, type FactsDeps } from "./service";
import { isUuid } from "./validate";

// /facts routes, built by a FACTORY so tests mount them with fake deps + a fake admin gate
// (the real wiring is src/routes/facts.ts). Contract: docs/api-contract.md §8.

export type FactsReadDeps = {
  loadFactsForUser(userId: string, historyLimit: number): Promise<{ latest: unknown[]; history: unknown[] }>;
};

export type FactsRouterOptions = {
  domain: string;
  factsKey: string | undefined;
  adminAuth: RequestHandler;
  deps: FactsDeps & FactsReadDeps;
};

export const DEFAULT_HISTORY_LIMIT = 200;
export const MAX_HISTORY_LIMIT = 1000;

export function createFactsRouter(opts: FactsRouterOptions): Router {
  const router = Router();

  // POST /facts — partner intake. Does not EXIST outside the financial domain (D5): the gate
  // runs before auth, so a Moosii deployment answers 404 to everyone.
  router.post("/", async (req: Request, res: Response): Promise<void> => {
    if (opts.domain !== "financial") {
      apiError(res, 404, "not_found", "Not found");
      return;
    }
    const auth = checkFactsBearer(req.headers.authorization, opts.factsKey);
    if (!auth.ok) {
      apiError(res, auth.status, auth.code, auth.message);
      return;
    }

    const correlationId = randomUUID();
    try {
      const out = await recordFacts(req.body, opts.deps, correlationId);
      if (out.status !== 200) {
        console.warn(`[facts] rejected ${out.status} ${out.code} key=${auth.fingerprint} corr=${correlationId}: ${out.message}`);
        apiError(res, out.status, out.code, out.message);
        return;
      }
      console.log(`[facts] user=${out.userId} written=${out.body.written} skipped=${out.skipped} rebuild_enqueued=${out.body.rebuild_enqueued} key=${auth.fingerprint} corr=${correlationId}`);
      res.status(200).json(out.body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[facts] write failed key=${auth.fingerprint} corr=${correlationId}: ${msg}`);
      apiError(res, 500, "facts_write_failed", msg);
    }
  });

  // GET /facts/:user_id — CMS inspector, admin JWT. Available on every domain: an empty
  // inspector is harmless. A user with no facts is 200 with empty arrays, never 404.
  router.get("/:user_id", opts.adminAuth, async (req: Request, res: Response): Promise<void> => {
    const userId = req.params.user_id;
    if (!isUuid(userId)) {
      apiError(res, 400, "invalid_request", "user_id must be a uuid");
      return;
    }
    let limit = DEFAULT_HISTORY_LIMIT;
    if (req.query.limit !== undefined) {
      const n = Number(req.query.limit);
      if (!Number.isInteger(n) || n < 1 || n > MAX_HISTORY_LIMIT) {
        apiError(res, 400, "invalid_request", `limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`);
        return;
      }
      limit = n;
    }
    try {
      const { latest, history } = await opts.deps.loadFactsForUser(userId, limit);
      res.json({ user_id: userId, latest, history });
    } catch (e) {
      apiError(res, 500, "facts_read_failed", e instanceof Error ? e.message : String(e));
    }
  });

  return router;
}
