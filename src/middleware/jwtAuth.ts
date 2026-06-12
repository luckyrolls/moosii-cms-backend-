import type { Request, Response, NextFunction } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";
import type { Tables } from "../types/database.types";

// Authorization reads `user.role` — the SAME column RLS/is_admin() uses.
// (`users_internal` is intentionally NOT used.)
const ADMIN_ROLES = ["admin", "super_admin"];

export type CmsUser = Pick<Tables<"user">, "id" | "email" | "role">;

type AdminAuthResult =
  | { ok: true; user: CmsUser }
  | { ok: false; status: number; code: string; message: string };

// Verify a Supabase access token and require an admin role on the `user` table.
// Shared by the SPA routes (jwtAuthMiddleware) and /jobs (jobsAuthMiddleware).
export async function verifyAdminJwt(token: string): Promise<AdminAuthResult> {
  let authUser;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      console.log(`[auth] JWT verify FAILED: ${error?.message ?? "no user"}`);
      return { ok: false, status: 401, code: "unauthorized", message: "Invalid or expired token" };
    }
    authUser = data.user;
  } catch (err) {
    console.error("[auth] JWT verify threw:", err);
    return { ok: false, status: 401, code: "unauthorized", message: "Could not verify token" };
  }

  // TEMP diagnostic — confirm verification + identity. Remove once stable.
  console.log(`[auth] JWT verified sub=${authUser.id} email=${authUser.email ?? "?"}`);

  // The Supabase profile table's id is the auth uid.
  const { data: profile, error: lookupErr } = await supabase
    .from("user")
    .select("id, email, role")
    .eq("id", authUser.id)
    .single();

  if (lookupErr || !profile) {
    console.log(
      `[auth] role lookup MISS for sub=${authUser.id} ` +
        `(err=${lookupErr?.message ?? "no row"}) -> DENIED`
    );
    return { ok: false, status: 403, code: "forbidden", message: "No CMS profile for this user" };
  }

  const allowed = ADMIN_ROLES.includes(profile.role);
  // TEMP diagnostic — the authorization decision and why. Remove once stable.
  console.log(
    `[auth] sub=${authUser.id} role=${profile.role} ` +
      `allowed=${allowed} (requires ${ADMIN_ROLES.join("|")})`
  );
  if (!allowed) {
    return { ok: false, status: 403, code: "forbidden", message: "Requires admin role" };
  }

  return { ok: true, user: profile };
}

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

  const result = await verifyAdminJwt(header.slice(7));
  if (!result.ok) {
    apiError(res, result.status, result.code, result.message);
    return;
  }

  req.user = result.user;
  next();
}
