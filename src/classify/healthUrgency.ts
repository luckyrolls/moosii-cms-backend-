import { createHash } from "crypto";

// Child-health urgency — PURE. The classifier only EXTRACTS findings (migration 083); this module
// decides the band from the classified child's age and health_urgency_rules (080/082).
// Everything clinical here is PROVISIONAL — docs/provisional-clinical-decisions.md H-D1..H-D9.

export type HealthBand = "emergency" | "same_day" | "routine";
export const HEALTH_BANDS: HealthBand[] = ["emergency", "same_day", "routine"];
const BAND_RANK: Record<HealthBand, number> = { routine: 1, same_day: 2, emergency: 3 };

export function higherBand(a: HealthBand | null, b: HealthBand | null): HealthBand | null {
  if (!a) return b;
  if (!b) return a;
  return BAND_RANK[b] > BAND_RANK[a] ? b : a;
}

export type HealthFlag = { key: string; label: string; description: string };

export type HealthRule = {
  id: string;
  rule_key: string;
  red_flag_key: string;
  min_age_months: number;
  max_age_months: number | null;        // exclusive
  min_temperature_c: number | null;
  min_duration_hours: number | null;
  band: HealthBand;
};

// What the model returns (083 output_schema) — strings, so one schema serves OpenAI + Gemini.
export type RawFinding = { flag: string; temperature?: string; temperature_unit?: string; duration_hours?: string; evidence_span?: string };
export type RawChildHealth = { concern: boolean; symptom_span: string; findings: RawFinding[] };

export type HealthFinding = {
  flag: string;
  temperature_c: number | null;   // null = no temperature stated
  duration_hours: number | null;  // null = no duration stated
  evidence_span: string;
};

// A child_health object is READABLE when its shape is usable. Unreadable → the classifier is
// re-asked, then marked parse_failed (H-D9) — never silently "no concern".
export function isReadableChildHealth(raw: unknown): raw is RawChildHealth {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.concern !== "boolean" || typeof r.symptom_span !== "string" || !Array.isArray(r.findings)) return false;
  return r.findings.every((f) => !!f && typeof f === "object" && typeof (f as Record<string, unknown>).flag === "string");
}

// "102" F -> 38.9; "38.5" C -> 38.5. No unit: a value above 45 can only be Fahrenheit. Rounded to
// 0.1 °C. Anything non-numeric -> null (treated as "not stated").
export function toCelsius(temperature: string | undefined, unit: string | undefined): number | null {
  if (typeof temperature !== "string" || !temperature.trim()) return null;
  const v = Number(temperature.trim().replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(v)) return null;
  const u = (unit ?? "").trim().toUpperCase();
  const isF = u === "F" || (u !== "C" && v > 45);
  const c = isF ? ((v - 32) * 5) / 9 : v;
  if (c < 30 || c > 45) return null;   // not a plausible body temperature → not stated
  return Math.round(c * 10) / 10;
}

function parseHours(raw: string | undefined): number | null {
  if (typeof raw !== "string" || !/^\s*\d+\s*$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

export function parseFindings(raw: RawChildHealth, flagKeys: Set<string>): { findings: HealthFinding[]; unknown_flags: string[] } {
  const findings: HealthFinding[] = [];
  const unknown = new Set<string>();
  for (const f of raw.findings) {
    const flag = f.flag.trim();
    if (!flagKeys.has(flag)) { if (flag) unknown.add(flag); continue; }
    findings.push({
      flag,
      temperature_c: toCelsius(f.temperature, f.temperature_unit),
      duration_hours: parseHours(f.duration_hours),
      evidence_span: typeof f.evidence_span === "string" ? f.evidence_span : "",
    });
  }
  return { findings, unknown_flags: [...unknown] };
}

// Rule matching (082 header; H-D2/H-D3/H-D4):
//  - age: min <= age < max; an UNKNOWN age matches every age range (highest band for the flag wins)
//  - temperature: >= min_temperature_c, or NOT STATED (a fever without a temperature meets the threshold)
//  - duration: >= min_duration_hours; NOT STATED never matches (a missing duration never escalates)
export function ruleMatches(rule: HealthRule, finding: HealthFinding, age: number | null): boolean {
  if (rule.red_flag_key !== finding.flag) return false;
  if (age !== null) {
    if (age < rule.min_age_months) return false;
    if (rule.max_age_months !== null && age >= rule.max_age_months) return false;
  }
  if (rule.min_temperature_c !== null && finding.temperature_c !== null && finding.temperature_c < rule.min_temperature_c) return false;
  if (rule.min_duration_hours !== null && (finding.duration_hours === null || finding.duration_hours < rule.min_duration_hours)) return false;
  return true;
}

export type HealthBandResult = {
  band: HealthBand | null;          // null = no concern
  matched_rule_ids: string[];
  unmatched_flags: string[];        // recognised flag, no matching rule (a seed gap) -> routine
};

export function resolveHealthBand(concern: boolean, findings: HealthFinding[], age: number | null, rules: HealthRule[]): HealthBandResult {
  if (!concern && findings.length === 0) return { band: null, matched_rule_ids: [], unmatched_flags: [] };
  let band: HealthBand | null = null;
  const matched = new Set<string>();
  const unmatched = new Set<string>();
  for (const finding of findings) {
    const hits = rules.filter((r) => ruleMatches(r, finding, age));
    if (hits.length === 0) { unmatched.add(finding.flag); band = higherBand(band, "routine"); continue; }
    for (const r of hits) { matched.add(r.id); band = higherBand(band, r.band); }
  }
  // A described concern that matched no flag at all is still a concern (H-D4).
  if (band === null) band = "routine";
  return { band, matched_rule_ids: [...matched], unmatched_flags: [...unmatched] };
}

export function renderHealthFlagsForPrompt(flags: HealthFlag[]): string {
  const lines = flags.map((f) => `[${f.key}] ${f.label} — ${f.description}`);
  return `HEALTH FLAGS — for child_health.findings use ONLY these keys:\n\n${lines.join("\n")}`;
}

// Content hash of what decides a band — provenance on every classification.
export function healthRulesVersion(flags: HealthFlag[], rules: HealthRule[]): string {
  const canonical = JSON.stringify({
    flags: [...flags].sort((a, b) => a.key.localeCompare(b.key)).map((f) => [f.key, f.description]),
    rules: [...rules].sort((a, b) => a.rule_key.localeCompare(b.rule_key))
      .map((r) => [r.rule_key, r.red_flag_key, r.min_age_months, r.max_age_months, r.min_temperature_c, r.min_duration_hours, r.band]),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}
