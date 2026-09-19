// DOMAIN — which deployment this backend instance IS. One codebase, one Supabase project
// per domain; the CMS reads this at bootstrap (GET /version → `domain`) and refuses to
// render against the wrong backend. Validated at IMPORT, before anything else boots, and
// FAILS HARD: there is deliberately no default, because an unlabelled deployment is a bug
// (a CMS pointed at the wrong domain would silently edit the other domain's content).
// Same hard-fail pattern as src/supabase.ts. Add a domain here AND in api-contract.md.

import { supabase } from "../supabase";
import { classifyDomainReadError, compareDomainToDatabase } from "./domainCheck";

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
// TOLERATES THE PRE-064 WORLD ON PURPOSE — AND ONLY THAT. This backend auto-deploys on push;
// migration 064 is applied by hand afterwards, so "the table does not exist" logs and continues.
// Any OTHER read error exits (classifyDomainReadError): a wrong SUPABASE_URL or key used to be
// swallowed here, boot as healthy, and fail every sign-in with 401 (2026-09-18).
export async function assertDomainMatchesDatabase(): Promise<void> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "domain")
    .maybeSingle();

  if (error) {
    const read = classifyDomainReadError(error);
    if (read.kind === "fatal") {
      console.error(read.message);
      process.exit(1);
    }
    console.warn(read.message);
    return;
  }

  const result = compareDomainToDatabase(DOMAIN, data?.value);
  if (result.kind === "mismatch") {
    console.error(result.message);
    process.exit(1);
  }
  if (result.kind === "unseeded") console.warn(result.message);
}
