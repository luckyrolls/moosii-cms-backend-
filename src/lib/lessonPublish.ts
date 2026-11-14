// Helpers for the atomic lesson publish/unpublish path (migration 068).
//
// The flip of `lessons.is_published` and its `content_approvals` row must be ONE
// transaction — supabase-js cannot span statements, so the pair lives in the
// `set_lesson_published` RPC and this module interprets its result.
//
// VERSION SKEW: this backend auto-deploys on push, but 068 is applied by hand afterwards.
// In that window the RPC does not exist, and a publish route that simply failed would take
// publishing down entirely. So the route falls back to the old two-step path when — and
// only when — the failure is "no such function". Every other error is a real error and is
// surfaced. Same tolerance principle as src/lib/lessonCreateResult.ts, but the stakes are
// higher here, so the detection is narrow rather than permissive.

export type PublishResult =
  | { found: false }
  | { found: true; isPublished: boolean };

// PostgREST reports an absent function as PGRST202 ("could not find the function ... in the
// schema cache"); Postgres itself uses 42883 (undefined_function). Match on those codes, and
// on the message only as a last resort — a broad message match would swallow genuine errors
// that merely mention a function name.
export function isMissingFunctionError(
  error: { code?: string | null; message?: string | null } | null | undefined
): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  const m = error.message ?? "";
  return /could not find the function/i.test(m) || /function .*does not exist/i.test(m);
}

// The RPC returns {found:false} for an unknown lesson, else {found:true, is_published}.
// Anything else — null, a non-object, a missing flag — is treated as NOT found rather than
// guessed at, so a malformed result becomes a 404 and never a false "published" report.
export function interpretPublishResult(data: unknown): PublishResult {
  if (!data || typeof data !== "object") return { found: false };
  const d = data as Record<string, unknown>;
  if (d.found !== true) return { found: false };
  if (typeof d.is_published !== "boolean") return { found: false };
  return { found: true, isPublished: d.is_published };
}

// MIGRATION 126 refusals. set_lesson_published raises ERRCODE check_violation (23514) with a
// distinct HINT per reason; PostgREST passes the hint through on the error object. Map each to
// an HTTP status and use the HINT ITSELF as the error code, so the CMS switches on a stable
// string rather than parsing prose (the same contract as content_edit_policy_guard's
// `published_content_locked`). Anything without a known hint returns null and the caller
// keeps its existing 500 — an unrecognised database error must not be dressed up as a 403.
const PUBLISH_REFUSALS: Record<string, { status: number; message: string }> = {
  // capability: the actor may not do this at all
  publish_not_permitted:   { status: 403, message: "You do not have permission to publish lessons." },
  unpublish_not_permitted: { status: 403, message: "You do not have permission to unpublish lessons." },
  // state: the lesson is not in a publishable condition
  publish_not_approved: { status: 409, message: "This lesson is not fully approved. Every segment must be clinically approved, and the lesson needs at least one segment." },
  publish_quiz_pending: { status: 409, message: "This lesson has a quiz question that has not been approved yet. Approve or remove it first." },
  publish_archived:     { status: 409, message: "This lesson, or its track, is archived. Unarchive it before publishing." },
};

export function mapPublishError(
  error: { hint?: string | null; code?: string | null; message?: string | null } | null | undefined
): { status: number; code: string; message: string } | null {
  const hint = error?.hint ?? null;
  if (!hint) return null;
  const hit = PUBLISH_REFUSALS[hint];
  if (!hit) return null;
  return { status: hit.status, code: hint, message: hit.message };
}

// Actor for the audit row, from the verified JWT only (invariant 9). The RPC also refuses a
// null actor, but checking here turns it into a clean 403 instead of a database exception.
export type PublishActor = { id: string; role: string | null };

export function resolvePublishActor(
  user: { id?: string | null; role?: string | null } | undefined
): PublishActor | null {
  const id = user?.id;
  if (!id) return null;
  return { id, role: user?.role ?? null };
}
