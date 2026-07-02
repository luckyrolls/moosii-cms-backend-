import { Router, Request, Response } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";
import { rebuildOneUser } from "../jobs/handlers/rebuildMlp";

const router = Router();

// POST /mlp/recompute — APP-FACING. Unlike /jobs (admin/internal auth) and the SPA
// routes (admin role), this verifies ANY signed-in Supabase user and recomputes
// THAT user's MLP synchronously into user_mlp. The mobile app calls it with the
// end-user's Supabase JWT (the anon-key session token) after onboarding / a
// completed questionnaire.
//
// SECURITY: user_id is taken from the verified token, NEVER the request body — a
// user can only recompute their own MLP. Synchronous (the recompute is one fast
// atomic rpc), so the app gets a definitive result and doesn't need to poll the
// jobs table (which it can't read under its RLS context anyway).
router.post("/recompute", async (req: Request, res: Response): Promise<void> => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    apiError(res, 401, "unauthorized", "Missing or malformed Authorization header");
    return;
  }
  const token = header.slice("Bearer ".length);

  let userId: string;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) { apiError(res, 401, "unauthorized", "Invalid or expired token"); return; }
    userId = data.user.id;
  } catch {
    apiError(res, 401, "unauthorized", "Could not verify token");
    return;
  }

  try {
    const result = await rebuildOneUser(userId);
    res.json({ ok: true, user_id: userId, items_written: result.items_written });
  } catch (e) {
    apiError(res, 500, "recompute_failed", e instanceof Error ? e.message : String(e));
  }
});

export default router;
