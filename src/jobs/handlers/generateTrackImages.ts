import { supabase } from "../../supabase";
import type { Job } from "../registry";
import { generateSubSegmentImage } from "./generateSubSegmentImage";
import {
  imageSkipReason,
  lessonGateFor,
  tallySkips,
  type LessonGate,
  type SkipReason,
  type TrackGate,
} from "../../lib/approvalSafety";
import {
  buildPerLesson,
  attachImageCalls,
  type LessonRow,
  type PerLesson,
  type PlannedUnit,
  type SkippedUnit,
  type UnitOutcome,
} from "../../lib/batchReport";
import { lessonImageCallsForRun } from "../../lib/batchUsage";

// ---------------------------------------------------------------------------
// generate_track_images — FILL-MISSING fan-out over the single-unit image job.
// Sibling of generate_track_content (same orchestration), but simpler: fill only,
// NO replace mode. Image regeneration stays per-image (the rejection/regen flow);
// this batch only creates images that don't exist yet.
//
// A "slot" = a sub_segment (images attach to sub_segments). Per slot:
//   has_image  = a content_images row with status IN ('candidate','approved') — the
//                existing image-batch 'gaps' definition (reuse; rejected/superseded do
//                NOT count as present, they are gaps to fill). ANY present image → skip.
//   has_content = the parent SEGMENT has ≥1 non-empty sub_segment (content PRESENT,
//                approval NOT required — same predicate as the content batch's has-it;
//                images generate against pending content).
// Plan = slots with NO image AND content present. Slots with no image and NO content
// are NOT planned and counted skipped_no_content — the first-class "run/fix content
// generation first" signal.
//
// SURVIVAL: fill-missing is fully derivable (image-exists is the state) — a killed
// batch is finished by re-firing; re-plan skips created images. No replace hole here.
// Concurrency: the existing image-batch knob (BATCH_CONCURRENCY, default 2); images are
// the most expensive unit — keep the posture, don't raise. Provenance: every unit runs
// with correlationId = parent job.id (whole run = one query; content_images.job_id too).
// ---------------------------------------------------------------------------

type Input = {
  track_id: string;
  // SLICE A2 (Mark, 2026-11-25): images do NOT require editorial approval. Opt in to the
  // stricter sweep and a lesson with any card still awaiting editorial is excluded whole,
  // reported as `not_editorially_approved`.
  only_editorially_approved?: boolean;
};
export type ImageUnit = { sub_segment_id: string; ref: string; lesson_id: string };

export type BatchResult = {
  status: "running" | "succeeded" | "completed_with_errors";
  total: number;
  done: number;
  failed: number;
  skipped_no_content: number;
  // SLICE A1 — every skip, named (published / archived / no_content). `skipped_no_content`
  // keeps its old meaning and is the same number as skipped_by_reason.no_content.
  skipped_by_reason: Record<SkipReason, number>;
  current_unit: string | null;
  errors: { unit: string; message: string }[];
  // SLICE A2 — the per-lesson report (ADDITIVE; every field above keeps its meaning).
  // `image_calls` is filled after the run; `tokens` stays null on this batch because the
  // prompt-writer call logs no entity, so only the run total can be honest about tokens.
  per_lesson: PerLesson[];
  usage: {
    ai_calls: number;
    tokens_in: number;
    tokens_out: number;
    tokens_total: number;
    unattributed_calls: number;
  } | null;
  images_created: number | null;
};

const CONCURRENCY = parseInt(process.env.BATCH_CONCURRENCY ?? "2", 10);

// Pure enumeration from the content/image tables (the resume checkpoint). Exported so
// proofs can assert the plan without generating images.
export type ImagePlan = {
  plan: ImageUnit[];
  skipped_no_content: number;
  skipped_by_reason: Record<SkipReason, number>;
  lessons: LessonRow[];
  skipped: SkippedUnit[];
  // SLICE A2 — the CMS's confirm-dialog warning: "N of M lessons have cards still awaiting
  // editorial". M counts the lessons this batch would otherwise consider (not published, not
  // archived) — the only denominator the warning can act on.
  editorial: { lessons_eligible: number; lessons_without_editorial_approval: number };
};

export async function planTrackImages(
  track_id: string,
  opts: { onlyEditoriallyApproved?: boolean } = {}
): Promise<ImagePlan> {
  const empty: ImagePlan = {
    plan: [], skipped_no_content: 0, skipped_by_reason: tallySkips([]),
    lessons: [], skipped: [],
    editorial: { lessons_eligible: 0, lessons_without_editorial_approval: 0 },
  };

  // The track's own archival (invariant 6 — archival is DERIVED, so an archived track
  // archives every lesson under it) — but only a HUMAN archival excludes it from a batch. A
  // mode-hidden track (mode_archived, 128) is another mode's catalog and stays eligible:
  // trackExcludedFromBatch, applied by lessonGateFor.
  const { data: track, error: tErr } = await supabase
    .from("tracks").select("archived_at, mode_archived, test_group").eq("id", track_id).maybeSingle();
  if (tErr) throw new Error(`Failed to load track ${track_id}: ${tErr.message}`);
  const trackGate: TrackGate = {
    archived_at: track?.archived_at ?? null,
    mode_archived: track?.mode_archived ?? null,
    test_group: track?.test_group ?? null,
  };

  // tracks <- lessons <- segments <- sub_segments. SLICE A1: carry the lesson gate down, so a
  // batch never adds pictures to a PUBLISHED or ARCHIVED lesson.
  const { data: lessons, error: lErr } = await supabase
    .from("lessons").select("id, lesson_name, is_published, archived_at, kind").eq("track_id", track_id);
  if (lErr) throw new Error(`Failed to load lessons for track ${track_id}: ${lErr.message}`);
  const lessonList = lessons ?? [];
  if (lessonList.length === 0) return empty;

  // EDITORIAL STATE, from the same view the CMS reads (lessons_review_status, migration 065),
  // so "awaiting editorial" means exactly what the reviewer sees. Loaded ALWAYS, not only when
  // the flag is set, because the preview reports the N-of-M warning either way.
  const { data: review, error: rErr } = await supabase
    .from("lessons_review_status")
    .select("lesson_id, cards_total, cards_awaiting_editorial")
    .in("lesson_id", lessonList.map((l) => l.id));
  if (rErr) throw new Error(`Failed to load review status for track ${track_id}: ${rErr.message}`);
  const reviewOf = new Map<string, { cards_total: number; cards_awaiting_editorial: number }>();
  for (const r of review ?? []) {
    if (!r.lesson_id) continue;
    reviewOf.set(r.lesson_id, {
      cards_total: r.cards_total ?? 0,
      cards_awaiting_editorial: r.cards_awaiting_editorial ?? 0,
    });
  }

  const lessonGate = new Map<string, LessonGate>();
  const lessonRows: LessonRow[] = [];
  let lessonsEligible = 0;
  let lessonsWithoutEditorial = 0;
  for (const l of lessonList) {
    const gate = lessonGateFor(l, trackGate, reviewOf.get(l.id) ?? null);
    lessonGate.set(l.id, gate);
    lessonRows.push({
      lesson_id: l.id,
      lesson_name: l.lesson_name ?? null,
      kind: gate.kind,
      is_published: gate.published,
      archived: gate.archived,
    });
    if (!gate.published && !gate.archived) {
      lessonsEligible++;
      if (!gate.editorially_approved) lessonsWithoutEditorial++;
    }
  }
  const editorial = {
    lessons_eligible: lessonsEligible,
    lessons_without_editorial_approval: lessonsWithoutEditorial,
  };
  const lessonIds = [...lessonGate.keys()];

  const { data: segs, error: sErr } = await supabase
    .from("segments").select("id, lesson_id").in("lesson_id", lessonIds);
  if (sErr) throw new Error(`Failed to load segments for track ${track_id}: ${sErr.message}`);
  const segLesson = new Map<string, string>();
  for (const s of segs ?? []) if (s.lesson_id) segLesson.set(s.id, s.lesson_id);
  const segIds = [...segLesson.keys()];
  if (segIds.length === 0) return { ...empty, lessons: lessonRows, editorial };

  const { data: subs, error: ssErr } = await supabase
    .from("sub_segments").select("id, seg_id, content").in("seg_id", segIds);
  if (ssErr) throw new Error(`Failed to load sub_segments for track ${track_id}: ${ssErr.message}`);
  const subSegs = (subs ?? []).filter((r) => r.id && r.seg_id) as { id: string; seg_id: string; content: string | null }[];
  if (subSegs.length === 0) return { ...empty, lessons: lessonRows, editorial };

  // Segment-level content presence (>=1 non-empty card in the segment).
  const segHasContent = new Set<string>();
  for (const r of subSegs) if (r.content && r.content.trim()) segHasContent.add(r.seg_id);

  // Present images (reuse the 'gaps' definition: candidate|approved).
  const imaged = new Set<string>();
  const { data: imgs } = await supabase
    .from("content_images")
    .select("sub_segment_id")
    .in("sub_segment_id", subSegs.map((s) => s.id))
    .in("status", ["candidate", "approved"]);
  for (const r of imgs ?? []) if (r.sub_segment_id) imaged.add(r.sub_segment_id);

  const OPEN: LessonGate = {
    published: false, archived: false, kind: "lesson", editorially_approved: false,
  };
  const plan: ImageUnit[] = [];
  const reasons: (SkipReason | null)[] = [];
  const skippedUnits: SkippedUnit[] = [];
  for (const ss of subSegs) {
    const lessonId = segLesson.get(ss.seg_id) ?? null;
    const ref = `image:${ss.id}`;
    const d = imageSkipReason(
      {
        sub_segment_id: ss.id,
        lesson: (lessonId && lessonGate.get(lessonId)) || OPEN,
        has_image: imaged.has(ss.id),
        segment_has_content: segHasContent.has(ss.seg_id),
      },
      { onlyEditoriallyApproved: opts.onlyEditoriallyApproved === true }
    );
    if (d.plan && lessonId) plan.push({ sub_segment_id: ss.id, ref, lesson_id: lessonId });
    reasons.push(d.skip);
    if (d.skip) skippedUnits.push({ kind: "image", ref, lesson_id: lessonId, reason: d.skip });
  }
  const skipped_by_reason = tallySkips(reasons);
  return {
    plan,
    skipped_no_content: skipped_by_reason.no_content,
    skipped_by_reason,
    lessons: lessonRows,
    skipped: skippedUnits,
    editorial,
  };
}

export type ImageRunUnit = (unit: ImageUnit, correlationId: string) => Promise<void>;

const realRunUnit: ImageRunUnit = async (unit, correlationId) => {
  // correlationId = the batch job.id; also the content_images.job_id (CMS join).
  await generateSubSegmentImage({ sub_segment_id: unit.sub_segment_id }, { correlationId, jobId: correlationId });
};

// Bounded-concurrency execution with live progress into jobs.result. One unit failing
// is recorded, never fatal. runUnit is injectable so proofs drive orchestration without
// generating images.
export async function executeTrackImages(
  jobId: string, planned: ImagePlan,
  runUnit: ImageRunUnit = realRunUnit
): Promise<BatchResult> {
  const plan = planned.plan;
  const outcomes = new Map<string, UnitOutcome>();
  const plannedUnits: PlannedUnit[] = plan.map((u) => ({
    kind: "image", ref: u.ref, lesson_id: u.lesson_id,
  }));
  const result: BatchResult = {
    status: "running", total: plan.length, done: 0, failed: 0,
    skipped_no_content: planned.skipped_no_content,
    skipped_by_reason: planned.skipped_by_reason,
    current_unit: null, errors: [],
    per_lesson: [], usage: null, images_created: null,
  };
  const rebuildPerLesson = () => {
    result.per_lesson = buildPerLesson({
      lessons: planned.lessons,
      planned: plannedUnits,
      skipped: planned.skipped,
      outcomes,
      errors: result.errors,
    });
  };
  rebuildPerLesson();
  const writeProgress = async () => {
    await supabase.from("jobs").update({ result: { ...result } as never }).eq("id", jobId);
  };
  await writeProgress();

  const queue = [...plan];
  const worker = async () => {
    for (;;) {
      const unit = queue.shift();
      if (!unit) return;
      result.current_unit = unit.ref;
      await writeProgress();
      try {
        await runUnit(unit, jobId);
        result.done++;
        outcomes.set(unit.ref, "done");
      } catch (e) {
        result.failed++;
        outcomes.set(unit.ref, "failed");
        result.errors.push({ unit: unit.ref, message: e instanceof Error ? e.message : String(e) });
      }
      rebuildPerLesson();
      await writeProgress();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plan.length) }, worker));

  result.current_unit = null;
  result.status = result.failed > 0 ? "completed_with_errors" : "succeeded";

  // SLICE A2 — the cost, from content_images.job_id + ai_generation_log.correlation_id. Per
  // lesson this reports CALLS, not tokens: the prompt-writer half of each slot logs no entity
  // (an intermediate call), so only `usage` below can be honest about tokens.
  const cardToLesson = new Map(planned.plan.map((u) => [u.sub_segment_id, u.lesson_id]));
  const { byLesson, usage, imagesCreated } = await lessonImageCallsForRun(jobId, cardToLesson);
  rebuildPerLesson();
  attachImageCalls(result.per_lesson, byLesson);
  result.usage = usage;
  result.images_created = imagesCreated;

  await writeProgress();
  return result;
}

export async function generateTrackImagesHandler(job: Job): Promise<unknown> {
  const { track_id, only_editorially_approved } = job.input as Input;
  if (!track_id) throw new Error("input.track_id is required");
  if (only_editorially_approved !== undefined && typeof only_editorially_approved !== "boolean") {
    throw new Error("input.only_editorially_approved must be a boolean");
  }
  const planned = await planTrackImages(track_id, {
    onlyEditoriallyApproved: only_editorially_approved === true,
  });
  return executeTrackImages(job.id, planned);
}
