// Interpreting create_lessons_with_segments' result.
//
// Migration 062 made the RPC IDEMPOTENT per (track_id, lesson_name): a proposal whose name
// is already live in that track is no longer inserted a second time. The RPC still returns
// one row per proposal — the EXISTING row in that case, so a caller always has an id and
// never holds a dangling reference — and flags which is which via `created`.
//
// VERSION SKEW IS THE WHOLE POINT OF THIS MODULE. This backend auto-deploys on push, but
// the migration is applied by hand in the Supabase editor afterwards. So for some window
// the new code runs against the OLD RPC, whose rows have no `created` field at all. A
// missing flag therefore means "created": under the pre-062 RPC every returned row WAS an
// insert, so that reading is exactly right, and the counts stay correct in both worlds.

export type LessonCreateRow = {
  id: string;
  lesson_name: string | null;
  description: string | null;
  created?: boolean; // migration 062; ABSENT when running against the pre-062 RPC
};

export type LessonCreateSummary = {
  rows: LessonCreateRow[];
  created: LessonCreateRow[];
  reused: LessonCreateRow[];
  createdCount: number;
  reusedCount: number;
  ids: string[]; // every id, created and reused alike — what callers reference
};

// A row is CREATED unless the RPC explicitly says otherwise (see the version-skew note).
export function isCreatedRow(row: LessonCreateRow): boolean {
  return row.created !== false;
}

export function summarizeLessonCreate(
  rows: LessonCreateRow[] | null | undefined
): LessonCreateSummary {
  const all = rows ?? [];
  const created = all.filter(isCreatedRow);
  const reused = all.filter((r) => !isCreatedRow(r));
  return {
    rows: all,
    created,
    reused,
    createdCount: created.length,
    reusedCount: reused.length,
    ids: all.map((r) => r.id),
  };
}
