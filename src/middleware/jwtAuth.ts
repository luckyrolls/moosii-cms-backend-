import type { Request, Response, NextFunction } from "express";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";
import type { Tables } from "../types/database.types";

// Authorization reads `user.role` — the SAME column RLS/is_admin() uses.
// (`users_internal` is intentionally NOT used.)
export const ADMIN_ROLES = ["admin", "super_admin"];
export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && ADMIN_ROLES.includes(role);
}

// Capabilities (migration 056) are SEPARATE from role: role controls what you SEE, capability
// controls what you can SIGN. They ride on req.user so routes can gate without an extra query.
export type CmsUser = Pick<Tables<"user">, "id" | "email" | "role"> & {
  can_review_editorial: boolean;
  can_approve_clinical: boolean;
};

export type Capability = "editorial" | "clinical";

// Capability check for a route. Fail-closed: no user / missing capability → false. The actor
// is ALWAYS req.user (the verified token), never the body — so a client cannot self-grant.
export function hasCapability(user: CmsUser | undefined, cap: Capability): boolean {
  if (!user) return false;
  return cap === "editorial" ? user.can_review_editorial : user.can_approve_clinical;
}

// Any authenticated Supabase user (app parent OR admin). Identity is the auth uid;
// role is nullable because an app parent may have no `user` profile row at all
// (children.parent_id lives in the auth-uid space, which the `user` table only
// partially covers).
export type AnyUser = { id: string; email: string | null; role: string | null };
type AnyAuthResult = { ok: true; user: AnyUser } | { ok: false; status: number; code: string; message: string };

// Verify a Supabase token for ANY signed-in user. Unlike verifyAdminJwt this does
// NOT require an admin (or any) profile — 401 only for an invalid token. The role
// is looked up solely to distinguish admin-console callers from app users; its
// absence means "not admin" (an app parent), which is a valid caller.
export async function verifyAnyUser(token: string): Promise<AnyAuthResult> {
  let authUser;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
      return { ok: false, status: 401, code: "unauthorized", message: "Invalid or expired token" };
    }
    authUser = data.user;
  } catch (err) {
    console.error("[auth] JWT verify threw:", err);
    return { ok: false, status: 401, code: "unauthorized", message: "Could not verify token" };
  }
  const { data: profile } = await supabase
    .from("user")
    .select("email, role")
    .eq("id", authUser.id)
    .maybeSingle();
  return {
    ok: true,
    user: { id: authUser.id, email: profile?.email ?? authUser.email ?? null, role: profile?.role ?? null },
  };
}

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
      return { ok: false, status: 401, code: "unauthorized", message: "Invalid or expired token" };
    }
    authUser = data.user;
  } catch (err) {
    console.error("[auth] JWT verify threw:", err);
    return { ok: false, status: 401, code: "unauthorized", message: "Could not verify token" };
  }

  // The Supabase profile table's id is the auth uid.
  const { data: profile, error: lookupErr } = await supabase
    .from("user")
    .select("id, email, role")
    .eq("id", authUser.id)
    .single();

  if (lookupErr || !profile) {
    return { ok: false, status: 403, code: "forbidden", message: "No CMS profile for this user" };
  }

  if (!ADMIN_ROLES.includes(profile.role)) {
    return { ok: false, status: 403, code: "forbidden", message: "Requires admin role" };
  }

  // Capabilities (migration 056). Best-effort + FAIL CLOSED: if the columns aren't live yet
  // (pre-apply) or the lookup errors, both default false — nobody can sign, the safe
  // direction. Collapse into the profile SELECT above once types are regenerated post-056.
  let can_review_editorial = false;
  let can_approve_clinical = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: caps, error: capErr } = await (supabase as any)
    .from("user")
    .select("can_review_editorial, can_approve_clinical")
    .eq("id", authUser.id)
    .single();
  if (!capErr && caps) {
    can_review_editorial = !!caps.can_review_editorial;
    can_approve_clinical = !!caps.can_approve_clinical;
  }

  return { ok: true, user: { ...profile, can_review_editorial, can_approve_clinical } };
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
