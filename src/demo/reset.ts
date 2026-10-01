// Demo reset — the PURE half of `npm run demo:reset` (scripts/demoReset.ts does the I/O). Returns the demo
// personas to their pre-demo state on FINANCIAL: deletes the per-user progress a demo session writes, keeps
// Sam's seeded orientation completion (FINDINGS-demo-personas, "Seeded completion"), recomputes moosies.
// Never touched: user_facts, demo_outcome_series, user_configurations, audits, any other user.

export const DEMO_PERSONAS = {
  sam: "19587e0a-bfe0-48e2-94a1-055a5bbc9584",
  sarah: "ad6910ab-854b-480b-8fbb-df78ac9147d3",
} as const;
export type DemoPersona = keyof typeof DEMO_PERSONAS;

// "What the App Can See Now" — Sam's seeded (backdated) orientation completion. Kept by every reset.
export const SAM_ORIENTATION_LESSON = "06eef3f3-c2ab-43e9-ba58-8dc52a742232";

// Per-user progress/state a demo session can write (app completions, questionnaires/check-ins, classify apply).
// Each has an `id` PK and a `user_id` column; none has a DELETE trigger.
export const RESET_TABLES = [
  "completed_items",
  "user_lesson_progress",
  "questionnaire_user_answers",
  "user_questionnaire_progress",
  "user_track_activations",
  "user_mlp_mods",
  "user_tracks",
] as const;
export type ResetTable = (typeof RESET_TABLES)[number];

// Columns fetched per table — just enough to recognise the protected seed rows.
export const SELECT_COLUMNS: Record<ResetTable, string> = {
  completed_items: "id, user_id, item_type, item_id, lesson_id",
  user_lesson_progress: "id, user_id, lesson_id",
  questionnaire_user_answers: "id, user_id",
  user_questionnaire_progress: "id, user_id",
  user_track_activations: "id, user_id",
  user_mlp_mods: "id, user_id",
  user_tracks: "id, user_id",
};

export type Row = { id: string | number; user_id: string } & Record<string, unknown>;

export function parseArgs(argv: string[]): { go: boolean } | { error: string } {
  let go = false;
  for (const a of argv) {
    if (a === "--go") go = true;
    else return { error: `unknown argument ${JSON.stringify(a)} — the only option is --go (lowercase)` };
  }
  return { go };
}

export function isProtectedSeed(table: ResetTable, row: Row): boolean {
  if (row.user_id !== DEMO_PERSONAS.sam) return false;
  if (table === "completed_items") {
    return row.item_type === "lesson" && (row.item_id === SAM_ORIENTATION_LESSON || row.lesson_id === SAM_ORIENTATION_LESSON);
  }
  if (table === "user_lesson_progress") return row.lesson_id === SAM_ORIENTATION_LESSON;
  return false;
}

// Rows to delete: the personas' rows minus the protected seed. Rows of any other user are never returned,
// even if the caller passes them in (belt and braces on top of the query filter).
export function rowsToDelete(table: ResetTable, rows: Row[]): Row[] {
  const personaIds = new Set<string>(Object.values(DEMO_PERSONAS));
  return rows.filter((r) => personaIds.has(r.user_id) && !isProtectedSeed(table, r));
}

// Moosies are awarded per completed_items INSERT (trigger_add_moosies: + user_configurations.moosi_to_add) and
// never taken back on delete, so after a reset they are recomputed from the completions that remain.
export function moosiesAfterReset(remainingCompletions: number, moosiToAdd: number | null): number | null {
  if (moosiToAdd === null || !Number.isFinite(moosiToAdd)) return null;   // no config → leave moosies alone
  return remainingCompletions * moosiToAdd;
}
