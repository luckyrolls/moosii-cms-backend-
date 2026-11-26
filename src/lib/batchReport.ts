// ---------------------------------------------------------------------------
// Slice A2 — the per-lesson run report and plan preview, assembled from what the planner
// and the executor already know. PURE: no DB, no I/O, so both batches and the preview
// route share one shape and the CMS gets one renderer.
//
// Nothing new is stored. Every number here comes from the plan (planned / skipped + reason),
// the executor's outcomes (done / failed / errors) or a post-run read of
// ai_generation_log + content_images by the batch's correlation id (tokens / images). That is
// the whole reason there is no per-unit state table (CLAUDE.md: jobs are WHOLE-UNIT).
// ---------------------------------------------------------------------------

import { SKIP_REASONS, type SkipReason } from "./approvalSafety";

export type UnitKind = "content" | "quiz" | "image";

/** A unit the plan WILL run. `ref` is the same string the executor reports as current_unit. */
export type PlannedUnit = { kind: UnitKind; ref: string; lesson_id: string | null };

/** A unit the plan refuses, with the reason the CMS shows. */
export type SkippedUnit = {
  kind: UnitKind;
  ref: string;
  lesson_id: string | null;
  reason: SkipReason;
};

/** The lesson facts the report prints; all of them already loaded by the planner. */
export type LessonRow = {
  lesson_id: string;
  lesson_name: string | null;
  kind: "lesson" | "activity";
  is_published: boolean;
  archived: boolean;
};

export type UnitOutcome = "done" | "failed";

export type PerLesson = {
  lesson_id: string | null;        // null = the orphan bucket (segments with no lesson)
  lesson_name: string | null;
  kind: "lesson" | "activity" | null;
  is_published: boolean | null;
  archived: boolean | null;
  planned: number;
  /** The same total, split by unit kind — what the preview shows per lesson. */
  planned_by_kind: Record<UnitKind, number>;
  done: number;
  failed: number;
  /** Only the reasons that actually fired, so a row stays readable. {} when none. */
  skipped: Partial<Record<SkipReason, number>>;
  skipped_total: number;
  errors: { unit: string; message: string }[];
  /** Content batch: tokens attributed to this lesson. null until the post-run pass fills it. */
  tokens: number | null;
  /** Image batch: AI calls attributed to this lesson. null on the content batch. */
  image_calls: number | null;
  /** Slice B (automatic AI review) fills this. Always null here, by design. */
  findings_count: null;
};

const emptyRow = (l: LessonRow | null, lesson_id: string | null): PerLesson => ({
  lesson_id: l ? l.lesson_id : lesson_id,
  lesson_name: l?.lesson_name ?? null,
  kind: l?.kind ?? null,
  is_published: l?.is_published ?? null,
  archived: l?.archived ?? null,
  planned: 0,
  planned_by_kind: { content: 0, quiz: 0, image: 0 },
  done: 0,
  failed: 0,
  skipped: {},
  skipped_total: 0,
  errors: [],
  tokens: null,
  image_calls: null,
  findings_count: null,
});

/**
 * One row per lesson that the plan touched OR refused, plus an orphan row when a unit has no
 * lesson. Lessons the plan never looked at are absent — a preview of 29 eligible lessons in a
 * 156-lesson project must not print 156 rows.
 *
 * `outcomes` is keyed by the unit's `ref`, exactly as the executor records it, so a unit that
 * never ran counts as neither done nor failed (a killed batch reports honestly).
 */
export function buildPerLesson(input: {
  lessons: LessonRow[];
  planned: PlannedUnit[];
  skipped: SkippedUnit[];
  outcomes?: Map<string, UnitOutcome>;
  errors?: { unit: string; message: string }[];
}): PerLesson[] {
  const { lessons, planned, skipped, outcomes, errors } = input;
  const byId = new Map(lessons.map((l) => [l.lesson_id, l]));
  const rows = new Map<string, PerLesson>();
  const ORPHAN = "\u0000orphan";

  const row = (lesson_id: string | null): PerLesson => {
    const key = lesson_id ?? ORPHAN;
    let r = rows.get(key);
    if (!r) {
      r = emptyRow(byId.get(lesson_id ?? "") ?? null, lesson_id);
      rows.set(key, r);
    }
    return r;
  };

  for (const u of planned) {
    const r = row(u.lesson_id);
    r.planned++;
    r.planned_by_kind[u.kind]++;
    const o = outcomes?.get(u.ref);
    if (o === "done") r.done++;
    else if (o === "failed") r.failed++;
  }

  for (const s of skipped) {
    const r = row(s.lesson_id);
    r.skipped[s.reason] = (r.skipped[s.reason] ?? 0) + 1;
    r.skipped_total++;
  }

  // Errors carry the unit ref; map it back to its lesson through the plan.
  const lessonOfRef = new Map(planned.map((u) => [u.ref, u.lesson_id]));
  for (const e of errors ?? []) {
    row(lessonOfRef.get(e.unit) ?? null).errors.push(e);
  }

  // Published first, then by name: the rows a human must look at hardest come first.
  return [...rows.values()].sort((a, b) => {
    if (a.lesson_id === null) return 1;
    if (b.lesson_id === null) return -1;
    if (a.is_published !== b.is_published) return a.is_published ? -1 : 1;
    return (a.lesson_name ?? "").localeCompare(b.lesson_name ?? "");
  });
}

/** Attach per-lesson token totals (content batch) in place. */
export function attachTokens(rows: PerLesson[], tokensByLesson: Map<string, number>): void {
  for (const r of rows) {
    if (r.lesson_id === null) continue;
    r.tokens = tokensByLesson.get(r.lesson_id) ?? 0;
  }
}

/** Attach per-lesson AI-call counts (image batch) in place. */
export function attachImageCalls(rows: PerLesson[], callsByLesson: Map<string, number>): void {
  for (const r of rows) {
    if (r.lesson_id === null) continue;
    r.image_calls = callsByLesson.get(r.lesson_id) ?? 0;
  }
}

/** Totals across the per-lesson rows, so a CMS header needs no second pass. */
export function tallyPerLesson(rows: PerLesson[]): {
  lessons: number;
  planned: number;
  planned_by_kind: Record<UnitKind, number>;
  done: number;
  failed: number;
  skipped: Record<SkipReason, number>;
  skipped_total: number;
} {
  const skipped = Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as Record<SkipReason, number>;
  const planned_by_kind: Record<UnitKind, number> = { content: 0, quiz: 0, image: 0 };
  let planned = 0, done = 0, failed = 0, skipped_total = 0;
  for (const r of rows) {
    planned += r.planned;
    planned_by_kind.content += r.planned_by_kind.content;
    planned_by_kind.quiz += r.planned_by_kind.quiz;
    planned_by_kind.image += r.planned_by_kind.image;
    done += r.done;
    failed += r.failed;
    skipped_total += r.skipped_total;
    for (const k of SKIP_REASONS) skipped[k] += r.skipped[k] ?? 0;
  }
  return { lessons: rows.length, planned, planned_by_kind, done, failed, skipped, skipped_total };
}
