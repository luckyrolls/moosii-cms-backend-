import type { Request, Response, NextFunction } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";

export async function jwtAuthMiddleware(
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

  // Verify the JWT against Supabase auth
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    apiError(res, 401, "unauthorized", "Invalid or expired token");
    return;
  }

  // Check the user exists in users_internal (i.e. is a CMS user)
  const { data: internalUser, error: lookupErr } = await supabase
    .from("users_internal")
    .select("*")
    .eq("user_id_auth", user.id)
    .single();

  if (lookupErr || !internalUser) {
    apiError(res, 403, "forbidden", "User does not have CMS access");
    return;
  }

  req.user = internalUser;
  next();
}
