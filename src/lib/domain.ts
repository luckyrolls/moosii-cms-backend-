// DOMAIN — which deployment this backend instance IS. One codebase, one Supabase project
// per domain; the CMS reads this at bootstrap (GET /version → `domain`) and refuses to
// render against the wrong backend. Validated at IMPORT, before anything else boots, and
// FAILS HARD: there is deliberately no default, because an unlabelled deployment is a bug
// (a CMS pointed at the wrong domain would silently edit the other domain's content).
// Same hard-fail pattern as src/supabase.ts. Add a domain here AND in api-contract.md.

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
