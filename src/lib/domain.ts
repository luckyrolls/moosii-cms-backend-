// DOMAIN — which deployment this backend instance IS. One codebase, one Supabase project
// per domain; the CMS reads this at bootstrap (GET /version → `domain`) and refuses to
// render against the wrong backend. Validated at IMPORT, before anything else boots, and
// FAILS HARD: there is deliberately no default, because an unlabelled deployment is a bug
// (a CMS pointed at the wrong domain would silently edit the other domain's content).
// Same hard-fail pattern as src/supabase.ts. Add a domain here AND in api-contract.md.

import { supabase } from "../supabase";
import { compareDomainToDatabase } from "./domainCheck";

export const DOMAINS = ["moosii", "financial"] as const;
export type Domain = (typeof DOMAINS)[number];

function isDomain(value: string): value is Domain {
  return (DOMAINS as readonly string[]).includes(value);
}

const raw = process.env.DOMAIN?.trim();

if (!raw) {
  console.error(
    `FATAL: DOMAIN env is required (one of ${DOMAINS.join(" | ")}); it is unset or empty. ` +
      "Set DOMAIN on Render (and in .env locally) before starting."
  );
  process.exit(1);
}
if (!isDomain(raw)) {
  console.error(
    `FATAL: DOMAIN=${JSON.stringify(raw)} is not a known domain (expected one of ${DOMAINS.join(" | ")}).`
  );
  process.exit(1);
}

export const DOMAIN: Domain = raw;

// Boot check: the DATABASE also carries a domain (app_settings.domain, migration 064) and
// enforces the published-content edit policy from it. If it disagrees with this service's
// DOMAIN, one half of the deployment is applying the wrong domain's rules — exit.
//
// TOLERATES THE PRE-064 WORLD ON PURPOSE. This backend auto-deploys on push; migration 064 is
// applied by hand afterwards. Until then the table does not exist, the query errors, and we
// log and continue — refusing to boot would take the service down for a migration that has
// not been run yet. Same version-skew reasoning as src/lib/lessonCreateResult.ts.
export async function assertDomainMatchesDatabase(): Promise<void> {
  // app_settings is not in the generated types until a regen after 064.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("app_settings")
    .select("value")
    .eq("key", "domain")
    .maybeSingle();

  if (error) {
    console.warn(
      `[domain] could not read app_settings.domain (${error.message}); ` +
        `skipping the cross-check. Expected if migration 064 has not been applied yet.`
    );
    return;
  }

  const result = compareDomainToDatabase(DOMAIN, data?.value);
  if (result.kind === "mismatch") {
    console.error(result.message);
    process.exit(1);
  }
  if (result.kind === "unseeded") console.warn(result.message);
}
