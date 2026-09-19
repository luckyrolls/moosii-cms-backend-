// Whether a deployment has a child-age axis, and the age span a coverage audit runs over.
// Pure (no env, no DB) so it can be unit-tested; callers pass DOMAIN in.
//
// Moosii content is keyed to the child's age in months. Financial content has no age axis at all
// (decision D-C1, 2026-09-16): its lessons carry NULL ages and the MLP treats NULL bounds as
// open-ended. A coverage audit on financial therefore runs WITHOUT a span — no "Age span to cover"
// line in the prompt, no age band in the map — and it ignores a span the caller sends anyway (the
// CMS sends the no-gate 0–1200 for a hidden field), so a meaningless "0–1200 months" never reaches
// the model.

// Type-only import: erased at compile time, so importing this module never runs domain.ts's
// validate-and-exit-at-import (which would kill a test runner).
import type { Domain } from "./domain";

export function domainHasAgeAxis(domain: Domain): boolean {
  return domain !== "financial";
}

export type AgeSpanResolution =
  | { kind: "span"; min: number; max: number; source: "input" | "existing_lessons" }
  | { kind: "none" }                        // no age axis in this domain
  | { kind: "error"; message: string };     // age axis, but nothing to use

export function resolveCoverageAgeSpan(opts: {
  hasAgeAxis: boolean;
  suppliedMin: unknown;
  suppliedMax: unknown;
  existingMins: number[];
  existingMaxs: number[];
}): AgeSpanResolution {
  if (!opts.hasAgeAxis) return { kind: "none" };

  // Unchanged Moosii precedence (§2m): a SUPPLIED span wins (operator override); else DERIVE it
  // from the track's existing lessons; else it is required (a zero-lesson track has nothing to
  // derive from, and tracks carry no age-range column).
  if (typeof opts.suppliedMin === "number" && typeof opts.suppliedMax === "number") {
    return { kind: "span", min: opts.suppliedMin, max: opts.suppliedMax, source: "input" };
  }
  if (opts.existingMins.length > 0 && opts.existingMaxs.length > 0) {
    return {
      kind: "span",
      min: Math.min(...opts.existingMins),
      max: Math.max(...opts.existingMaxs),
      source: "existing_lessons",
    };
  }
  return {
    kind: "error",
    message:
      "No age span available: the track has no existing lessons with age bounds — supply min_child_age and max_child_age in the job input.",
  };
}
