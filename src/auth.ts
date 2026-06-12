import { Request, Response, NextFunction } from "express";
import { apiError } from "./lib/errors";
import { verifyAdminJwt } from "./middleware/jwtAuth";

// /jobs accepts EITHER the server-to-server shared secret (INTERNAL_API_KEY,
// used by internal tooling/tests) OR a CMS admin's Supabase JWT (so the SPA can
// create jobs directly). The shared secret must NEVER be shipped to the browser.
export async function jobsAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    apiError(res, 401, "unauthorized", "Missing or malformed Authorization header");
    return;
  }

  const token = header.slice(7);

  // Server-to-server path: exact match against the shared secret.
  if (process.env.INTERNAL_API_KEY && token === process.env.INTERNAL_API_KEY) {
    next();
    return;
  }

  // Browser path: CMS admin Supabase JWT (verified + role-gated).
  const result = await verifyAdminJwt(token);
  if (!result.ok) {
    apiError(res, result.status, result.code, result.message);
    return;
  }

  req.user = result.user;
  next();
}
