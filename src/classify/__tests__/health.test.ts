// Child-health pure modules: age, band resolution, distress narrowing, response order, and the
// classifier retry loop. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ageMonths } from "../childAge";
import {
  parseFindings, resolveHealthBand, toCelsius, isReadableChildHealth, renderHealthFlagsForPrompt, healthRulesVersion,
  type HealthRule, type HealthFinding,
} from "../healthUrgency";
import { narrowDistress } from "../distressNarrowing";
import { orderResponses } from "../responsePrecedence";
import { resolveClassification, type GenResult } from "../resolve";

// ---- the provisional seed rules that matter for these tests (migration 082) -------------------
const r = (id: string, flag: string, min: number, max: number | null, temp: number | null, dur: number | null, band: HealthRule["band"]): HealthRule =>
  ({ id, rule_key: id, red_flag_key: flag, min_age_months: min, max_age_months: max, min_temperature_c: temp, min_duration_hours: dur, band });
const RULES: HealthRule[] = [
  r("fever_under_3mo", "fever", 0, 3, 38.0, null, "emergency"),
  r("fever_40c_any_age", "fever", 0, null, 40.0, null, "same_day"),
  r("fever_24h_under_2y", "fever", 0, 24, null, 24, "same_day"),
  r("fever_72h_2y_plus", "fever", 24, null, null, 72, "same_day"),
  r("fever_3mo_plus", "fever", 3, null, null, null, "routine"),
  r("breathing_severe_any", "breathing_severe", 0, null, null, null, "emergency"),
  r("mild_illness_any", "mild_illness", 0, null, null, null, "routine"),
  r("poisoning_ingestion_any", "poisoning_ingestion", 0, null, null, null, "emergency"),
];
const FLAGS = new Set(["fever", "breathing_severe", "mild_illness", "poisoning_ingestion", "rash_mild_unruled"]);
const fever = (temperature_c: number | null, duration_hours: number | null = null): HealthFinding => ({ flag: "fever", temperature_c, duration_hours, evidence_span: "fever" });
const band = (findings: HealthFinding[], age: number | null) => resolveHealthBand(true, findings, age, RULES).band;

// ---- childAge ------------------------------------------------------------------------------------
test("ageMonths matches the user_mlp_data formula (birth_month 0-11, born on the 1st)", () => {
  const now = new Date(Date.UTC(2026, 8, 15));           // 15 Sep 2026
  assert.equal(ageMonths(2026, 8, now), 0);              // Sep 2026
  assert.equal(ageMonths(2026, 6, now), 2);              // Jul 2026
  assert.equal(ageMonths(2026, 5, now), 3);              // Jun 2026 → exactly 3 → no longer "under 3"
  assert.equal(ageMonths(2024, 8, now), 24);
  assert.equal(ageMonths("2025", "0", now), 20);
});
test("ageMonths returns null for missing, invalid or future birth data", () => {
  const now = new Date(Date.UTC(2026, 8, 15));
  for (const [y, m] of [[null, 3], [2026, null], [2026, 12], [2026, -1], [1800, 1], [2026.5, 1], [2027, 0]] as const) {
    assert.equal(ageMonths(y, m, now), null, `${y}/${m}`);
  }
});

// ---- temperature parsing ---------------------------------------------------------------------------
test("toCelsius: F, C, unit inferred from the value, implausible → null", () => {
  assert.equal(toCelsius("102", "F"), 38.9);
  assert.equal(toCelsius("100.4", "F"), 38);
  assert.equal(toCelsius("38.5", "C"), 38.5);
  assert.equal(toCelsius("104", ""), 40);          // > 45 can only be °F
  assert.equal(toCelsius("39", ""), 39);
  assert.equal(toCelsius("", "F"), null);
  assert.equal(toCelsius("high", ""), null);
  assert.equal(toCelsius("12", "C"), null);        // not a body temperature
});

test("parseFindings drops unknown flags (audited) and parses strings", () => {
  const { findings, unknown_flags } = parseFindings({
    concern: true, symptom_span: "x",
    findings: [
      { flag: "fever", temperature: "102", temperature_unit: "F", duration_hours: "48", evidence_span: "fever of 102 for 2 days" },
      { flag: "made_up_flag", temperature: "", temperature_unit: "", duration_hours: "", evidence_span: "?" },
      { flag: "fever", temperature: "", temperature_unit: "", duration_hours: "a couple of days", evidence_span: "high fever" },
    ],
  }, FLAGS);
  assert.deepEqual(unknown_flags, ["made_up_flag"]);
  assert.deepEqual(findings.map((f) => [f.temperature_c, f.duration_hours]), [[38.9, 48], [null, null]]);
});

// ---- band resolution: Mark's decisions -------------------------------------------------------------
test("MARK'S EXAMPLE: fever with no temperature in a child under 3 months → emergency", () => {
  assert.equal(band([fever(null)], 1), "emergency");
  assert.equal(band([fever(null)], 0), "emergency");
});
test("under 3 months: 38.0 °C meets, 37.8 °C does not reach emergency", () => {
  assert.equal(band([fever(38.0)], 2), "emergency");
  assert.equal(band([fever(37.8)], 2), "routine");      // recognised flag, no matching rule → routine
});
test("fever without a temperature MEETS temperature thresholds at any age (so ≥ 3 months → same_day via 40 °C)", () => {
  assert.equal(band([fever(null)], 3), "same_day");
  assert.equal(band([fever(null)], 30), "same_day");
  assert.equal(band([fever(38.5)], 30), "routine");
  assert.equal(band([fever(40.0)], 30), "same_day");
});
test("missing duration never escalates; a stated duration can", () => {
  assert.equal(band([fever(38.5, null)], 12), "routine");
  assert.equal(band([fever(38.5, 23)], 12), "routine");
  assert.equal(band([fever(38.5, 24)], 12), "same_day");   // under 2 years, ≥ 24 h
  assert.equal(band([fever(38.5, 48)], 30), "routine");    // 2 years+, needs 72 h
  assert.equal(band([fever(38.5, 72)], 30), "same_day");
});
test("unknown child age takes the highest band for the flag", () => {
  assert.equal(band([fever(38.5)], null), "emergency");     // could be under 3 months
  assert.equal(band([fever(37.0)], null), "routine");       // meets no temperature threshold at any age
  assert.equal(band([{ ...fever(null), flag: "mild_illness" }], null), "routine");
});
test("highest band across findings wins; poisoning is emergency", () => {
  assert.equal(band([{ ...fever(null), flag: "mild_illness" }, { ...fever(null), flag: "breathing_severe" }], 40), "emergency");
  assert.equal(band([{ ...fever(null), flag: "poisoning_ingestion" }], 40), "emergency");
});
test("a recognised flag with no rule → routine + unmatched; concern with no findings → routine; no concern → null", () => {
  const res = resolveHealthBand(true, [{ ...fever(null), flag: "rash_mild_unruled" }], 10, RULES);
  assert.deepEqual([res.band, res.unmatched_flags], ["routine", ["rash_mild_unruled"]]);
  assert.equal(resolveHealthBand(true, [], 10, RULES).band, "routine");
  assert.equal(resolveHealthBand(false, [], 10, RULES).band, null);
  assert.deepEqual(resolveHealthBand(true, [fever(null)], 1, RULES).matched_rule_ids.sort(), ["fever_40c_any_age", "fever_under_3mo"]);
});

test("isReadableChildHealth: shape gate for the retry loop", () => {
  assert.equal(isReadableChildHealth({ concern: false, symptom_span: "", findings: [] }), true);
  for (const bad of [null, "x", { concern: "yes", symptom_span: "", findings: [] }, { concern: true, findings: [] }, { concern: true, symptom_span: "", findings: [{ temperature: "1" }] }]) {
    assert.equal(isReadableChildHealth(bad), false, JSON.stringify(bad));
  }
});

test("prompt rendering and rules version are deterministic", () => {
  const flags = [{ key: "fever", label: "Fever", description: "d" }];
  assert.match(renderHealthFlagsForPrompt(flags), /^HEALTH FLAGS — for child_health\.findings use ONLY these keys:\n\n\[fever\] Fever — d$/);
  assert.equal(healthRulesVersion(flags, RULES), healthRulesVersion(flags, [...RULES].reverse()));
  assert.notEqual(healthRulesVersion(flags, RULES), healthRulesVersion(flags, RULES.slice(1)));
});

// ---- distress narrowing -----------------------------------------------------------------------------
const SPANS = ["mia is running a high fever the last couple of days"];
test("strain/overwhelm whose evidence is only symptom wording → none, marked", () => {
  assert.deepEqual(narrowDistress("strain", "running a high fever the last couple of days", SPANS), { tier: "none", downgraded_from: "strain" });
  assert.deepEqual(narrowDistress("overwhelm", "Mia is running a high fever", SPANS), { tier: "none", downgraded_from: "overwhelm" });
});
test("evidence with the parent's own words is NOT downgraded (MARK'S SECOND EXAMPLE)", () => {
  assert.deepEqual(narrowDistress("overwhelm", "and I can't cope anymore", SPANS), { tier: "overwhelm", downgraded_from: null });
  assert.deepEqual(narrowDistress("strain", "high fever, and I can't cope anymore", SPANS), { tier: "strain", downgraded_from: null });
});
test("SAFETY IS NEVER DOWNGRADED — even with evidence identical to the symptom span", () => {
  assert.deepEqual(narrowDistress("safety", SPANS[0], SPANS), { tier: "safety", downgraded_from: null });
  assert.deepEqual(narrowDistress("safety", "he is limp", ["he is limp"]), { tier: "safety", downgraded_from: null });
});
test("no evidence or no health spans → unchanged (lenient)", () => {
  assert.deepEqual(narrowDistress("strain", "", SPANS), { tier: "strain", downgraded_from: null });
  assert.deepEqual(narrowDistress("strain", "running a high fever", []), { tier: "strain", downgraded_from: null });
  assert.deepEqual(narrowDistress("none", "x", SPANS), { tier: "none", downgraded_from: null });
});

// ---- response precedence ------------------------------------------------------------------------------
const copy = (m: string) => ({ message: m, resources: [] });
test("order: safety > emergency > same_day > overwhelm/strain > routine; mixed shows both", () => {
  const levels = (o: ReturnType<typeof orderResponses>) => o.responses.map((x) => `${x.kind}:${x.level}`);
  assert.deepEqual(levels(orderResponses({ distressTier: "safety", distressResponse: copy("s"), healthBand: "emergency", healthResponse: copy("e") })), ["distress:safety", "health:emergency"]);
  assert.deepEqual(levels(orderResponses({ distressTier: "strain", distressResponse: copy("s"), healthBand: "emergency", healthResponse: copy("e") })), ["health:emergency", "distress:strain"]);
  assert.deepEqual(levels(orderResponses({ distressTier: "overwhelm", distressResponse: copy("o"), healthBand: "same_day", healthResponse: copy("d") })), ["health:same_day", "distress:overwhelm"]);
  assert.deepEqual(levels(orderResponses({ distressTier: "strain", distressResponse: copy("s"), healthBand: "routine", healthResponse: copy("r") })), ["distress:strain", "health:routine"]);
});
test("ack: shown with routine or nothing; replaced by same_day/emergency; suppressed under strain+", () => {
  const ack = (t: "none" | "strain" | "safety", b: "emergency" | "same_day" | "routine" | null) =>
    orderResponses({ distressTier: t, distressResponse: t === "none" ? null : copy("d"), healthBand: b, healthResponse: b ? copy("h") : null }).ackAllowed;
  assert.equal(ack("none", null), true);
  assert.equal(ack("none", "routine"), true);
  assert.equal(ack("none", "same_day"), false);
  assert.equal(ack("none", "emergency"), false);
  assert.equal(ack("strain", null), false);
  assert.equal(ack("safety", "routine"), false);
});
test("a missing copy row never re-enables the ack for an emergency", () => {
  const o = orderResponses({ distressTier: "none", distressResponse: null, healthBand: "emergency", healthResponse: null });
  assert.deepEqual([o.responses.length, o.ackAllowed], [0, false]);
});

// ---- retry loop with child health --------------------------------------------------------------------
const gen = (texts: string[]) => { let i = 0; return async (): Promise<GenResult> => ({ text: texts[Math.min(i++, texts.length - 1)], raw: null, model: "fake" }); };
const base = { relevant: false, signals: [], proposed_enrichments: [], distress: { tier: "none", evidence_span: "" } };
const HEALTH = { concern: true, symptom_span: "fever", findings: [{ flag: "fever", temperature: "", temperature_unit: "", duration_hours: "", evidence_span: "fever" }] };

test("resolveClassification: readable child_health on the first attempt", async () => {
  const res = await resolveClassification(gen([JSON.stringify({ ...base, child_health: HEALTH })]), 3, { expectChildHealth: true });
  assert.deepEqual([res.attempts, res.childHealthParseFailed, res.childHealth?.concern], [1, false, true]);
});
test("resolveClassification: unreadable child_health is RE-ASKED, then read", async () => {
  const res = await resolveClassification(gen([JSON.stringify({ ...base, child_health: { concern: "maybe" } }), JSON.stringify({ ...base, child_health: HEALTH })]), 3, { expectChildHealth: true });
  assert.deepEqual([res.attempts, res.childHealthParseFailed], [2, false]);
});
test("resolveClassification: still unreadable after retries → MARKED parse_failed, distress kept", async () => {
  const res = await resolveClassification(gen([JSON.stringify({ ...base, distress: { tier: "Safety", evidence_span: "x" } })]), 3, { expectChildHealth: true });
  assert.deepEqual([res.attempts, res.childHealthParseFailed, res.childHealth, res.distressTier, res.distressParseFailed], [3, true, null, "safety", false]);
});
test("resolveClassification: without expectChildHealth the old contract is unchanged", async () => {
  const res = await resolveClassification(gen([JSON.stringify(base)]));
  assert.deepEqual([res.attempts, res.childHealthParseFailed, res.childHealth, res.distressTier], [1, false, null, "none"]);
});
