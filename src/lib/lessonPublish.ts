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
