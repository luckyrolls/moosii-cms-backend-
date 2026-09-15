// Boot check for FACTS_API_KEY. PURE (values passed in) so it is unit-tested; src/index.ts
// calls it before listening and exits on "fatal" — the same fail-at-boot posture as DOMAIN.

export const MIN_FACTS_KEY_LENGTH = 32;

export type FactsConfigResult =
  | { kind: "ok" }
  | { kind: "ignored"; message: string }
  | { kind: "fatal"; message: string };

export function checkFactsConfig(
  domain: string,
  factsKey: string | undefined,
  internalKey: string | undefined,
): FactsConfigResult {
  if (domain !== "financial") {
    return factsKey
      ? { kind: "ignored", message: `[facts] FACTS_API_KEY is set but ignored: DOMAIN=${domain} does not serve POST /facts` }
      : { kind: "ok" };
  }
  const key = factsKey?.trim();
  if (!key) {
    return { kind: "fatal", message: "FATAL: FACTS_API_KEY is required when DOMAIN=financial (it gates POST /facts). Generate one with: openssl rand -hex 32" };
  }
  if (key !== factsKey) {
    return { kind: "fatal", message: "FATAL: FACTS_API_KEY has leading/trailing whitespace — partners would never match it" };
  }
  if (key.length < MIN_FACTS_KEY_LENGTH) {
    return { kind: "fatal", message: `FATAL: FACTS_API_KEY must be at least ${MIN_FACTS_KEY_LENGTH} characters (it is held by an outside partner). Generate one with: openssl rand -hex 32` };
  }
  if (internalKey && key === internalKey) {
    return { kind: "fatal", message: "FATAL: FACTS_API_KEY must differ from INTERNAL_API_KEY — the internal key also unlocks POST /jobs" };
  }
  return { kind: "ok" };
}
