// demo_outcome_series re-seed (pure): same points + labels as migration 106, dated relative to the run. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { seriesRows, anchorNoonUtc, OUTCOME_SERIES } from "../outcomeSeries";
import { DEMO_PERSONAS } from "../reset";

test("anchor = the run date's UTC noon, whatever the time of day", () => {
  assert.equal(anchorNoonUtc(new Date("2026-10-24T00:05:00Z")).toISOString(), "2026-10-24T12:00:00.000Z");
  assert.equal(anchorNoonUtc(new Date("2026-10-24T23:59:00Z")).toISOString(), "2026-10-24T12:00:00.000Z");
});

test("rows run 2026-10-24: Sam +42 d, Sarah -30 d / +21 d; same values and labels as migration 106", () => {
  assert.deepEqual(seriesRows(new Date("2026-10-24T18:52:00Z")), [
    { user_id: DEMO_PERSONAS.sam, persona: "sam", fact_key: "credit_utilization_band", value: "moderate",
      observed_at: "2026-12-05T12:00:00.000Z", label: "six weeks later (projected, seeded)" },
    { user_id: DEMO_PERSONAS.sarah, persona: "sarah", fact_key: "has_emergency_buffer", value: "false",
      observed_at: "2026-09-24T12:00:00.000Z", label: "a month ago (seeded)" },
    { user_id: DEMO_PERSONAS.sarah, persona: "sarah", fact_key: "has_emergency_buffer", value: "true",
      observed_at: "2026-11-14T12:00:00.000Z", label: "in three weeks (projected, seeded)" },
  ]);
});

test("every projected point is in the future of the run; the past point is in the past", () => {
  const now = new Date("2026-10-24T18:52:00Z");
  for (const r of seriesRows(now)) {
    const projected = r.label.includes("projected");
    assert.equal(Date.parse(r.observed_at) > now.getTime(), projected, r.label);
  }
  assert.equal(OUTCOME_SERIES.length, 3);
});
