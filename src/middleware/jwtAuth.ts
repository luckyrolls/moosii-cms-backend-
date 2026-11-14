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

// Capabilities (migrations 056, 126) are SEPARATE from role: role controls what you SEE,
// capability controls what you can SIGN or SHIP. They ride on req.user so routes can gate
// without an extra query.
export type CmsUser = Pick<Tables<"user">, "id" | "email" | "role"> & {
  can_review_editorial: boolean;
  can_approve_clinical: boolean;
  can_publish: boolean;
};

export type Capability = "editorial" | "clinical" | "publish";

// Capability check for a route. Fail-closed: no user / missing capability → false. The actor
// is ALWAYS req.user (the verified token), never the body — so a client cannot self-grant.
// `publish` (126) is checked HERE for a clean 403; set_lesson_published checks it again
// against p_actor_id, which is the authority. The route check is a courtesy, not the gate.
export function hasCapability(user: CmsUser | undefined, cap: Capability): boolean {
  if (!user) return false;
  if (cap === "editorial") return user.can_review_editorial;
  if (cap === "clinical") return user.can_approve_clinical;
  return user.can_publish;
}

// "either of these" gates (unapprove, unpublish, reject). Fail-closed like hasCapability.
export function hasAnyCapability(user: CmsUser | undefined, caps: readonly Capability[]): boolean {
  return caps.some((c) => hasCapability(user, c));
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

  // Capabilities (056, + can_publish in 126). Best-effort + FAIL CLOSED: if a column isn't
  // live yet (pre-apply) or the lookup errors, every capability defaults false — nobody can
  // sign or ship, the safe direction.
  let can_review_editorial = false;
  let can_approve_clinical = false;
  let can_publish = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: caps, error: capErr } = await (supabase as any)
    .from("user")
    .select("can_review_editorial, can_approve_clinical, can_publish")
    .eq("id", authUser.id)
    .single();
  if (!capErr && caps) {
    can_review_editorial = !!caps.can_review_editorial;
    can_approve_clinical = !!caps.can_approve_clinical;
    can_publish = !!caps.can_publish;
  }

  return { ok: true, user: { ...profile, can_review_editorial, can_approve_clinical, can_publish } };
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
