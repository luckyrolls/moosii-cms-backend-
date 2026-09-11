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
