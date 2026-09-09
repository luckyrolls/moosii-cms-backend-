// Shared inputs for the slice-2 hang-fix proof. Every case is a plain
// GenerateFullMLPInput; the same object is fed to the FROZEN pre-fix copy
// (generateFullMLP.before.ts, in a child process under a kill timeout) and to the fixed
// function, so the two can be diffed. Keep these DETERMINISTIC — no Date, no random.

import type { GenerateFullMLPInput } from "../generateFullMLP";

const pool2 = [
  { item_id: "l1", item_type: "lesson", track_id: "A", priority: 1 },
  { item_id: "l2", item_type: "lesson", track_id: "B", priority: 1 },
];

// (c) A normal parent with a child: one Age-typed track, four ordinary tracks with mixed
// weights/priorities (incl. a null priority and a priority tie), lessons with real age
// bounds (some outside the child's age → age-filtered), questionnaires with the 041 age
// gate (one gated, one open), completed items, and one milestone-suppressed questionnaire.
const normalUserPool = [
  // Age track (weight 3) — newborn/infant lessons
  { item_id: "age-01", item_type: "lesson", track_id: "T_age", priority: 10, item_name: "Newborn sleep basics", min_child_age: 0, max_child_age: 3, with_quiz: true },
  { item_id: "age-02", item_type: "lesson", track_id: "T_age", priority: 20, item_name: "Four to six months", min_child_age: 4, max_child_age: 8, with_quiz: false },
  { item_id: "age-03", item_type: "lesson", track_id: "T_age", priority: 30, item_name: "Starting solids", min_child_age: 5, max_child_age: 9, with_quiz: true },
  { item_id: "age-04", item_type: "lesson", track_id: "T_age", priority: 40, item_name: "Toddler tantrums", min_child_age: 12, max_child_age: 36, with_quiz: true },
  { item_id: "age-05", item_type: "lesson", track_id: "T_age", priority: null, item_name: "Any age: play", min_child_age: null, max_child_age: null, with_quiz: false },
  // Sleep track (weight 2, priority 1)
  { item_id: "slp-01", item_type: "lesson", track_id: "T_sleep", priority: 100, item_name: "Bedtime routine", min_child_age: null, max_child_age: null, with_quiz: true },
  { item_id: "slp-02", item_type: "lesson", track_id: "T_sleep", priority: 200, item_name: "Night wakings", min_child_age: 3, max_child_age: 18, with_quiz: true },
  { item_id: "slp-03", item_type: "lesson", track_id: "T_sleep", priority: 200, item_name: "Naps (tie on priority)", min_child_age: null, max_child_age: null, with_quiz: false },
  { item_id: "slp-q1", item_type: "questionnaire", track_id: "T_sleep", priority: 150, item_name: "How is sleep going?", min_child_age: null, max_child_age: null, with_quiz: null },
  { item_id: "slp-q2", item_type: "questionnaire", track_id: "T_sleep", priority: 160, item_name: "Sleep training readiness (gated ≥ 12m)", min_child_age: 12, max_child_age: null, with_quiz: null },
  // Feeding track (weight 1, priority 3)
  { item_id: "fed-01", item_type: "lesson", track_id: "T_feed", priority: 5, item_name: "Feeding cues", min_child_age: 0, max_child_age: 12, with_quiz: true },
  { item_id: "fed-02", item_type: "lesson", track_id: "T_feed", priority: 6, item_name: null, min_child_age: null, max_child_age: null, with_quiz: null },
  { item_id: "fed-03", item_type: "lesson", track_id: "T_feed", priority: 7, item_name: "Weaning (out of age)", min_child_age: 12, max_child_age: 24, with_quiz: false },
  { item_id: "fed-q1", item_type: "questionnaire", track_id: "T_feed", priority: 1, item_name: "Feeding check-in", min_child_age: null, max_child_age: null, with_quiz: null },
  // Development track (weight 5, priority 4)
  { item_id: "dev-01", item_type: "lesson", track_id: "T_dev", priority: 1, item_name: "Rolling over", min_child_age: 3, max_child_age: 7, with_quiz: true },
  { item_id: "dev-02", item_type: "lesson", track_id: "T_dev", priority: 2, item_name: "Sitting up", min_child_age: 5, max_child_age: 9, with_quiz: true },
  { item_id: "dev-03", item_type: "lesson", track_id: "T_dev", priority: 3, item_name: "Crawling", min_child_age: 6, max_child_age: 11, with_quiz: true },
  { item_id: "dev-04", item_type: "lesson", track_id: "T_dev", priority: 4, item_name: "Walking (out of age)", min_child_age: 9, max_child_age: 18, with_quiz: true },
  { item_id: "dev-05", item_type: "lesson", track_id: "T_dev", priority: 5, item_name: "Babbling", min_child_age: 4, max_child_age: 10, with_quiz: false },
  { item_id: "dev-06", item_type: "lesson", track_id: "T_dev", priority: 6, item_name: "Object permanence", min_child_age: null, max_child_age: null, with_quiz: false },
  { item_id: "dev-q1", item_type: "questionnaire", track_id: "T_dev", priority: 0, item_name: "Rolling milestone check (suppressed)", min_child_age: 3, max_child_age: null, with_quiz: null },
  // Mood track (weight 1, null priority)
  { item_id: "mod-01", item_type: "lesson", track_id: "T_mood", priority: 2, item_name: "Baby blues vs PPD", min_child_age: null, max_child_age: null, with_quiz: false },
  { item_id: "mod-02", item_type: "lesson", track_id: "T_mood", priority: 1, item_name: "Asking for help", min_child_age: null, max_child_age: null, with_quiz: false },
  { item_id: "mod-q1", item_type: "questionnaire", track_id: "T_mood", priority: 3, item_name: "EPDS (never suppressible)", min_child_age: null, max_child_age: null, with_quiz: null },
  // An item on a track that is NOT active for this user — must never appear.
  { item_id: "orphan-01", item_type: "lesson", track_id: "T_inactive", priority: 1, item_name: "Not in plan", min_child_age: null, max_child_age: null, with_quiz: false },
];

const normalUserTracks = [
  { track_id: "T_age", track_name: "Age", weight: 3, priority: 2, track_type: "Age" },
  { track_id: "T_sleep", track_name: "Sleep", weight: 2, priority: 1, track_type: "topic" },
  { track_id: "T_feed", track_name: "Feeding", weight: 1, priority: 3, track_type: null },
  { track_id: "T_dev", track_name: "Development", weight: 5, priority: 4, track_type: "milestone" },
  { track_id: "T_mood", track_name: "Mood", weight: 1, priority: null, track_type: "" },
];

export const cases: Record<string, GenerateFullMLPInput> = {
  // (a) zero-weight track — hangs before (NaN cycle count), throws after.
  zero_weight_track: {
    pool: pool2,
    tracks: [
      { track_id: "A", track_name: "A", weight: 0, priority: 1, track_type: null },
      { track_id: "B", track_name: "B", weight: 1, priority: 2, track_type: null },
    ],
    ages: [6],
    youngestAgeMonths: 6,
  },

  // (b) Age-typed track + no child age — hangs before, completes with BASE weight after.
  age_track_empty_ages: {
    pool: pool2,
    tracks: [
      { track_id: "A", track_name: "A", weight: 2, priority: 1, track_type: "Age" },
      { track_id: "B", track_name: "B", weight: 1, priority: 2, track_type: null },
    ],
    ages: [],
    youngestAgeMonths: null,
  },

  // (c) normal parent with a 6-month-old — must be byte-identical before/after.
  normal_user_6m: {
    pool: normalUserPool,
    tracks: normalUserTracks,
    completedItems: [
      { item_id: "slp-01", item_type: "lesson" },
      { item_id: "dev-01", item_type: "lesson" },
      { item_id: "fed-q1", item_type: "questionnaire" },
    ],
    ages: [6],
    youngestAgeMonths: 6,
    suppressedItemKeys: ["questionnaire:dev-q1"],
  },

  // (c′) same catalog, a 2-month-old — newborn bracket, different age filtering.
  normal_user_2m: {
    pool: normalUserPool,
    tracks: normalUserTracks,
    completedItems: [],
    ages: [2],
    youngestAgeMonths: 2,
    suppressedItemKeys: [],
  },

  // (c″) same catalog, two children (2m + 14m) — multiple brackets accumulate. The
  // recompute passes one age today, but the function accepts many; keep it identical.
  normal_user_two_ages: {
    pool: normalUserPool,
    tracks: normalUserTracks,
    completedItems: [{ item_id: "mod-02", item_type: "lesson" }],
    ages: [2, "14"],
    youngestAgeMonths: 2,
    suppressedItemKeys: [],
  },

  // (c‴) zero-children user with NO Age-typed track — completed before AND after; the
  // fix must not touch this path (non-Age weights are never age-scaled).
  no_age_track_empty_ages: {
    pool: normalUserPool.filter((i) => i.track_id !== "T_age"),
    tracks: normalUserTracks.filter((t) => t.track_id !== "T_age"),
    completedItems: [],
    ages: [],
    youngestAgeMonths: null,
    suppressedItemKeys: [],
  },
};

// Cases whose output must be identical before and after (the ranking snapshot).
export const identityCases = ["normal_user_6m", "normal_user_2m", "normal_user_two_ages", "no_age_track_empty_ages"] as const;
