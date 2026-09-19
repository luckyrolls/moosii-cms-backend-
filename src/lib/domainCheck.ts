// Pure comparison between the backend's DOMAIN env and the database's own
// `app_settings.domain` row (migration 064).
//
// WHY THIS IS A SEPARATE MODULE FROM domain.ts: domain.ts validates the env AT IMPORT and
// calls process.exit on failure. Importing it from a test would kill the test runner. This
// file has no side effects at all, so the decision can be tested directly.
//
// WHY THE CHECK EXISTS: the DB enforces the published-content edit policy from its own row
// (the financial block guard), while the service believes whatever DOMAIN says. If those two
// ever disagree, one half of the deployment enforces the wrong domain's rules — silently. A
// mislabelled deployment must fail to boot rather than run.

export type DomainCheckResult =
  | { kind: "ok" }
  | { kind: "unseeded"; message: string }   // warn, keep booting
  | { kind: "mismatch"; message: string };  // fatal

// Reading app_settings.domain can fail for exactly ONE benign reason: migration 064 has not been
// applied yet, so the table does not exist (the backend auto-deploys on push; 064 is applied by
// hand afterwards). Every other failure means this service cannot read ITS OWN database correctly —
// e.g. SUPABASE_URL with `/rest/v1/` appended (a real outage, 2026-09-18: supabase-js returned an
// error with no code and no message, the old check logged "(undefined)" and booted, and every JWT
// was then refused with 401), a key from another project, or an unreachable host. Those must stop
// the boot, not surface later as mysterious auth failures.
//
// Table-missing codes: 42P01 (Postgres "relation … does not exist", what PostgREST returns today —
// verified 2026-09-18) and PGRST205 (newer PostgREST's "Could not find the table … in the schema
// cache"). Anything else — including an error with no code at all — is fatal.
export const TABLE_MISSING_CODES = ["42P01", "PGRST205"] as const;

export type DomainReadError = { code?: string | null; message?: string | null } | null | undefined;

export type DomainReadErrorResult =
  | { kind: "table_missing"; message: string }   // warn, keep booting (pre-064)
  | { kind: "fatal"; message: string };          // exit

export function classifyDomainReadError(error: DomainReadError): DomainReadErrorResult {
  const code = typeof error?.code === "string" ? error.code.trim() : "";
  const msg = typeof error?.message === "string" ? error.message.trim() : "";

  if ((TABLE_MISSING_CODES as readonly string[]).includes(code)) {
    return {
      kind: "table_missing",
      message:
        `[domain] app_settings does not exist yet (${code}${msg ? `: ${msg}` : ""}); ` +
        `skipping the cross-check. Expected only until migration 064 is applied.`,
    };
  }

  const detail = code || msg ? `${code || "no code"}${msg ? `: ${msg}` : ""}` : "no code and no message";
  return {
    kind: "fatal",
    message:
      `FATAL: could not read app_settings.domain (${detail}). This service cannot read its own ` +
      `database, so it will not boot. Check SUPABASE_URL is the bare project origin ` +
      `(https://<ref>.supabase.co — no /rest/v1 or other path) and that SUPABASE_SERVICE_ROLE_KEY ` +
      `belongs to that same project.`,
  };
}

export function compareDomainToDatabase(
  envDomain: string,
  dbValue: string | null | undefined
): DomainCheckResult {
  const db = typeof dbValue === "string" ? dbValue.trim() : "";

  // No row yet. A fresh project that has not had migration 064 seeded is a legitimate state,
  // and refusing to boot over it would make standing up a new deployment impossible. Warn.
  if (db === "") {
    return {
      kind: "unseeded",
      message:
        `[domain] app_settings.domain is not set; the database cannot enforce a per-domain ` +
        `policy. Expected '${envDomain}'. Seed it: ` +
        `INSERT INTO app_settings (key, value) VALUES ('domain', '${envDomain}') ` +
        `ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`,
    };
  }

  if (db === envDomain) return { kind: "ok" };

  return {
    kind: "mismatch",
    message:
      `FATAL: domain mismatch — DOMAIN env is '${envDomain}' but app_settings.domain is ` +
      `'${db}'. The database would enforce '${db}' policy while this service behaves as ` +
      `'${envDomain}'. Fix one of them before starting; a mislabelled deployment must not run.`,
  };
}
