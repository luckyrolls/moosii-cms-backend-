// Pure helpers for the test-account routes (migration 127).
//
// Everything decidable without a database lives here so it is unit-testable: the HINT -> HTTP
// mapping, the depth parser, the super_admin gate and the RPC result readers. The routes
// orchestrate; this module decides.

export const RESET_DEPTHS = ["activity", "full"] as const;
export type ResetDepth = (typeof RESET_DEPTHS)[number];

// MIGRATION 127 refusals. Both RPCs and the table trigger raise ERRCODE check_violation (23514)
// with a distinct HINT; PostgREST passes the hint through on the error object. Same contract as
// 126's mapPublishError: the HINT IS the error code, so the CMS switches on a stable string
// instead of parsing prose. An unknown hint returns null and the caller keeps its 500 — an
// unrecognised database error must never be dressed up as a 403.
const TEST_ACCOUNT_REFUSALS: Record<string, { status: number; message: string }> = {
  test_account_not_permitted: {
    status: 403,
    message: "Only a super_admin can flag or reset a test account.",
  },
  not_test_account: {
    status: 409,
    message:
      "This account is not flagged as a test account. Flag it first — reset refuses to touch a real account.",
  },
  bad_depth: {
    status: 400,
    message: "Reset depth must be 'activity' or 'full'.",
  },
};

export function mapTestAccountError(
  error: { hint?: string | null; code?: string | null; message?: string | null } | null | undefined
): { status: number; code: string; message: string } | null {
  const hint = error?.hint ?? null;
  if (!hint) return null;
  const hit = TEST_ACCOUNT_REFUSALS[hint];
  if (!hit) return null;
  return { status: hit.status, code: hint, message: hit.message };
}

// MIGRATION-FIRST TOLERANCE (CLAUDE.md): push deploys, but 127 is applied by hand afterwards. In
// that window the RPCs and the column do not exist. A plain 500 would be indistinguishable from a
// real fault, so detect the two "not applied yet" shapes and let the route answer 503
// `migration_pending` — a clear, self-describing state rather than a mystery.
//   * missing function — PostgREST PGRST202, Postgres 42883
//   * missing column   — PostgREST PGRST204, Postgres 42703
export function isMigrationPendingError(
  error: { code?: string | null; message?: string | null } | null | undefined
): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (["PGRST202", "42883", "PGRST204", "42703"].includes(code)) return true;
  const m = error.message ?? "";
  return (
    /could not find the function/i.test(m) ||
    /function .*does not exist/i.test(m) ||
    /column .*does not exist/i.test(m) ||
    /is_test_account/i.test(m)
  );
}

// Flagging and resetting are super_admin ONLY (Mark, 2026-11-17) — not `admin`, and not a
// capability. Fail closed: no user, or no role, is not a super_admin. The database checks this
// again against p_actor, which is the authority; this is for a clean 403.
export function isSuperAdmin(user: { role?: string | null } | undefined): boolean {
  return user?.role === "super_admin";
}

// `depth` from the request body. Returns null for anything that is not one of the two literals —
// the route turns that into a 400 before any RPC call, so a typo never reaches the database.
export function parseResetDepth(body: unknown): ResetDepth | null {
  if (!body || typeof body !== "object") return null;
  const d = (body as Record<string, unknown>).depth;
  return typeof d === "string" && (RESET_DEPTHS as readonly string[]).includes(d)
    ? (d as ResetDepth)
    : null;
}

// `is_test_account` from the request body. Strictly boolean: a string "true" is a client bug, not
// an intent to flag, and silently coercing it would make the audit trail lie.
export function parseFlag(body: unknown): boolean | null {
  if (!body || typeof body !== "object") return null;
  const f = (body as Record<string, unknown>).is_test_account;
  return typeof f === "boolean" ? f : null;
}

export type SetFlagResult =
  | { found: false }
  | { found: true; isTestAccount: boolean; changed: boolean };

// set_test_account returns {found:false} | {found:true, is_test_account, changed}. Anything else —
// null, a non-object, a missing flag — is read as NOT found rather than guessed at, so a malformed
// result becomes a 404 and never a false "flagged" report.
export function interpretSetFlagResult(data: unknown): SetFlagResult {
  if (!data || typeof data !== "object") return { found: false };
  const d = data as Record<string, unknown>;
  if (d.found !== true) return { found: false };
  if (typeof d.is_test_account !== "boolean") return { found: false };
  return { found: true, isTestAccount: d.is_test_account, changed: d.changed === true };
}

export type ResetResult =
  | { found: false }
  | { found: true; depth: string; deleted: Record<string, unknown> };

// reset_test_account returns {found:false} | {found:true, depth, deleted:{table:count}}. Same
// strictness: a result without a `deleted` object is not reported as a successful reset.
export function interpretResetResult(data: unknown): ResetResult {
  if (!data || typeof data !== "object") return { found: false };
  const d = data as Record<string, unknown>;
  if (d.found !== true) return { found: false };
  if (typeof d.depth !== "string") return { found: false };
  if (!d.deleted || typeof d.deleted !== "object") return { found: false };
  return { found: true, depth: d.depth, deleted: d.deleted as Record<string, unknown> };
}

// Total rows removed across every table, for the log line and the CMS summary. Values that are
// not numbers (e.g. the `skipped_no_user_column` marker the RPC reports for quiz_user_progress)
// are ignored rather than coerced.
export function totalDeleted(deleted: Record<string, unknown>): number {
  return Object.values(deleted).reduce<number>(
    (sum, v) => sum + (typeof v === "number" && Number.isFinite(v) ? v : 0),
    0
  );
}
